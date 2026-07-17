import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
    ExtensionAPI,
    ExtensionContext,
} from '@earendil-works/pi-coding-agent';

let tempDir: string;
let roleDir: string;

type ToolCallResult = { block?: boolean; reason?: string } | undefined;

interface TestHandlers {
    toolCall: (event: {
        toolName: string;
        input: Record<string, unknown>;
    }) => Promise<ToolCallResult>;
}

function createRoleFile(
    dir: string,
    filename: string,
    frontmatter: Record<string, string>,
): string {
    const path = join(dir, filename);
    const lines = Object.entries(frontmatter).map(([k, v]) => `${k}: ${v}`);
    writeFileSync(path, `---\n${lines.join('\n')}\n---\n\nRole body.`, 'utf-8');
    return path;
}

function makeActiveRoleEntry(
    name: string,
    path: string,
): { type: string; customType?: string; data?: unknown } {
    return {
        type: 'custom',
        customType: 'pi-roles:active-role',
        data: {
            name,
            source: 'user',
            path,
            appliedAt: Date.now(),
        },
    };
}

function createMockAPI(): { pi: ExtensionAPI; handlers: TestHandlers } {
    const handlerMap = new Map<
        string,
        (event: object, ctx: object) => Promise<unknown>
    >();

    const pi = {
        on: (
            event: string,
            handler: (event: object, ctx: object) => Promise<unknown>,
        ) => {
            handlerMap.set(event, handler);
        },
    } as unknown as ExtensionAPI;

    return {
        pi,
        handlers: {
            toolCall: async (event) => {
                const h = handlerMap.get('tool_call');
                if (!h) throw new Error('tool_call handler not registered');
                const result = await h(event, {} as ExtensionContext);
                return result as ToolCallResult;
            },
        },
    };
}

function createMockContext(
    entries: Array<{ type: string; customType?: string; data?: unknown }>,
): ExtensionContext {
    return {
        sessionManager: {
            getEntries: () => entries,
        },
    } as unknown as ExtensionContext;
}

beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'pi-role-subagents-'));
    roleDir = join(tempDir, 'roles');
    mkdirSync(roleDir);
});

afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
});

describe('roleSubagents', () => {
    async function loadExtension() {
        const mod = await import('./role-subagents.ts');
        return mod.default as (pi: ExtensionAPI) => void;
    }

    it('allows a subagent listed in the role frontmatter', async () => {
        const rolePath = createRoleFile(roleDir, 'builder.md', {
            name: 'builder',
            subagents: 'worker, scout',
            thinking: 'high',
        });

        const entries = [makeActiveRoleEntry('builder', rolePath)];
        const ctx = createMockContext(entries);
        const { pi, handlers: _handlers } = createMockAPI();

        const roleSubagents = await loadExtension();
        roleSubagents(pi);

        // Re-register with our ctx
        const handlerMap = new Map<
            string,
            (event: object, ctx: object) => Promise<unknown>
        >();
        (pi as any).on = (
            event: string,
            handler: (event: object, ctx: object) => Promise<unknown>,
        ) => {
            handlerMap.set(event, handler);
        };
        roleSubagents(pi);

        const h = handlerMap.get('tool_call')!;
        const result = (await h(
            {
                toolName: 'subagent',
                input: { agent: 'worker', task: 'do stuff' },
            },
            ctx,
        )) as ToolCallResult;

        expect(result).toBeUndefined();
    });

    it('blocks a subagent NOT in the role frontmatter', async () => {
        const rolePath = createRoleFile(roleDir, 'builder.md', {
            name: 'builder',
            subagents: 'worker, scout',
            thinking: 'high',
        });

        const entries = [makeActiveRoleEntry('builder', rolePath)];
        const ctx = createMockContext(entries);
        const { pi } = createMockAPI();

        const roleSubagents = await loadExtension();
        roleSubagents(pi);

        const handlerMap = new Map<
            string,
            (event: object, ctx: object) => Promise<unknown>
        >();
        (pi as any).on = (
            event: string,
            handler: (event: object, ctx: object) => Promise<unknown>,
        ) => {
            handlerMap.set(event, handler);
        };
        roleSubagents(pi);

        const h = handlerMap.get('tool_call')!;
        const result = (await h(
            {
                toolName: 'subagent',
                input: { agent: 'reviewer', task: 'review this' },
            },
            ctx,
        )) as ToolCallResult;

        expect(result).not.toBeUndefined();
        expect(result!.block).toBe(true);
        expect(result!.reason).toContain('builder');
        expect(result!.reason).toContain('worker, scout');
        expect(result!.reason).toContain('reviewer');
    });

    it('allows any subagent when role has no subagents frontmatter', async () => {
        const rolePath = createRoleFile(roleDir, 'open-role.md', {
            name: 'open-role',
            thinking: 'medium',
        });

        const entries = [makeActiveRoleEntry('open-role', rolePath)];
        const ctx = createMockContext(entries);
        const { pi } = createMockAPI();

        const roleSubagents = await loadExtension();
        roleSubagents(pi);

        const handlerMap = new Map<
            string,
            (event: object, ctx: object) => Promise<unknown>
        >();
        (pi as any).on = (
            event: string,
            handler: (event: object, ctx: object) => Promise<unknown>,
        ) => {
            handlerMap.set(event, handler);
        };
        roleSubagents(pi);

        const h = handlerMap.get('tool_call')!;
        const result = (await h(
            {
                toolName: 'subagent',
                input: { agent: 'any-agent', task: 'anything' },
            },
            ctx,
        )) as ToolCallResult;

        expect(result).toBeUndefined();
    });

    it('allows any subagent when no active role', async () => {
        const ctx = createMockContext([]);
        const { pi } = createMockAPI();

        const roleSubagents = await loadExtension();
        roleSubagents(pi);

        const handlerMap = new Map<
            string,
            (event: object, ctx: object) => Promise<unknown>
        >();
        (pi as any).on = (
            event: string,
            handler: (event: object, ctx: object) => Promise<unknown>,
        ) => {
            handlerMap.set(event, handler);
        };
        roleSubagents(pi);

        const h = handlerMap.get('tool_call')!;
        const result = (await h(
            { toolName: 'subagent', input: { agent: 'worker' } },
            ctx,
        )) as ToolCallResult;

        expect(result).toBeUndefined();
    });

    it('does not intercept non-subagent tool calls', async () => {
        const rolePath = createRoleFile(roleDir, 'restrictive.md', {
            name: 'restrictive',
            subagents: 'worker',
        });

        const entries = [makeActiveRoleEntry('restrictive', rolePath)];
        const ctx = createMockContext(entries);
        const { pi } = createMockAPI();

        const roleSubagents = await loadExtension();
        roleSubagents(pi);

        const handlerMap = new Map<
            string,
            (event: object, ctx: object) => Promise<unknown>
        >();
        (pi as any).on = (
            event: string,
            handler: (event: object, ctx: object) => Promise<unknown>,
        ) => {
            handlerMap.set(event, handler);
        };
        roleSubagents(pi);

        const h = handlerMap.get('tool_call')!;
        const result = (await h(
            { toolName: 'bash', input: { command: 'echo hello' } },
            ctx,
        )) as ToolCallResult;

        expect(result).toBeUndefined();
    });

    it('does not block when agent param is missing', async () => {
        const rolePath = createRoleFile(roleDir, 'restrictive.md', {
            name: 'restrictive',
            subagents: 'worker',
        });

        const entries = [makeActiveRoleEntry('restrictive', rolePath)];
        const ctx = createMockContext(entries);
        const { pi } = createMockAPI();

        const roleSubagents = await loadExtension();
        roleSubagents(pi);

        const handlerMap = new Map<
            string,
            (event: object, ctx: object) => Promise<unknown>
        >();
        (pi as any).on = (
            event: string,
            handler: (event: object, ctx: object) => Promise<unknown>,
        ) => {
            handlerMap.set(event, handler);
        };
        roleSubagents(pi);

        const h = handlerMap.get('tool_call')!;
        const result = (await h(
            { toolName: 'subagent', input: { action: 'list' } },
            ctx,
        )) as ToolCallResult;

        expect(result).toBeUndefined();
    });

    it('caches role frontmatter (no re-read when role path unchanged)', async () => {
        const rolePath = createRoleFile(roleDir, 'builder.md', {
            name: 'builder',
            subagents: 'worker',
        });

        const entries = [makeActiveRoleEntry('builder', rolePath)];
        const ctx = createMockContext(entries);

        const roleSubagents = await loadExtension();

        const { pi } = createMockAPI();
        roleSubagents(pi);

        const handlerMap = new Map<
            string,
            (event: object, ctx: object) => Promise<unknown>
        >();
        (pi as any).on = (
            event: string,
            handler: (event: object, ctx: object) => Promise<unknown>,
        ) => {
            handlerMap.set(event, handler);
        };
        roleSubagents(pi);

        const h = handlerMap.get('tool_call')!;

        // First call — should read and cache
        await h({ toolName: 'subagent', input: { agent: 'worker' } }, ctx);

        // Modify the file content (changing subagents)
        writeFileSync(
            rolePath,
            `---
name: builder
subagents: reviewer
---
Body.`,
            'utf-8',
        );

        // Second call — should use CACHED value (worker still allowed, reviewer blocked)
        const result = (await h(
            { toolName: 'subagent', input: { agent: 'reviewer' } },
            ctx,
        )) as ToolCallResult;

        // Cache prevents re-read, so reviewer is still blocked
        expect(result).not.toBeUndefined();
        expect(result!.block).toBe(true);
        expect(result!.reason).toContain('worker');
    });
});
