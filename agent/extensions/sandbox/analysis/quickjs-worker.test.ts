/// <reference types="bun" />

import { describe, expect, it } from "bun:test";

import { normalizeAnalysisRequest } from "./protocol.ts";
import { runQuickJsAnalysis } from "./quickjs-worker.ts";

describe("QuickJS analysis worker", () => {
    it("executes JavaScript and TypeScript with explicit bindings", async () => {
        const javascript = await runQuickJsAnalysis(
            normalizeAnalysisRequest({
                id: "js-1",
                language: "javascript",
                program: "export default INPUT.length",
                bindings: { INPUT: "abcdef" },
            }),
        );
        const typescript = await runQuickJsAnalysis(
            normalizeAnalysisRequest({
                id: "ts-1",
                language: "typescript",
                program:
                    "const value: number = Number(INPUT) * 2; export default value",
                bindings: { INPUT: "21" },
            }),
        );

        expect(javascript.output).toBe("6");
        expect(typescript.output).toBe("42");
    });

    it("does not expose host runtimes, fetch, or filesystem modules", async () => {
        const globals = await runQuickJsAnalysis(
            normalizeAnalysisRequest({
                id: "js-globals",
                language: "javascript",
                program:
                    "export default [typeof process, typeof Bun, typeof Deno, typeof fetch].join(',')",
            }),
        );
        const filesystem = await runQuickJsAnalysis(
            normalizeAnalysisRequest({
                id: "js-fs",
                language: "javascript",
                program:
                    "export default await import('node:fs').then((fs) => { try { fs.readFileSync('/etc/passwd', 'utf8'); return 'exposed'; } catch { return 'blocked'; } }, () => 'blocked')",
            }),
        );

        const childProcess = await runQuickJsAnalysis(
            normalizeAnalysisRequest({
                id: "js-child-process",
                language: "javascript",
                program:
                    "export default await import('node:child_process').then((child) => typeof child.spawn === 'function' ? 'exposed' : 'blocked', () => 'blocked')",
            }),
        );

        expect(globals.output).toBe(
            "undefined,undefined,undefined,undefined",
        );
        expect(filesystem.output).toBe("blocked");
        expect(childProcess.output).toBe("blocked");
    });

    it("keeps wrapper internals out of the user program lexical scope", async () => {
        for (const name of ["env", "__freezeBinding", "globalThis"]) {
            const result = await runQuickJsAnalysis(
                normalizeAnalysisRequest({
                    id: `js-local-${name}`,
                    language: "javascript",
                    program: `const ${name} = 1; export default ${name}`,
                }),
            );
            expect(result.output, name).toBe("1");
        }
    });

    it("enforces the guest memory ceiling", async () => {
        await expect(
            runQuickJsAnalysis(
                normalizeAnalysisRequest({
                    id: "js-memory",
                    language: "javascript",
                    program: "export default 'x'.repeat(64 * 1024 * 1024)",
                    limits: { memoryBytes: 8 * 1024 * 1024 },
                }),
            ),
        ).rejects.toThrow(/memory|allocation/i);
    });

    it("interrupts infinite loops within the requested deadline", async () => {
        const started = performance.now();
        await expect(
            runQuickJsAnalysis(
                normalizeAnalysisRequest({
                    id: "js-timeout",
                    language: "javascript",
                    program: "while (true) {}",
                    limits: { wallTimeMs: 100 },
                }),
            ),
        ).rejects.toThrow(/interrupt|timeout/i);

        expect(performance.now() - started).toBeLessThan(2_000);
    });

    it("enforces the UTF-8 output budget for logs, errors, and results", async () => {
        for (const [id, program] of [
            ["js-output-log", "console.log('abc')"],
            ["js-output-error", "console.error('abc')"],
            ["js-output-result", "export default 'abc'"],
        ]) {
            await expect(
                runQuickJsAnalysis(
                    normalizeAnalysisRequest({
                        id,
                        language: "javascript",
                        program,
                        limits: { outputBytes: 2 },
                    }),
                ),
            ).rejects.toThrow("Analysis output exceeds 2 bytes");
        }
    });

    it("bounds structured result serialization before constructing it", async () => {
        await expect(
            runQuickJsAnalysis(
                normalizeAnalysisRequest({
                    id: "js-structured-output-cap",
                    language: "javascript",
                    program: "export default Array.from({ length: 10000 }, () => 'x')",
                    limits: { outputBytes: 32 },
                }),
            ),
        ).rejects.toThrow("Analysis output exceeds 32 bytes");
    });

    it("bounds structured console serialization before constructing it", async () => {
        await expect(
            runQuickJsAnalysis(
                normalizeAnalysisRequest({
                    id: "js-structured-console-cap",
                    language: "javascript",
                    program: "console.log(Array.from({ length: 10000 }, () => 'x'))",
                    limits: { outputBytes: 32 },
                }),
            ),
        ).rejects.toThrow("Analysis output exceeds 32 bytes");
    });
});
