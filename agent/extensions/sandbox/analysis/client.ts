import { spawn } from "node:child_process";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
    ANALYSIS_MAX_CONCURRENCY,
    analysisHostResponseBudget,
    normalizeAnalysisRequest,
    parseAnalysisHostResponse,
    type AnalysisHostResponse,
    type AnalysisRequest,
    type AnalysisResult,
    type NormalizedAnalysisRequest,
} from "./protocol.ts";

export { analysisHostResponseBudget } from "./protocol.ts";

export type AnalysisHostRunner = (
    request: NormalizedAnalysisRequest,
    signal: AbortSignal,
) => Promise<AnalysisResult>;

export interface AnalysisSandboxService {
    run(
        request: AnalysisRequest,
        signal?: AbortSignal,
    ): Promise<AnalysisResult>;
    shutdown(): Promise<void>;
}

export interface PreflightAnalysisSandboxService extends AnalysisSandboxService {
    preflight(): Promise<void>;
}

interface QueuedRequest {
    request: NormalizedAnalysisRequest;
    externalSignal?: AbortSignal;
    resolve(result: AnalysisResult): void;
    reject(error: Error): void;
}

export interface AnalysisSandboxServiceOptions {
    runHost?: AnalysisHostRunner;
}

export function resolveAnalysisBunExecutable(): string {
    const execPath = process.execPath;
    const base = basename(execPath).toLowerCase();
    if (base === "bun" || base === "bun.exe") return execPath;
    const bunGlobal = globalThis as unknown as {
        Bun?: { which?: (bin: string) => string | null };
    };
    const which = bunGlobal.Bun?.which;
    if (typeof which === "function") {
        try {
            const found = which("bun");
            if (found) return found;
        } catch {
            // fall through to PATH fallback
        }
    }
    return "bun";
}

function killProcessTree(pid: number, signal: NodeJS.Signals): void {
    try {
        process.kill(-pid, signal);
    } catch {
        try {
            process.kill(pid, signal);
        } catch {
            // Process already exited.
        }
    }
}

function runAnalysisHostProcess(
    request: NormalizedAnalysisRequest,
    signal: AbortSignal,
): Promise<AnalysisResult> {
    if (signal.aborted) {
        return Promise.reject(new Error("Analysis request aborted"));
    }
    return new Promise((resolve, reject) => {
        const hostPath = fileURLToPath(new URL("./host.ts", import.meta.url));
        const child = spawn(resolveAnalysisBunExecutable(), [hostPath], {
            cwd: dirname(hostPath),
            env: {
                HOME: process.env.HOME,
                PATH: process.env.PATH,
            },
            detached: true,
            stdio: ["pipe", "pipe", "pipe"],
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        const maxResponseBytes = analysisHostResponseBudget(
            request.limits.outputBytes,
        );
        let capturedBytes = 0;
        let terminalError: Error | undefined;
        let settled = false;
        let hardKillTimer: ReturnType<typeof setTimeout> | undefined;
        const terminate = (error: Error): void => {
            if (terminalError) return;
            terminalError = error;
            if (child.pid) {
                killProcessTree(child.pid, "SIGTERM");
                hardKillTimer = setTimeout(
                    () => child.pid && killProcessTree(child.pid, "SIGKILL"),
                    500,
                );
                hardKillTimer.unref();
            }
        };
        const onAbort = () => terminate(new Error("Analysis request aborted"));
        const timer = setTimeout(
            () =>
                terminate(
                    new Error(
                        `Analysis host exceeded ${request.limits.wallTimeMs + 10_000}ms wall time`,
                    ),
                ),
            request.limits.wallTimeMs + 10_000,
        );
        timer.unref();
        signal.addEventListener("abort", onAbort, { once: true });
        const capture = (target: Buffer[], chunk: Buffer | string): void => {
            if (terminalError) return;
            const buffer =
                typeof chunk === "string" ? Buffer.from(chunk) : chunk;
            capturedBytes += buffer.byteLength;
            if (capturedBytes > maxResponseBytes) {
                terminate(
                    new Error(
                        `Analysis host output exceeds ${maxResponseBytes} bytes`,
                    ),
                );
                return;
            }
            target.push(buffer);
        };
        child.stdout?.on("data", (chunk) => capture(stdout, chunk));
        child.stderr?.on("data", (chunk) => capture(stderr, chunk));
        child.once("error", (error: Error) => {
            terminalError = error;
        });
        child.once("close", () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (hardKillTimer) clearTimeout(hardKillTimer);
            signal.removeEventListener("abort", onAbort);
            if (terminalError) {
                reject(terminalError);
                return;
            }
            const stderrText = Buffer.concat(stderr).toString("utf8");
            let response: AnalysisHostResponse;
            try {
                const raw: unknown = JSON.parse(
                    Buffer.concat(stdout).toString("utf8"),
                );
                response = parseAnalysisHostResponse(raw);
            } catch {
                reject(
                    new Error(
                        stderrText.trim() ||
                            "Analysis host returned invalid JSON",
                    ),
                );
                return;
            }
            if (!response.ok) {
                reject(new Error(response.error));
                return;
            }
            resolve(response.result);
        });
        if (child.stdin) {
            child.stdin.on("error", (error: Error) => terminate(error));
            child.stdin.end(JSON.stringify(request), "utf8");
        } else {
            terminate(new Error("Analysis host stdin is unavailable"));
        }
    });
}

export function createAnalysisSandboxService(
    options: AnalysisSandboxServiceOptions = {},
): PreflightAnalysisSandboxService {
    const runHost = options.runHost ?? runAnalysisHostProcess;
    const queue: QueuedRequest[] = [];
    const activeControllers = new Set<AbortController>();
    const activeRuns = new Set<Promise<void>>();
    let active = 0;
    let closed = false;
    let preflightPromise: Promise<void> | undefined;
    let shutdownPromise: Promise<void> | undefined;

    const pump = (): void => {
        while (!closed && active < ANALYSIS_MAX_CONCURRENCY) {
            const queued = queue.shift();
            if (!queued) return;
            if (queued.externalSignal?.aborted) {
                queued.reject(new Error("Analysis request aborted"));
                continue;
            }

            const controller = new AbortController();
            const abort = () => controller.abort();
            queued.externalSignal?.addEventListener("abort", abort, {
                once: true,
            });
            active += 1;
            activeControllers.add(controller);
            const activeRun = Promise.resolve()
                .then(() => runHost(queued.request, controller.signal))
                .then(
                    (result) => queued.resolve(result),
                    (error: unknown) => {
                        queued.reject(
                            error instanceof Error
                                ? error
                                : new Error(String(error)),
                        );
                    },
                )
                .finally(() => {
                    queued.externalSignal?.removeEventListener("abort", abort);
                    activeControllers.delete(controller);
                    active -= 1;
                    activeRuns.delete(activeRun);
                    pump();
                });
            activeRuns.add(activeRun);
            void activeRun;
        }
    };

    const service: PreflightAnalysisSandboxService = {
        run(request, signal) {
            if (closed) {
                return Promise.reject(
                    new Error("Analysis sandbox service is shut down"),
                );
            }
            const normalized = normalizeAnalysisRequest(request);
            return new Promise<AnalysisResult>((resolve, reject) => {
                queue.push({
                    request: normalized,
                    externalSignal: signal,
                    resolve,
                    reject,
                });
                pump();
            });
        },
        preflight() {
            if (closed) {
                return Promise.reject(
                    new Error("Analysis sandbox service is shut down"),
                );
            }
            preflightPromise ??= Promise.all([
                service.run({
                    id: "sandbox-preflight-typescript",
                    language: "typescript",
                    program: "export default 1 as const",
                }),
                service.run({
                    id: "sandbox-preflight-python",
                    language: "python",
                    program: "result = 1",
                }),
            ]).then(() => undefined);
            return preflightPromise;
        },
        shutdown() {
            shutdownPromise ??= (async () => {
                closed = true;
                for (const queued of queue.splice(0)) {
                    queued.reject(
                        new Error("Analysis sandbox service is shut down"),
                    );
                }
                for (const controller of activeControllers) controller.abort();
                await Promise.allSettled(activeRuns);
            })();
            return shutdownPromise;
        },
    };
    return service;
}
