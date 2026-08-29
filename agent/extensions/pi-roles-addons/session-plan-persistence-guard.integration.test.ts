import { afterEach, describe, expect, it } from "bun:test";
import {
    calls,
    createTestSession,
    says,
    type TestSession,
    when,
} from "@abdwhb-png/pi-test-harness";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import piRoles from "pi-roles";
import sessionPlanExtension from "../session-plan/index.ts";
import registerSessionPlanPersistenceGuard, {
    buildPlanPersistenceFollowUp,
} from "./session-plan-persistence-guard.ts";

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
    it("withholds an unpersisted answer, forces real session_plan save, then allows final plan", async () => {
        const cwd = createProject();
        const previousRole = process.env.PI_ROLE;
        process.env.PI_ROLE = "quick-planner";
        let session: TestSession;
        try {
            session = await createTestSession({
                cwd,
                extensionFactories: [
                    piRoles,
                    sessionPlanExtension,
                    registerSessionPlanPersistenceGuard,
                ],
            });
        } finally {
            if (previousRole === undefined) delete process.env.PI_ROLE;
            else process.env.PI_ROLE = previousRole;
        }
        sessions.push(session!);

        await session!.run(
            when("Create a quick plan.", [says("unpersisted runtime plan")]),
            when(buildPlanPersistenceFollowUp(), [
                calls("session_plan", {
                    action: "save",
                    topic: "runtime-quick-plan",
                    content: "# Runtime quick plan\n\nPersisted.",
                }),
                says("persisted runtime plan"),
            ]),
        );

        const assistantText = session!.events.messages
            .filter((message) => message.role === "assistant")
            .flatMap((message) => message.content)
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
        expect(assistantText).toContain("session-plan-persistence-guard");
        expect(assistantText).not.toContain("unpersisted runtime plan");
        expect(assistantText).toContain("persisted runtime plan");
        expect(session!.events.toolResultsFor("session_plan")[0]).toMatchObject({
            isError: false,
        });
        expect(
            session!.session.sessionManager
                .getEntries()
                .some(
                    (entry) =>
                        entry.type === "custom" &&
                        entry.customType ===
                            "session-plan-persistence-guard:saved",
                ),
        ).toBe(true);
    });
});
