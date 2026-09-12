import { describe, expect, it } from "bun:test";

import { buildSafeBashContext } from "./description";

describe("buildSafeBashContext", () => {
    it("default config shows mode and deny-default count", () => {
        const result = buildSafeBashContext({
            config: { mode: "coexist", guardPolicy: {}, allowedShellCommands: [] },
            enforceNativeTools: true,
        });
        expect(result).toStartWith("safe_bash:");
        expect(result).toContain("Tool availability=coexist");
        expect(result).toContain("deny(default)=");
        expect(result).toContain("bypass=none");
        expect(result).toContain("native-redirect: grep/find/ls");
    });

    it("shows allow and ask groups explicitly", () => {
        const result = buildSafeBashContext({
            config: {
                mode: "replace",
                guardPolicy: { sudo: "allow", rm: "ask", chmod: "ask" },
                allowedShellCommands: [],
            },
            enforceNativeTools: true,
        });
        expect(result).toContain("Tool availability=replace");
        expect(result).toContain("allow=[sudo]");
        expect(result).toContain("ask=[chmod,rm]");
    });

    it("shows allowedShellCommands bypass", () => {
        const result = buildSafeBashContext({
            config: {
                mode: "coexist",
                guardPolicy: {},
                allowedShellCommands: ["grep", "find"],
            },
            enforceNativeTools: true,
        });
        expect(result).toContain("bypass=[grep,find]");
    });

    it("shows cwd-only groups", () => {
        const result = buildSafeBashContext({
            config: {
                mode: "coexist",
                guardPolicy: {
                    rm: "cwd-only",
                    "file-delete-api": "cwd-only",
                },
                allowedShellCommands: [],
            },
            enforceNativeTools: true,
        });
        expect(result).toContain("cwd-only=[file-delete-api,rm]");
    });

    it("shows relaxed native-redirect when not enforced", () => {
        const result = buildSafeBashContext({
            config: { mode: "coexist", guardPolicy: {}, allowedShellCommands: [] },
            enforceNativeTools: false,
        });
        expect(result).toContain("native-redirect: relaxed");
    });

    it("keeps output under 500 chars even with many allow groups", () => {
        const guardPolicy: Record<string, "allow"> = {};
        for (const g of ["sudo", "rm", "mkfs", "dd", "chmod", "chown"]) {
            guardPolicy[g] = "allow";
        }
        const result = buildSafeBashContext({
            config: { mode: "replace", guardPolicy, allowedShellCommands: ["grep"] },
            enforceNativeTools: true,
        });
        expect(result.length).toBeLessThan(600);
    });
});
