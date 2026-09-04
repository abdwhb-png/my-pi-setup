import { afterEach, describe, expect, it } from "bun:test";
import {
    createTestSession,
    says,
    type TestSession,
    when,
} from "@abdwhb-png/pi-test-harness";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import markdownLinksExtension from "./index.ts";

const sessions: TestSession[] = [];
const directories: string[] = [];

afterEach(() => {
    for (const session of sessions.splice(0)) session.dispose();
    for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

describe("markdown-links real Pi lifecycle", () => {
    it("resolves a project prompt link from the prompt file and preserves argument links", async () => {
        const cwd = mkdtempSync(join(tmpdir(), "markdown-links-runtime-"));
        directories.push(cwd);
        const promptDir = join(cwd, ".pi", "prompts");
        const targetDir = join(cwd, ".agents", "prompts");
        mkdirSync(promptDir, { recursive: true });
        mkdirSync(targetDir, { recursive: true });
        const promptPath = join(promptDir, "browser-debug.md");
        const targetPath = join(targetDir, "browser-debug.md");
        writeFileSync(targetPath, "TARGET BODY MUST NOT BE INJECTED");
        writeFileSync(
            promptPath,
            [
                "---",
                "description: Browser debugging fixture",
                "---",
                "Read [browser-debug](../../.agents/prompts/browser-debug.md) for instructions.",
                "$ARGUMENTS",
            ].join("\n"),
        );

        const session = await createTestSession({
            cwd,
            extensionFactories: [markdownLinksExtension],
        });
        sessions.push(session);
        const command = "/browser-debug [argument](argument.md)";

        await session.run(when(command, [says("done")]));

        const userMessages = session.events.messages.filter(
            (message) => message.role === "user",
        );
        const content = userMessages
            .flatMap((message) =>
                typeof message.content === "string"
                    ? [message.content]
                    : message.content
                          .filter((part) => part.type === "text")
                          .map((part) => part.text),
            )
            .join("\n");
        expect(content).toContain(`[browser-debug](${targetPath})`);
        expect(content).toContain("[argument](argument.md)");
        expect(content).not.toContain("TARGET BODY MUST NOT BE INJECTED");
    });
});
