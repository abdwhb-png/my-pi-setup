import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    createTestSession,
    says,
    when,
    type TestSession,
} from "@abdwhb-png/pi-test-harness";

describe("skill loader through the real Pi session", () => {
    let cwd: string;
    let session: TestSession | undefined;

    beforeEach(() => {
        cwd = mkdtempSync(join(tmpdir(), "pi-skill-loader-"));
        for (const [name, body] of [
            ["bun", "BUN_RUNTIME_BODY"],
            ["bun-test", "BUN_TEST_RUNTIME_BODY"],
            ["concise-communication", "CONCISE_RUNTIME_BODY"],
        ]) {
            const directory = join(cwd, "skills", name);
            mkdirSync(directory, { recursive: true });
            writeFileSync(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: Test fixture\n---\n\n${body}\n`);
        }
    });

    afterEach(() => {
        session?.dispose();
        session = undefined;
        rmSync(cwd, { recursive: true, force: true });
    });

    it("delivers every referenced skill once and supports invoking them in a later message", async () => {
        session = await createTestSession({
            cwd,
            extensions: [join(import.meta.dir, "index.ts")],
        });
        await session.run(
            when("this is a test $bun $bun-test, next $concise-communication", [says("first done")]),
            when("$unknown ($BUN),$bun-test and $bun again", [says("second done")]),
        );

        const batches = session.events.messages.filter(message => message.role === "custom" && message.customType === "skill-loaded");
        expect(batches).toHaveLength(2);
        expect(batches[0]).toMatchObject({ details: { skillNames: ["bun", "bun-test", "concise-communication"] } });
        expect(batches[1]).toMatchObject({ details: { skillNames: ["bun", "bun-test"] } });
        const first = JSON.stringify(batches[0]);
        expect(first.split("BUN_RUNTIME_BODY")).toHaveLength(2);
        expect(first.split("BUN_TEST_RUNTIME_BODY")).toHaveLength(2);
        expect(first.split("CONCISE_RUNTIME_BODY")).toHaveLength(2);
        const second = JSON.stringify(batches[1]);
        expect(second.split("BUN_RUNTIME_BODY")).toHaveLength(2);
        expect(second.split("BUN_TEST_RUNTIME_BODY")).toHaveLength(2);
        const users = session.events.messages.filter(message => message.role === "user");
        expect(users).toHaveLength(2);
        expect(users[0]).toMatchObject({ content: [{ type: "text", text: "this is a test skill:bun skill:bun-test, next skill:concise-communication" }] });
        expect(users[1]).toMatchObject({ content: [{ type: "text", text: "$unknown (skill:bun),skill:bun-test and skill:bun again" }] });
        expect(session.events.messages.filter(message => message.role === "assistant")).toHaveLength(2);
        expect(session.playbook.remaining).toBe(0);
    });

    it("keeps native expansion for one unique skill repeated in the prompt", async () => {
        session = await createTestSession({ cwd, extensions: [join(import.meta.dir, "index.ts")] });
        await session.run(when("$unknown use $bun then $BUN", [says("done")]));
        const users = session.events.messages.filter(message => message.role === "user");
        expect(users).toHaveLength(1);
        const content = JSON.stringify(users[0]);
        expect(content.split("BUN_RUNTIME_BODY")).toHaveLength(2);
        expect(content).toContain("$unknown use skill:bun then skill:bun");
        expect(session.events.messages.filter(message => message.role === "custom" && message.customType === "skill-loaded")).toHaveLength(0);
    });
});
