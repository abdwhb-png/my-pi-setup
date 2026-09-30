import { describe, expect, it } from "bun:test";

import { buildSafeBashContext } from "./description";

describe("buildSafeBashContext", () => {
    it("default config shows mode and deny-default count", () => {
        const result = buildSafeBashContext({
            config: { mode: "coexist", guardPolicy: {}, guardPolicyNotes: [], allowedShellCommands: [] },
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
                guardPolicyNotes: [],
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
                guardPolicyNotes: [],
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
                guardPolicyNotes: [],
                allowedShellCommands: [],
            },
            enforceNativeTools: true,
        });
        expect(result).toContain("cwd-only=[file-delete-api,rm]");
    });

    it("shows relaxed native-redirect when not enforced", () => {
        const result = buildSafeBashContext({
            config: { mode: "coexist", guardPolicy: {}, guardPolicyNotes: [], allowedShellCommands: [] },
            enforceNativeTools: false,
        });
        expect(result).toContain("native-redirect: relaxed");
    });

    it("shows sandbox-only and anyOf scope groups", () => {
        const result = buildSafeBashContext({
            config: {
                mode: "coexist",
                guardPolicy: {
                    rm: "sandbox-only",
                    chown: "cwd-only",
                    dd: { anyOf: ["cwd-only", "sandbox-only"] },
                },
                guardPolicyNotes: [],
                allowedShellCommands: [],
            },
            enforceNativeTools: true,
        });
        expect(result).toContain("sandbox-only=[rm]");
        expect(result).toContain("cwd-only=[chown]");
        expect(result).toContain(
            "scope-anyOf=[dd:cwd-only|sandbox-only]",
        );
    });

    it("surfaces rejected guardPolicy entries so a silent drop is visible", () => {
        const result = buildSafeBashContext({
            config: {
                mode: "coexist",
                guardPolicy: { chmod: "cwd-only" },
                guardPolicyNotes: [
                    "guardPolicy.sudo: cwd-only needs a path target, which this group has none of; use allow, ask, or deny. Entry ignored.",
                ],
                allowedShellCommands: [],
            },
            enforceNativeTools: true,
        });
        expect(result).toContain("Ignored guardPolicy");
        expect(result).toContain("guardPolicy.sudo");
    });

    it("omits the ignored-policy clause when nothing was rejected", () => {
        const result = buildSafeBashContext({
            config: { mode: "coexist", guardPolicy: {}, guardPolicyNotes: [], allowedShellCommands: [] },
            enforceNativeTools: true,
        });
        expect(result).not.toContain("Ignored guardPolicy");
    });

    it("keeps output under 500 chars even with many allow groups", () => {
        const guardPolicy: Record<string, "allow"> = {};
        for (const g of ["sudo", "rm", "mkfs", "dd", "chmod", "chown"]) {
            guardPolicy[g] = "allow";
        }
        const result = buildSafeBashContext({
            config: { mode: "replace", guardPolicy, guardPolicyNotes: [], allowedShellCommands: ["grep"] },
            enforceNativeTools: true,
        });
        expect(result.length).toBeLessThan(600);
    });
});
