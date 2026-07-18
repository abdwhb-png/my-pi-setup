import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
    calls,
    createTestSession,
    says,
    when,
    type TestSession,
} from '@marcfargas/pi-test-harness';
import piRoles from 'pi-roles';
import {
    ACTIVE_ROLE_ENTRY_TYPE,
    ROLE_SWITCH_PROCESSED_TYPE,
    ROLE_SWITCH_REQUEST_ENTRY_TYPE,
    getDefaultRole,
} from '../_shared/pi-roles';
import yeet from '../yeet';
import planAutoSwitch, {
    PLUG_PLANNOTATOR_AUTOEXECUTE_PROCESSED,
} from './plan-auto-switch';

// Pin Plannotator's external contract independently of the consumer under test.
const PLAN_APPROVED_ENTRY_TYPE = 'plannotator:plan-approved';
const APPROVED_PLAN_CONTINUATION = 'Continue with the approved plan.';
const APPROVE_PLAN_FIXTURE_TOOL = 'approve_plan_fixture';

interface SessionEntry {
    id: string;
    type: string;
    customType?: string;
    data?: unknown;
}

const tempDirectories: string[] = [];
const sessions: TestSession[] = [];

afterEach(() => {
    for (const session of sessions.splice(0)) session.dispose();
    for (const directory of tempDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

function approvalFixture(pi: ExtensionAPI): void {
    pi.registerTool({
        name: APPROVE_PLAN_FIXTURE_TOOL,
        label: 'Approve plan fixture',
        description: 'Emit the same approval entry as Plannotator.',
        parameters: Type.Object({}),
        async execute() {
            pi.appendEntry(PLAN_APPROVED_ENTRY_TYPE, {
                planPath: '/tmp/approved-plan.md',
                approved: true,
                timestamp: Date.now(),
            });
            return {
                content: [{ type: 'text' as const, text: 'Plan approved.' }],
                details: {},
            };
        },
    });
}

function writeRole(directory: string, name: string): void {
    writeFileSync(
        join(directory, `${name}.md`),
        [
            '---',
            `name: ${name}`,
            `description: Integration fixture for ${name}`,
            '---',
            `# ${name}`,
        ].join('\n'),
    );
}

function createFixtureProject(targetRole: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(targetRole)) {
        throw new Error(
            `Cannot create role fixture for invalid role name: ${targetRole}`,
        );
    }

    const cwd = mkdtempSync(join(tmpdir(), 'plan-auto-switch-integration-'));
    tempDirectories.push(cwd);

    const rolesDirectory = join(cwd, '.pi', 'roles');
    mkdirSync(rolesDirectory, { recursive: true });
    writeRole(rolesDirectory, 'plan');
    if (targetRole !== 'plan') writeRole(rolesDirectory, targetRole);

    writeFileSync(
        join(cwd, '.pi', 'settings.json'),
        JSON.stringify({
            'pi-roles': {
                defaultRole: targetRole,
                roleScope: 'project',
                showWidget: false,
            },
        }),
    );

    return cwd;
}

function getEntries(session: TestSession): SessionEntry[] {
    return session.session.sessionManager.getEntries() as SessionEntry[];
}

async function waitForEntry(
    session: TestSession,
    predicate: (entry: SessionEntry) => boolean,
    timeoutMs = 2_000,
): Promise<SessionEntry> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const entry = getEntries(session).find(predicate);
        if (entry) return entry;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }

    throw new Error(
        `Timed out waiting for session entry. Entries: ${JSON.stringify(getEntries(session))}`,
    );
}

describe('plan-auto-switch real Pi lifecycle', () => {
    it('leaves plan after approval when Yeet is loaded', async () => {
        const targetRole = getDefaultRole();
        const cwd = createFixtureProject(targetRole);
        const previousInitialRole = process.env.PI_ROLE;
        process.env.PI_ROLE = 'plan';

        let session: TestSession;
        try {
            session = await createTestSession({
                cwd,
                extensionFactories: [
                    piRoles,
                    planAutoSwitch,
                    yeet,
                    approvalFixture,
                ],
            });
        } finally {
            if (previousInitialRole === undefined) delete process.env.PI_ROLE;
            else process.env.PI_ROLE = previousInitialRole;
        }
        sessions.push(session);

        const initialRole = getEntries(session).findLast(
            (entry) => entry.customType === ACTIVE_ROLE_ENTRY_TYPE,
        );
        expect(initialRole?.data).toMatchObject({ name: 'plan' });

        await session.run(
            when('Submit the approved plan.', [
                calls(APPROVE_PLAN_FIXTURE_TOOL),
                says('Approval recorded.'),
            ]),
        );

        const request = await waitForEntry(
            session,
            (entry) => entry.customType === ROLE_SWITCH_REQUEST_ENTRY_TYPE,
        );
        expect(request.data).toMatchObject({
            targetRole,
            reason: 'plannotator:plan-approved',
        });

        const processed = await waitForEntry(
            session,
            (entry) =>
                entry.customType === ROLE_SWITCH_PROCESSED_TYPE &&
                (entry.data as { sourceEntryId?: string } | undefined)
                    ?.sourceEntryId === request.id,
        );
        expect(processed).toBeDefined();
        await session.session.agent.waitForIdle();

        const entries = getEntries(session);
        const approval = entries.find(
            (entry) => entry.customType === PLAN_APPROVED_ENTRY_TYPE,
        );
        const approvalMarker = entries.find(
            (entry) =>
                entry.customType === PLUG_PLANNOTATOR_AUTOEXECUTE_PROCESSED &&
                (entry.data as { sourceEntryId?: string } | undefined)
                    ?.sourceEntryId === approval?.id,
        );
        const activeRole = entries.findLast(
            (entry) => entry.customType === ACTIVE_ROLE_ENTRY_TYPE,
        );

        expect(approval).toBeDefined();
        expect(approvalMarker).toBeDefined();
        expect(activeRole?.data).toMatchObject({ name: targetRole });

        const automaticContinuation = session.events.messages.find(
            (message) => {
                if (message.role !== 'user') return false;
                if (typeof message.content === 'string') {
                    return message.content === APPROVED_PLAN_CONTINUATION;
                }
                return message.content.some(
                    (content) =>
                        content.type === 'text' &&
                        content.text === APPROVED_PLAN_CONTINUATION,
                );
            },
        );
        expect(automaticContinuation).toBeDefined();
    });
});
