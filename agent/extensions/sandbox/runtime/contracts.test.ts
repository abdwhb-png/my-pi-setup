import { describe, expect, it } from "bun:test";

import {
    SANDBOX_CAPABILITIES,
    SANDBOX_ERROR_CODES,
    SandboxExecutionError,
} from "./contracts.ts";

describe("provider-neutral sandbox contracts", () => {
    it("keeps the public error taxonomy closed and bounded", () => {
        expect(SANDBOX_ERROR_CODES).toEqual([
            "unsupported-platform",
            "backend-unavailable",
            "provenance-mismatch",
            "strict-unavailable",
            "unsupported-capability",
            "invalid-policy",
            "spawn-failed",
            "setup-failed",
            "protocol-error",
            "timeout",
            "aborted",
            "cleanup-failed",
        ]);

        for (const code of SANDBOX_ERROR_CODES) {
            const secret = new Error(`raw secret for ${code}`);
            const cleanup = new Error(`cleanup secret for ${code}`);
            const error = new SandboxExecutionError(code, {
                cause: secret,
                cleanupError: cleanup,
            });

            expect(error.code).toBe(code);
            expect(error.message.length).toBeLessThanOrEqual(96);
            expect(error.message).not.toContain("raw secret");
            expect(JSON.stringify(error)).not.toContain("secret");
            expect(error.getCause()).toBe(secret);
            expect(error.getCleanupError()).toBe(cleanup);
            expect(Object.keys(error)).toEqual(["code"]);
        }
    });

    it("declares only the capabilities implemented by the Linux v1 contract", () => {
        expect(SANDBOX_CAPABILITIES).toEqual({
            platforms: ["linux"],
            strict: true,
            exactReadDeny: true,
            exactWriteDeny: true,
            domainAllowlist: true,
            outboundLoopback: true,
            networkDenyAll: true,
            nestedUserNamespacesBlocked: true,
            privateTemp: true,
            environmentFiltering: true,
            processTreeTermination: true,
            dynamicDenyGlobs: false,
            inboundBinding: false,
            arbitraryUnixSockets: false,
        });
    });
});
