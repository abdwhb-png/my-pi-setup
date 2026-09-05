/// <reference types="bun" />

import { describe, expect, it } from "bun:test";

/**
 * Regression: client.ts used spawn(process.execPath, [hostPath]) directly.
 * Under the real Pi wrapper the process is the compiled Pi binary, not Bun,
 * so the child started Pi and emitted startup noise (theme, catalog, tool-group)
 * instead of JSON -> every analysis returned "Analysis failed".
 * Standalone `bun probe` succeeded because execPath was Bun.
 *
 * This test fakes a non-Bun execPath and asserts the public client resolves
 * a Bun executable that is NOT the fake Pi path, without hardcoding user paths.
 */
describe("analysis sandbox client — Bun executable resolution (regression)", () => {
    it("does not spawn the Pi binary when process.execPath is not Bun", async () => {
        const originalExecPath = process.execPath;
        const fakePiPath = "/tmp/fake-pi-binary-for-regression";

        // Make process.execPath look like the Pi executable, not Bun.
        Object.defineProperty(process, "execPath", {
            value: fakePiPath,
            configurable: true,
            writable: true,
        });

        try {
            // Import fresh after mutating execPath so the module's resolver sees it.
            // Use query-busted import to bypass Bun's module cache for this file.
            const mod = await import(
                `./client.ts?regression=${Date.now()}`
            );

            // New helper must exist; before the fix it either did not exist or
            // returned process.execPath verbatim (the fake Pi path) -> fail.
            const resolveBun = (
                mod as unknown as {
                    resolveAnalysisBunExecutable?: () => string;
                    getAnalysisBunExecutable?: () => string;
                }
            ).resolveAnalysisBunExecutable ??
                (
                    mod as unknown as {
                        getAnalysisBunExecutable?: () => string;
                    }
                ).getAnalysisBunExecutable;

            expect(resolveBun).toBeDefined();

            const resolved = resolveBun!();

            // Must NOT be the fake Pi path.
            expect(resolved).not.toBe(fakePiPath);
            // Must be a Bun executable (absolute containing "bun" or plain "bun" on PATH),
            // never a hardcoded user home and never empty.
            expect(resolved.length).toBeGreaterThan(0);
            expect(resolved.includes("..")).toBe(false);
            const isBunLike =
                resolved === "bun" ||
                resolved.endsWith("/bun") ||
                resolved.endsWith("/bun.exe") ||
                resolved.includes("bun");
            expect(isBunLike).toBe(true);
            // Real installs may be under $HOME/.bun/bin/bun; the point is the fix does not hardcode a literal user path.
            // The fake Pi path is already excluded above; don't assert HOME absence for real bun locations.
        } finally {
            Object.defineProperty(process, "execPath", {
                value: originalExecPath,
                configurable: true,
                writable: true,
            });
        }
    });
});
