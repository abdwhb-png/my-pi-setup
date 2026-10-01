import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestSession } from "@abdwhb-png/pi-test-harness";
import { buildSystemPrompt } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js";
import { isolateSkillHome } from "../../_shared/testing/skill-home.ts";
import { publicExtensionEntrypoint } from "./public-extension-session.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
    for (const dispose of cleanup.splice(0).reverse()) dispose();
});

test.each([false, true])(
    "recovered skills respect saved visibility and native invocation in either extension order: %s",
    async (reverse) => {
        const previous = process.env.PI_CODING_AGENT_DIR;
        cleanup.push(() => {
            if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
            else process.env.PI_CODING_AGENT_DIR = previous;
        });
        const root = mkdtempSync(join(tmpdir(), "skill-composition-"));
        cleanup.push(() => rmSync(root, { recursive: true, force: true }));
        isolateSkillHome(root, cleanup);
        process.env.PI_CODING_AGENT_DIR = root;
        const skillsDir = join(root, ".agents/skills");
        mkdirSync(skillsDir, { recursive: true });
        // Core intentionally ignores these paths; the recovery scanner still discovers them.
        writeFileSync(
            join(skillsDir, ".gitignore"),
            "bom-visible/\nbom-hidden/\nbom-manual/\n",
        );
        for (const name of ["bom-visible", "bom-hidden", "bom-manual"]) {
            const dir = join(skillsDir, name);
            mkdirSync(dir);
            writeFileSync(
                join(dir, "SKILL.md"),
                `\uFEFF---\nname: ${name}\ndescription: Recovered fixture\ndisable-model-invocation: ${name === "bom-manual"}\n---\nBody`,
            );
        }
        mkdirSync(join(root, "config"));
        writeFileSync(
            join(root, "config/skill-gate.json"),
            JSON.stringify({
                skills: { "bom-hidden": "disabled" },
                projects: {},
            }),
        );
        const extensions = [
            publicExtensionEntrypoint("pi-skill-gate"),
            publicExtensionEntrypoint("pi-skill-loader"),
        ];
        if (reverse) extensions.reverse();
        const session = await createTestSession({ cwd: root, extensions });
        cleanup.push(() => session.dispose());
        const result =
            await session.session.extensionRunner.emitBeforeAgentStart(
                "inspect",
                undefined,
                { cwd: root, skills: [] },
            );
        const prompt = buildSystemPrompt(result.systemPromptOptions);
        expect(prompt).toContain("bom-visible");
        expect(prompt.match(/`bom-visible`/g)).toHaveLength(1);
        expect(prompt).not.toContain("bom-hidden");
        expect(prompt).not.toContain("bom-manual");
        expect(result.systemPromptOptions.forceSystemPrompt).toBeUndefined();
    },
);
