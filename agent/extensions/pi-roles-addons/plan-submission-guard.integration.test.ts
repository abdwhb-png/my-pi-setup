import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    calls,
    createTestSession,
    says,
    when,
    type TestSession,
} from "@abdwhb-png/pi-test-harness";
import piRoles from "pi-roles";
import {
    ACTIVE_ROLE_ENTRY_TYPE,
    ROLE_SWITCH_PROCESSED_TYPE,
} from "../_shared/pi-roles.ts";
import planAutoSwitch from "./plan-auto-switch.ts";
import registerPlanSubmissionGuard from "./plan-submission-guard.ts";

const sessions: TestSession[] = [];
const directories: string[] = [];

function writeRole(directory: string, name: string, handoffGuard?: string): void {
    writeFileSync(
        join(directory, `${name}.md`),
        [
            "---",
            `name: ${name}`,
            `description: ${name} fixture`,
            ...(handoffGuard ? [`handoffGuard: ${handoffGuard}`] : []),
            "---",
            `# ${name}`,
        ].join("\n"),
    );
}

function createProject(): string {
    const cwd = mkdtempSync(join(tmpdir(), "plan-submission-guard-"));
    directories.push(cwd);
    const roles = join(cwd, ".pi", "roles");
    mkdirSync(roles, { recursive: true });
    writeRole(roles, "plan", "plan-submission");
    writeRole(roles, "pi-agent");
    writeFileSync(
        join(cwd, ".pi", "settings.json"),
        JSON.stringify({
            "pi-roles": {
                defaultRole: "pi-agent",
                roleScope: "project",
                showWidget: false,
            },
        }),
    );
    return cwd;
}

function planToolFixtures(pi: ExtensionAPI): void {
    pi.registerTool({
        name: "write_plan",
        label: "Write plan fixture",
        description: "Fixture",
        parameters: Type.Object({ path: Type.String() }),
        async execute() {
            return { content: [{ type: "text", text: "Plan written." }], details: {} };
        },
    });
    pi.registerTool({
        name: "plan_submit",
        label: "Submit plan fixture",
        description: "Fixture",
        parameters: Type.Object({ filePath: Type.String() }),
        async execute(_id, params) {
            pi.appendEntry("plannotator:plan-approved", {
                planPath: params.filePath,
                approved: true,
                timestamp: Date.now(),
            });
            return {
                content: [{ type: "text", text: "Plan approved." }],
                details: { approved: true },
            };
        },
    });
}

function entries(session: TestSession): Array<{ type: string; customType?: string; data?: unknown }> {
    return session.session.sessionManager.getEntries() as Array<{
        type: string;
        customType?: string;
        data?: unknown;
    }>;
}

async function waitForEntry(
    session: TestSession,
    predicate: (entry: ReturnType<typeof entries>[number]) => boolean,
    timeoutMs = 2_000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (entries(session).some(predicate)) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for expected session entry.");
}

afterEach(() => {
    for (const session of sessions.splice(0)) session.dispose();
    for (const directory of directories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

describe("plan submission guard real Pi lifecycle", () => {
    it("blocks switch_role while the latest revision is unsubmitted", async () => {
        const cwd = createProject();
        const previousRole = process.env.PI_ROLE;
        process.env.PI_ROLE = "plan";
        let session: TestSession;
        try {
            session = await createTestSession({
                cwd,
                extensionFactories: [
                    piRoles,
                    registerPlanSubmissionGuard,
                    planAutoSwitch,
                    planToolFixtures,
                ],
            });
        } finally {
            if (previousRole === undefined) delete process.env.PI_ROLE;
            else process.env.PI_ROLE = previousRole;
        }
        sessions.push(session!);

        await session!.run(
            when("Write then try to leave planning.", [
                calls("write_plan", { path: "feature.md" }),
                calls("switch_role", { roleName: "pi-agent" }),
                says("I must submit or abandon the plan first."),
            ]),
        );

        expect(session!.events.toolResultsFor("switch_role")[0]?.text).toContain(
            "Plan review required for pi-plans/feature.md",
        );
        expect(entries(session!).findLast((entry) => entry.customType === ACTIVE_ROLE_ENTRY_TYPE)?.data).toMatchObject({
            name: "plan",
        });
    });

    it("allows the approved revision to hand off from plan to pi-agent", async () => {
        const cwd = createProject();
        const previousRole = process.env.PI_ROLE;
        process.env.PI_ROLE = "plan";
        let session: TestSession;
        try {
            session = await createTestSession({
                cwd,
                extensionFactories: [
                    piRoles,
                    registerPlanSubmissionGuard,
                    planAutoSwitch,
                    planToolFixtures,
                ],
            });
        } finally {
            if (previousRole === undefined) delete process.env.PI_ROLE;
            else process.env.PI_ROLE = previousRole;
        }
        sessions.push(session!);

        await session!.run(
            when("Write and approve the plan.", [
                calls("write_plan", { path: "feature.md" }),
                calls("plan_submit", { filePath: "pi-plans/feature.md" }),
                says("Plan approved."),
            ]),
        );
        await waitForEntry(
            session!,
            (entry) => entry.customType === ROLE_SWITCH_PROCESSED_TYPE,
        );
        await session!.session.agent.waitForIdle();

        const history = entries(session!);
        expect(history).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ customType: "plan-review-guard:revision" }),
                expect.objectContaining({ customType: "plan-review-guard:submitted" }),
                expect.objectContaining({ customType: ROLE_SWITCH_PROCESSED_TYPE }),
            ]),
        );
        expect(history.findLast((entry) => entry.customType === ACTIVE_ROLE_ENTRY_TYPE)?.data).toMatchObject({
            name: "pi-agent",
        });
    });
});
