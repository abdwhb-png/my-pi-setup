import { describe, expect, it } from "bun:test";
import { createJiti } from "jiti";
import { pathToFileURL } from "node:url";

import {
    SANDBOX_ERROR_CODES,
    SandboxExecutionError,
    isSandboxExecutionError,
    sandboxErrorMessage,
} from "./errors.ts";

function loadErrorsModule() {
    const jiti = createJiti(import.meta.url, { moduleCache: false });
    const absolutePath = pathToFileURL(`${import.meta.dir}/errors.ts`).href;
    return jiti(absolutePath) as Record<string, unknown>;
}

describe("shared sandbox execution errors", () => {
    it("publishes a closed safe code and message contract", () => {
        for (const code of SANDBOX_ERROR_CODES) {
            const cause = new Error(`technical secret for ${code}`);
            const cleanup = new Error(`cleanup secret for ${code}`);
            const error = new SandboxExecutionError(code, {
                cause,
                cleanupError: cleanup,
            });

            expect(error.code).toBe(code);
            expect(error.message).toBe(sandboxErrorMessage(code));
            expect(error.message.length).toBeLessThanOrEqual(96);
            expect(error.getCause()).toBe(cause);
            expect(error.getCleanupError()).toBe(cleanup);
            expect(Object.keys(error)).toEqual(["code"]);
            expect(JSON.stringify(error)).not.toContain("secret");
        }
    });

    it("survives separate Jiti module caches", () => {
        const loaderA = loadErrorsModule();
        const loaderB = loadErrorsModule();
        const ErrorA = loaderA.SandboxExecutionError as typeof SandboxExecutionError;
        const ErrorB = loaderB.SandboxExecutionError as typeof SandboxExecutionError;
        const isErrorB = loaderB.isSandboxExecutionError as typeof isSandboxExecutionError;

        expect(ErrorA).not.toBe(ErrorB);
        expect(isErrorB(new ErrorA("setup-failed"))).toBe(true);
    });

    it("rejects unbranded and out-of-taxonomy values", () => {
        expect(isSandboxExecutionError(new Error("setup-failed"))).toBe(false);

        const forged = new Error("Sandbox setup failed");
        Object.defineProperty(
            forged,
            Symbol.for("pi.sandbox-runtime.SandboxExecutionError.v2"),
            { value: true },
        );
        Object.defineProperty(forged, "code", { value: "invented-code" });
        expect(isSandboxExecutionError(forged)).toBe(false);
    });
});
