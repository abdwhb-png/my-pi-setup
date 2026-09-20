import { expect, test } from "bun:test";
import { createTestSession } from "@abdwhb-png/pi-test-harness";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import bashExecution from "./index.ts";

test("both registered shell tools share stable execution guidance", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-shell-presentation-"));
    const session = await createTestSession({
        cwd,
        extensionFactories: [bashExecution],
    });
    try {
        for (const name of ["bash", "safe_bash"] as const) {
            const tool = session.session.getToolDefinition(name)!;
            expect(tool.description).toStartWith(
                name === "bash"
                    ? "Execute a shell command using the current sandbox or host execution mode."
                    : "Execute a shell command using the current sandbox or host execution mode, with additional command checks.",
            );
            expect(tool.description).toContain("stdin");
            expect(tool.description).toContain("stdout and stderr");
            expect(tool.description).toContain("truncated");
            expect(tool.promptSnippet).toContain(
                "current sandbox or host execution mode",
            );
            expect(tool.description).not.toMatch(
                /Mode=|allow=|deny\(default\)|replace|coexist/,
            );
            expect(tool.promptGuidelines).toContain(
                "When a command targets another execution environment, resolve its executable paths and variables in that environment.",
            );
            expect(tool.promptGuidelines?.join("\n")).not.toMatch(
                /PI_\*|SFW|dev-services|hostCapability/,
            );
        }
    } finally {
        session.dispose();
        await rm(cwd, { recursive: true, force: true });
    }
});
