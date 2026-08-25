import { afterEach, describe, expect, it } from 'bun:test';
import type {
    ExtensionAPI,
    ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import atlasPiSubagents, {
    ATLAS_PI_SUBAGENTS_MARKER,
} from './atlas-pi-subagents.ts';

type SessionEntry = {
    type: string;
    customType?: string;
    data?: unknown;
};

type BeforeAgentStartHandler = (
    event: { systemPrompt: string },
    ctx: ExtensionContext,
) =>
    | { systemPrompt: string }
    | undefined
    | Promise<{ systemPrompt: string } | undefined>;

const previousChild = process.env.PI_SUBAGENT_CHILD;

afterEach(() => {
    if (previousChild === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = previousChild;
});

function activeRole(name: string): SessionEntry {
    return {
        type: 'custom',
        customType: 'pi-roles:active-role',
        data: {
            name,
            source: 'user',
            path: `/tmp/${name}.md`,
            appliedAt: Date.now(),
        },
    };
}

function registerHandler(): BeforeAgentStartHandler {
    let handler: BeforeAgentStartHandler | undefined;
    const pi = {
        on(event: string, registered: BeforeAgentStartHandler) {
            if (event === 'before_agent_start') handler = registered;
        },
    } as unknown as ExtensionAPI;

    atlasPiSubagents(pi);
    if (!handler) throw new Error('before_agent_start handler not registered');
    return handler;
}

function context(entries: SessionEntry[] | Error): ExtensionContext {
    return {
        sessionManager: {
            getEntries() {
                if (entries instanceof Error) throw entries;
                return entries;
            },
        },
    } as unknown as ExtensionContext;
}

describe('atlasPiSubagents', () => {
    it('injects the parent orchestration skill instruction once for Atlas', async () => {
        delete process.env.PI_SUBAGENT_CHILD;
        const handler = registerHandler();
        const first = await handler(
            { systemPrompt: 'base prompt' },
            context([activeRole('atlas-orchestrator')]),
        );

        expect(first?.systemPrompt).toContain(ATLAS_PI_SUBAGENTS_MARKER);
        expect(first?.systemPrompt).toContain('pi-subagents');
        expect(first?.systemPrompt).toContain('load and follow');
        expect(first?.systemPrompt).toContain('omit `context` for `worker`');
        expect(first?.systemPrompt).toContain('`context: "fresh"`');
        expect(first?.systemPrompt).toContain('working directory');
        expect(first?.systemPrompt).toContain('plan or approved contract');
        expect(first?.systemPrompt).toContain('files or symbols');
        expect(first?.systemPrompt).toContain('validation commands');
        expect(first?.systemPrompt).toContain('latest returned `runId`');
        expect(first?.systemPrompt).toContain('two retained resumes');
        expect(first?.systemPrompt).toContain('fresh replacement');
        expect(first?.systemPrompt).toContain('`contact_supervisor`');
        expect(first?.systemPrompt).toContain('one writer per shared worktree');
        expect(first?.systemPrompt).toContain('Synthesize reviewer findings');

        const second = await handler(
            { systemPrompt: first!.systemPrompt },
            context([activeRole('atlas-orchestrator')]),
        );
        expect(second?.systemPrompt).toBe(first!.systemPrompt);
    });

    it('does not inject outside the active parent Atlas role', async () => {
        const handler = registerHandler();

        expect(
            await handler(
                { systemPrompt: 'base prompt' },
                context([activeRole('pi-agent')]),
            ),
        ).toEqual({ systemPrompt: 'base prompt' });
        expect(
            await handler({ systemPrompt: 'base prompt' }, context([])),
        ).toEqual({ systemPrompt: 'base prompt' });
        expect(
            await handler(
                { systemPrompt: 'base prompt' },
                context(new Error('unavailable')),
            ),
        ).toEqual({ systemPrompt: 'base prompt' });

        process.env.PI_SUBAGENT_CHILD = '1';
        expect(
            await handler(
                { systemPrompt: 'base prompt' },
                context([activeRole('atlas-orchestrator')]),
            ),
        ).toEqual({ systemPrompt: 'base prompt' });
    });
});