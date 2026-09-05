import variant from "@jitl/quickjs-ng-wasmfile-release-sync";
import { loadQuickJs } from "@sebastianwessel/quickjs";

import {
    parseAnalysisRequest,
    type AnalysisBindingValue,
    type NormalizedAnalysisRequest,
} from "../../_shared/sandbox-runtime/analysis-protocol.ts";

export interface AnalysisWorkerResult {
    output: string;
    stderr: string;
}

const quickJsModule = loadQuickJs(variant);

function serializeWithinBudget(value: unknown, byteBudget: number): string {
    if (typeof value === "string") {
        if (Buffer.byteLength(value, "utf8") > byteBudget) {
            throw new Error("Analysis output exceeds byte budget");
        }
        return value;
    }
    if (value === undefined) return "";
    const chunks: string[] = [];
    let bytes = 0;
    const seen = new WeakSet<object>();
    const append = (chunk: string): void => {
        bytes += Buffer.byteLength(chunk, "utf8");
        if (bytes > byteBudget) {
            throw new Error("Analysis output exceeds byte budget");
        }
        chunks.push(chunk);
    };
    const visit = (item: unknown): void => {
        if (item === null || typeof item !== "object") {
            append(JSON.stringify(item) ?? `"[unserializable ${typeof item}]"`);
            return;
        }
        if (seen.has(item)) throw new TypeError("Circular analysis result");
        seen.add(item);
        if (Array.isArray(item)) {
            append("[");
            item.forEach((entry, index) => {
                if (index > 0) append(",");
                visit(entry);
            });
            append("]");
        } else {
            append("{");
            Object.entries(item).forEach(([key, entry], index) => {
                if (index > 0) append(",");
                append(JSON.stringify(key));
                append(":");
                visit(entry);
            });
            append("}");
        }
        seen.delete(item);
    };
    visit(value);
    return chunks.join("");
}

function bindingSetup(
    bindings: Readonly<Record<string, AnalysisBindingValue>>,
): string {
    const declarations = Object.keys(bindings).map(
        (name) =>
            `Object.defineProperty(globalThis, ${JSON.stringify(name)}, { value: __freezeBinding(env[${JSON.stringify(name)}]), writable: false, configurable: false });`,
    );
    return [
        "(() => {",
        "delete globalThis['process'];",
        "delete globalThis['fetch'];",
        "const __freezeBinding = (value, seen = new Set()) => {",
        "  if (value === null || typeof value !== 'object' || seen.has(value)) return value;",
        "  seen.add(value);",
        "  for (const key of Object.keys(value)) __freezeBinding(value[key], seen);",
        "  return Object.freeze(value);",
        "};",
        ...declarations,
        "Object.freeze(env);",
        "delete globalThis['env'];",
        "})();",
    ].join("\n");
}

export async function runQuickJsAnalysis(
    request: NormalizedAnalysisRequest,
): Promise<AnalysisWorkerResult> {
    if (request.worker !== "quickjs") {
        throw new Error(`QuickJS cannot execute ${request.worker} requests`);
    }
    const stdout: string[] = [];
    const stderr: string[] = [];
    let outputBytes = 0;
    const appendOutput = (target: string[], text: string): void => {
        const separatorBytes = target.length > 0 ? 1 : 0;
        outputBytes += separatorBytes + Buffer.byteLength(text, "utf8");
        if (outputBytes > request.limits.outputBytes) {
            throw new Error(
                `Analysis output exceeds ${request.limits.outputBytes} bytes`,
            );
        }
        target.push(text);
    };
    const appendConsole = (
        target: string[],
        values: readonly unknown[],
    ): void => {
        const separatorBytes = target.length > 0 ? 1 : 0;
        let remaining =
            request.limits.outputBytes - outputBytes - separatorBytes;
        const pieces: string[] = [];
        try {
            values.forEach((value, index) => {
                if (index > 0) remaining -= 1;
                const piece = serializeWithinBudget(value, remaining);
                remaining -= Buffer.byteLength(piece, "utf8");
                pieces.push(piece);
            });
        } catch (error) {
            if (
                error instanceof Error &&
                error.message === "Analysis output exceeds byte budget"
            ) {
                throw new Error(
                    `Analysis output exceeds ${request.limits.outputBytes} bytes`,
                );
            }
            throw error;
        }
        appendOutput(target, pieces.join(" "));
    };
    const { runSandboxed } = await quickJsModule;
    const result = await runSandboxed(
        async ({ evalCode }) => {
            const setup = await evalCode(bindingSetup(request.bindings));
            if (!setup.ok) return setup;
            return await evalCode(request.program);
        },
        {
            allowFetch: false,
            allowFs: false,
            env: request.bindings,
            executionTimeout: request.limits.wallTimeMs,
            memoryLimit: request.limits.memoryBytes,
            maxIntervalCount: 0,
            maxTimeoutCount: 0,
            transformTypescript: request.language === "typescript",
            console: {
                log: (message, ...optional) => {
                    appendConsole(stdout, [message, ...optional]);
                },
                info: (message, ...optional) => {
                    appendConsole(stdout, [message, ...optional]);
                },
                warn: (message, ...optional) => {
                    appendConsole(stderr, [message, ...optional]);
                },
                error: (message, ...optional) => {
                    appendConsole(stderr, [message, ...optional]);
                },
            },
        },
    );
    if (!result.ok) {
        throw new Error(`${result.error.name}: ${result.error.message}`);
    }

    const separatorBytes = stdout.length > 0 ? 1 : 0;
    let returned: string;
    try {
        returned = serializeWithinBudget(
            result.data,
            request.limits.outputBytes - outputBytes - separatorBytes,
        );
    } catch (error) {
        if (
            error instanceof Error &&
            error.message === "Analysis output exceeds byte budget"
        ) {
            throw new Error(
                `Analysis output exceeds ${request.limits.outputBytes} bytes`,
            );
        }
        throw error;
    }
    if (returned) appendOutput(stdout, returned);
    const output = stdout.join("\n");
    return { output, stderr: stderr.join("\n") };
}

async function readStdin(): Promise<string> {
    return new Response(Bun.stdin.stream()).text();
}

if (import.meta.main) {
    try {
        const raw: unknown = JSON.parse(await readStdin());
        const request = parseAnalysisRequest(raw);
        const result = await runQuickJsAnalysis(request);
        process.stdout.write(JSON.stringify({ ok: true, result }));
    } catch (error) {
        process.stdout.write(
            JSON.stringify({
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            }),
        );
        process.exitCode = 1;
    }
}
