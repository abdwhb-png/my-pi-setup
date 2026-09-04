import { describe, expect, it } from "bun:test";

import { buildSafeBashDescription, buildSafeBashPromptSnippet, SAFE_BASH_BASE_DESCRIPTION } from "./description";

describe("buildSafeBashDescription", () => {
    it("default config shows mode and deny-default count", () => {
        const result = buildSafeBashDescription({
            config: { mode: "coexist", guardPolicy: {}, allowedShellCommands: [] },
            enforceNativeTools: true,
        });
        expect(result.startsWith(SAFE_BASH_BASE_DESCRIPTION)).toBe(true);
        expect(result).toContain("Mode=coexist");
        expect(result).toContain("deny(default)=");
        expect(result).toContain("bypass=none");
        expect(result).toContain("native-redirect: grep/find/ls");
    });

    it("shows allow and ask groups explicitly", () => {
        const result = buildSafeBashDescription({
            config: {
                mode: "replace",
                guardPolicy: { sudo: "allow", rm: "ask", chmod: "ask" },
                allowedShellCommands: [],
            },
            enforceNativeTools: true,
        });
        expect(result).toContain("Mode=replace");
        expect(result).toContain("allow=[sudo]");
        expect(result).toContain("ask=[chmod,rm]");
    });

    it("shows allowedShellCommands bypass", () => {
        const result = buildSafeBashDescription({
            config: {
                mode: "coexist",
                guardPolicy: {},
                allowedShellCommands: ["grep", "find"],
            },
            enforceNativeTools: true,
        });
        expect(result).toContain("bypass=[grep,find]");
    });

    it("shows relaxed native-redirect when not enforced", () => {
        const result = buildSafeBashDescription({
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
        const result = buildSafeBashDescription({
            config: { mode: "replace", guardPolicy, allowedShellCommands: ["grep"] },
            enforceNativeTools: true,
        });
        expect(result.length).toBeLessThan(600);
    });
});

describe("buildSafeBashPromptSnippet", () => {
    it("contains mode and bypass", () => {
        const result = buildSafeBashPromptSnippet({
            config: { mode: "coexist", guardPolicy: {}, allowedShellCommands: [] },
            enforceNativeTools: true,
        });
        expect(result).toContain("mode=coexist");
        expect(result).toContain("bypass:none");
        expect(result).toContain("native=enforced");
    });

    it("lists allow and ask", () => {
        const result = buildSafeBashPromptSnippet({
            config: {
                mode: "replace",
                guardPolicy: { sudo: "allow", rm: "ask" },
                allowedShellCommands: ["grep"],
            },
            enforceNativeTools: false,
        });
        expect(result).toContain("allow:sudo");
        expect(result).toContain("ask:rm");
        expect(result).toContain("native=relaxed");
    });
});
