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
import { publicExtensionEntrypoints } from "./public-extension-session.ts";

const sessions: TestSession[] = [];
const directories: string[] = [];

function createProject(): string {
    const cwd = mkdtempSync(join(tmpdir(), "session-plan-persistence-"));
    directories.push(cwd);
    const roles = join(cwd, ".pi", "roles");
    mkdirSync(roles, { recursive: true });
    writeFileSync(
        join(roles, "quick-planner.md"),
        [
            "---",
            "name: quick-planner",
            "description: quick planner fixture",
            "handoffGuard: session-plan-persistence",
            "---",
            "# Quick planner fixture",
        ].join("\n"),
    );
    writeFileSync(
        join(cwd, ".pi", "settings.json"),
        JSON.stringify({
            "pi-roles": {
                defaultRole: "quick-planner",
                roleScope: "project",
                showWidget: false,
            },
        }),
    );
    return cwd;
}

afterEach(() => {
    for (const session of sessions.splice(0)) session.dispose();
    for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

describe("session plan persistence guard real Pi lifecycle", () => {
    it("delivers an unpersisted answer verbatim while still gating the handoff", async () => {
        const cwd = createProject();
        const previousRole = process.env.PI_ROLE;
        process.env.PI_ROLE = "quick-planner";
        let session: TestSession;
        try {
            session = await createTestSession({
                cwd,
                extensions: publicExtensionEntrypoints("pi-roles", "plan-workflow"),
            });
        } finally {
            if (previousRole === undefined) delete process.env.PI_ROLE;
            else process.env.PI_ROLE = previousRole;
        }
        sessions.push(session!);

        await session!.run(
            when("Stop planning and explain why.", [
                says("unpersisted runtime explanation"),
            ]),
        );

        const assistantText = session!.events.messages
            .filter((message) => message.role === "assistant")
            .flatMap((message) => message.content)
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
        expect(assistantText).toContain("unpersisted runtime explanation");
        expect(assistantText).not.toContain("session-plan-persistence-guard");
        expect(session!.events.toolResultsFor("session_plan")).toHaveLength(0);
    });

    it("refuses to leave the planning role until a plan is saved", async () => {
        const cwd = createProject();
        const previousRole = process.env.PI_ROLE;
        process.env.PI_ROLE = "quick-planner";
        let session: TestSession;
        try {
            session = await createTestSession({
                cwd,
                extensions: publicExtensionEntrypoints("pi-roles", "plan-workflow"),
            });
        } finally {
            if (previousRole === undefined) delete process.env.PI_ROLE;
            else process.env.PI_ROLE = previousRole;
        }
        sessions.push(session!);

        await session!.run(
            when("Create a quick plan.", [says("planning in progress")]),
        );
        await session!.session.prompt("/role pi-agent");
        await session!.session.agent.waitForIdle();

        expect(
            session!.session.sessionManager
                .getEntries()
                .filter(
                    (entry) =>
                        entry.type === "custom" &&
                        entry.customType === "pi-roles:active-role",
                )
                .at(-1),
        ).toMatchObject({ data: { name: "quick-planner" } });
    });

    it("lets /session-plan-abandon release the handoff gate", async () => {
        const cwd = createProject();
        const previousRole = process.env.PI_ROLE;
        process.env.PI_ROLE = "quick-planner";
        let session: TestSession;
        try {
            session = await createTestSession({
                cwd,
                systemPrompt: "Custom SYSTEM.md",
                extensions: publicExtensionEntrypoints("pi-roles", "plan-workflow"),
            });
        } finally {
            if (previousRole === undefined) delete process.env.PI_ROLE;
            else process.env.PI_ROLE = previousRole;
        }
        sessions.push(session!);

        await session!.run(when("Plan a change.", [says("planning")]));
        await session!.session.prompt("/session-plan-abandon");
        await session!.session.agent.waitForIdle();
        await session!.session.prompt("/role pi-agent");
        await session!.session.agent.waitForIdle();

        expect(
            session!.session.sessionManager
                .getEntries()
                .filter(
                    (entry) =>
                        entry.type === "custom" &&
                        entry.customType === "pi-roles:active-role",
                )
                .at(-1),
        ).toMatchObject({ data: { name: "pi-agent" } });
    });
});
