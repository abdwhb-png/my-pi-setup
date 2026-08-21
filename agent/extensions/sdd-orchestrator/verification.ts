import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import type { VerifyCommand } from "./types.ts";

export const DEFAULT_VERIFY_TIMEOUT_MS = 600_000;
/** Maximum retained raw preview size, measured in bytes. */
export const MAX_VERIFY_OUTPUT_BYTES = 16_384;
/** @deprecated Use `MAX_VERIFY_OUTPUT_BYTES`; kept for test/API compatibility. */
export const MAX_VERIFY_OUTPUT_CHARS = MAX_VERIFY_OUTPUT_BYTES;

export interface VerificationRunInput {
    readonly command: VerifyCommand;
    readonly cwd: string;
    readonly timeoutMs: number;
    readonly signal: AbortSignal;
}

export interface VerificationRunResult {
    readonly status: "completed" | "failed" | "timed_out" | "signaled";
    readonly exitCode: number | null;
    /**
     * A completed runner result never carries a process signal. Signal names
     * remain an implementation detail: callers only need the `signaled`
     * outcome and must reject any other runtime shape.
     */
    readonly signal?: null;
    /** Bounded raw preview only; it is redacted before durable persistence. */
    readonly output: string;
    /** SHA-256 of every stdout/stderr byte, in Node data-event order. */
    readonly outputSha256: string;
    /** Total stdout/stderr bytes received, including bytes outside `output`. */
    readonly outputBytes: number;
    readonly truncated: boolean;
}

export interface VerificationRunner {
    run(input: VerificationRunInput): Promise<VerificationRunResult>;
}

function utf8Preview(bytes: Buffer): string {
    let end = bytes.length;
    let continuationBytes = 0;
    while (
        continuationBytes < 3 &&
        end - continuationBytes - 1 >= 0 &&
        (bytes[end - continuationBytes - 1] & 0xc0) === 0x80
    ) {
        continuationBytes += 1;
    }
    const sequenceStart = end - continuationBytes - 1;
    if (sequenceStart >= 0) {
        const firstByte = bytes[sequenceStart];
        const expectedLength =
            firstByte >= 0xc2 && firstByte <= 0xdf
                ? 2
                : firstByte >= 0xe0 && firstByte <= 0xef
                  ? 3
                  : firstByte >= 0xf0 && firstByte <= 0xf4
                    ? 4
                    : 1;
        if (expectedLength > continuationBytes + 1) end = sequenceStart;
    }
    let preview = bytes.subarray(0, end).toString("utf8");
    // Invalid input bytes are represented by U+FFFD when decoded. Trim by
    // encoded byte size as a final safety net, without retaining more input.
    while (Buffer.byteLength(preview) > MAX_VERIFY_OUTPUT_BYTES) {
        preview = preview.slice(0, -1);
    }
    return preview;
}

class VerificationOutputAccumulator {
    private readonly previewChunks: Buffer[] = [];
    private previewBytes = 0;
    private outputBytes = 0;
    private readonly hash = createHash("sha256");
    private outputSha256: string | undefined;

    append(chunk: string | Buffer): void {
        const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
        this.hash.update(bytes);
        this.outputBytes += bytes.length;
        const remaining = MAX_VERIFY_OUTPUT_BYTES - this.previewBytes;
        if (remaining <= 0) return;
        const preview = bytes.subarray(0, remaining);
        this.previewChunks.push(preview);
        this.previewBytes += preview.length;
    }

    result(): Pick<
        VerificationRunResult,
        "output" | "outputSha256" | "outputBytes" | "truncated"
    > {
        this.outputSha256 ??= this.hash.digest("hex");
        return {
            output: utf8Preview(Buffer.concat(this.previewChunks)),
            outputSha256: this.outputSha256,
            outputBytes: this.outputBytes,
            truncated: this.outputBytes > MAX_VERIFY_OUTPUT_BYTES,
        };
    }
}

/**
 * Executes the already-approved manifest command verbatim through the platform
 * shell. The command is deliberately not re-tokenized or interpolated here.
 */
export class ChildProcessVerificationRunner implements VerificationRunner {
    async run(input: VerificationRunInput): Promise<VerificationRunResult> {
        if (input.signal.aborted) {
            const output = new VerificationOutputAccumulator();
            output.append("Verification cancelled before execution.");
            return {
                status: "signaled",
                exitCode: null,
                ...output.result(),
            };
        }
        return new Promise((resolve) => {
            const output = new VerificationOutputAccumulator();
            let timedOut = false;
            let aborted = false;
            let settled = false;
            let terminating = false;
            let escalationComplete = false;
            let timeout: Timer | undefined;
            let forceKill: Timer | undefined;
            let closedResult: VerificationRunResult | undefined;
            const finish = (result: VerificationRunResult) => {
                if (settled) return;
                settled = true;
                if (timeout) clearTimeout(timeout);
                if (forceKill) clearTimeout(forceKill);
                input.signal.removeEventListener("abort", onAbort);
                resolve(result);
            };
            const append = (chunk: string | Buffer) => output.append(chunk);
            let child: ChildProcess | undefined;
            const terminate = () => {
                if (terminating) return;
                terminating = true;
                const kill = (signal: NodeJS.Signals) => {
                    if (process.platform === "win32" && child?.pid) {
                        try {
                            spawn(
                                "taskkill",
                                ["/pid", String(child.pid), "/T", "/F"],
                                {
                                    stdio: "ignore",
                                    windowsHide: true,
                                },
                            ).once("error", () => child?.kill(signal));
                            return;
                        } catch {
                            child.kill(signal);
                            return;
                        }
                    }
                    if (child?.pid) {
                        try {
                            process.kill(-child.pid, signal);
                            return;
                        } catch {
                            // The process group may already have exited.
                        }
                    }
                    child?.kill(signal);
                };
                kill("SIGTERM");
                forceKill = setTimeout(() => {
                    // A shell can close while a descendant in its detached
                    // process group survives SIGTERM. Never cancel this
                    // escalation solely because the shell emitted close.
                    kill("SIGKILL");
                    escalationComplete = true;
                    forceKill = undefined;
                    if (closedResult) finish(closedResult);
                }, 1_000);
            };
            const onAbort = () => {
                aborted = true;
                terminate();
            };
            try {
                child = spawn(input.command.command, {
                    cwd: input.cwd,
                    shell: true,
                    detached: process.platform !== "win32",
                    stdio: ["ignore", "pipe", "pipe"],
                    windowsHide: true,
                });
            } catch (error) {
                output.append(
                    error instanceof Error ? error.message : String(error),
                );
                finish({
                    status: "failed",
                    exitCode: null,
                    ...output.result(),
                });
                return;
            }
            child.stdout?.on("data", append);
            child.stderr?.on("data", append);
            child.once("error", (error) => {
                append(error instanceof Error ? error.message : String(error));
                finish({
                    status: "failed",
                    exitCode: null,
                    ...output.result(),
                });
            });
            child.once("close", (exitCode, signal) => {
                const result = {
                    status: timedOut
                        ? "timed_out"
                        : aborted || signal
                          ? "signaled"
                          : exitCode === 0
                            ? "completed"
                            : "failed",
                    exitCode,
                    ...output.result(),
                } satisfies VerificationRunResult;
                if (terminating) {
                    closedResult = result;
                    if (escalationComplete) finish(result);
                    return;
                }
                finish(result);
            });
            input.signal.addEventListener("abort", onAbort, { once: true });
            timeout = setTimeout(() => {
                timedOut = true;
                terminate();
            }, input.timeoutMs);
        });
    }
}
