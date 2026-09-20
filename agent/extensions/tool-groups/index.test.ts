import { describe, expect, test, mock } from 'bun:test';
import { createToolGroupsExtension } from './index.ts';
import { getToolPolicy, registerToolPolicyContribution } from '../_shared/tool-policy/index.ts';
import { getSharedVisibilityBroker } from '../_shared/tool-groups/broker.ts';
import { TestHooks, trackPolicyCleanup } from '../_shared/testing/tool-policy-fixture.ts';
import { SUBAGENT_EXTENSION_BINDINGS_ENV, TOOL_GROUPS_REQUESTED_TOOLS_ENV } from '../_shared/tool-groups/types.ts';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

function fixture(options: { active?: string[]; registered?: string[]; groups?: Record<string, string[]>; requested?: string[]; child?: string[]; useEnv?: boolean } = {}) {
    let active = options.active ?? ['read', 'edit', 'write'];
    const registry = new Map((options.registered ?? ['read', 'edit', 'write', 'ls', 'bash', 'herdr']).map(name => [name, { name } as any]));
    const hooks = new TestHooks();
    const listeners = new Map<string, Set<(value: unknown) => void>>();
    const notify = mock();
    const ctx = { ui: { notify }, sessionManager: { getSessionId: () => hooks.sessionId } };
    const pi = {
        on: (event: string, handler: any) => hooks.set(event, handler),
        events: {
            on(name: string, fn: (value: unknown) => void) { const set = listeners.get(name) ?? new Set(); set.add(fn); listeners.set(name, set); return () => { set.delete(fn); }; },
            emit(name: string, value: unknown) { for (const fn of listeners.get(name) ?? []) fn(value); },
        },
        registerTool: (tool: any) => registry.set(tool.name, tool),
        getAllTools: () => [...registry.values()],
        getActiveTools: () => [...active],
        setActiveTools: (names: string[]) => { active = [...names]; },
    } as unknown as ExtensionAPI;
    const factory = createToolGroupsExtension(() => ({ groups: options.groups ?? {} }),
        options.useEnv ? undefined : () => options.requested,
        options.useEnv ? undefined : () => options.child ? { allowedTools: options.child } : undefined);
    factory(pi);
    trackPolicyCleanup(() => { hooks.get('session_shutdown')?.({}, ctx); });
    const start = () => hooks.get('session_start')!({}, ctx);
    const role = (names?: string[]) => pi.events.emit('pi-roles:tool-policy', { version: 1, roleName: 'fixture', mode: names === undefined ? 'all' : 'set', toolNames: names ?? [] });
    return { pi, hooks, registry, ctx, notify, start, role, active: () => active, policy: getToolPolicy() };
}

describe('tool-groups runtime owner', () => {
    test('retains the consumed CLI ceiling across owner reloads', () => {
        const key = Symbol.for('pi.tool-policy.cli-requested.v1');
        const previousRegistry = Object.getOwnPropertyDescriptor(globalThis, key);
        const before = process.env[TOOL_GROUPS_REQUESTED_TOOLS_ENV];
        try {
            process.env[TOOL_GROUPS_REQUESTED_TOOLS_ENV] = JSON.stringify(['read']);
            const first = fixture({ useEnv: true }); first.start(); first.role();
            expect(first.active()).toEqual(['read']);
            first.hooks.get('session_shutdown')!({}, first.ctx);
            expect(process.env[TOOL_GROUPS_REQUESTED_TOOLS_ENV]).toBeUndefined();
            const reloaded = fixture({ useEnv: true }); reloaded.start(); reloaded.role();
            expect(reloaded.active()).toEqual(['read']);
        } finally {
            if (before === undefined) delete process.env[TOOL_GROUPS_REQUESTED_TOOLS_ENV]; else process.env[TOOL_GROUPS_REQUESTED_TOOLS_ENV] = before;
            if (previousRegistry) Object.defineProperty(globalThis, key, previousRegistry); else Reflect.deleteProperty(globalThis, key);
        }
    });
    test('starts even with no configured groups and registers the lifecycle/gate', () => {
        const f = fixture(); f.start();
        for (const event of ['session_start', 'input', 'before_agent_start', 'tool_call']) expect(f.hooks.has(event)).toBe(true);
        expect(f.active()).toEqual(['read', 'edit', 'write']);
    });
    test('registers non-executable alias placeholders with no prompt hints', () => {
        const f = fixture({ groups: { inspect: ['read', 'ls'] } });
        const alias = f.registry.get('@inspect');
        expect(alias.parameters.type).toBe('object');
        expect(alias.promptSnippet).toBeUndefined();
        expect(alias.promptGuidelines).toBeUndefined();
        expect(() => alias.execute()).toThrow('group alias');
    });
    test('expands initial aliases once and role aliases synchronously', () => {
        const f = fixture({ active: ['@inspect', 'edit'], groups: { inspect: ['read', 'ls'] } });
        f.start(); expect(f.active()).toEqual(['read', 'ls', 'edit']);
        f.role(['@inspect']); expect(f.active()).toEqual(['read', 'ls']);
        f.role(); expect(f.active()).toEqual(['read', 'edit', 'write', 'ls', 'bash', 'herdr']);
    });
    test('preserves explicit empty roles', () => {
        const f = fixture(); f.start(); f.role([]); expect(f.active()).toEqual([]);
    });
    test('reports unknown aliases and missing top-level role tools without executing placeholders', () => {
        const f = fixture(); f.start(); f.role(['@missing', 'not_installed']);
        f.hooks.get('before_agent_start')!({}, f.ctx);
        expect(f.active()).toEqual([]);
        expect(JSON.stringify(f.notify.mock.calls)).toContain('missing');
        expect(JSON.stringify(f.notify.mock.calls)).toContain('not_installed');
    });
    test('deduplicates diagnostics until the declared policy changes', () => {
        const f = fixture(); f.start(); f.role(['@missing-a']);
        f.hooks.get('input')!({}, f.ctx); f.hooks.get('input')!({}, f.ctx);
        expect(f.notify).toHaveBeenCalledTimes(1);
        f.role(['@missing-b']); f.hooks.get('input')!({}, f.ctx);
        expect(f.notify).toHaveBeenCalledTimes(2);
    });
    test('registry changes reevaluate the policy and gate late tools', () => {
        const f = fixture(); f.start(); f.role(['read']);
        f.registry.set('late', { name: 'late' }); f.pi.setActiveTools(['read', 'late']);
        expect(f.hooks.get('input')!({}, f.ctx)).toEqual({ action: 'continue' });
        expect(f.active()).toEqual(['read']);
        expect(f.hooks.get('tool_call')!({ toolName: 'late' }, f.ctx)).toMatchObject({ block: true });
        f.role(); expect(f.active()).toContain('late');
    });
    test('observes external O3 writes without adopting them or overwriting each request', () => {
        const f = fixture(); f.start(); f.role();
        f.pi.setActiveTools(['read']);
        f.hooks.get('input')!({}, f.ctx); f.hooks.get('before_agent_start')!({}, f.ctx);
        expect(f.active()).toEqual(['read']);
        expect(f.policy.inspect()?.externalDrift?.removed).toContain('edit');
        expect(f.notify).toHaveBeenCalledTimes(1);
        f.role(['edit']); expect(f.active()).toEqual(['edit']);
    });
    test('CLI aliases and child ceilings constrain explicit grants', () => {
        const f = fixture({ groups: { inspect: ['read', 'edit', 'herdr'] }, requested: ['@inspect'], child: ['read', 'herdr'] });
        let enabled = false;
        const grant = registerToolPolicyContribution(f.pi, 'manual-entry', () => ({ grants: enabled ? ['herdr', 'write'] : [] }));
        f.start(); f.role(['read']); enabled = true; grant.refresh();
        expect(f.active()).toEqual(['read', 'herdr']);
        expect(f.hooks.get('tool_call')!({ toolName: 'write' }, f.ctx)).toMatchObject({ block: true });
        enabled = false; grant.refresh(); expect(f.active()).toEqual(['read']);
    });
    test('availability restoration uses role intent, not a filtered saved list', () => {
        const f = fixture({ requested: ['read', 'edit'] }); let ready = false;
        const c = registerToolPolicyContribution(f.pi, 'sandbox', () => ({ deny: ready ? [] : ['edit'] }));
        f.start(); f.role(['read', 'edit']); expect(f.active()).toEqual(['read']);
        ready = true; c.refresh(); expect(f.active()).toEqual(['read', 'edit']);
        f.role(['read']); ready = false; c.refresh(); ready = true; c.refresh(); expect(f.active()).toEqual(['read']);
    });
    test('malformed child environment fails closed and requested aliases are consumed', () => {
        const beforeChild = process.env[SUBAGENT_EXTENSION_BINDINGS_ENV];
        const beforeRequested = process.env[TOOL_GROUPS_REQUESTED_TOOLS_ENV];
        try {
            process.env[SUBAGENT_EXTENSION_BINDINGS_ENV] = '{bad';
            process.env[TOOL_GROUPS_REQUESTED_TOOLS_ENV] = JSON.stringify(['@inspect']);
            const f = fixture({ groups: { inspect: ['read'] }, useEnv: true }); f.start();
            expect(f.active()).toEqual([]);
            expect(process.env[TOOL_GROUPS_REQUESTED_TOOLS_ENV]).toBeUndefined();
        } finally {
            if (beforeChild === undefined) delete process.env[SUBAGENT_EXTENSION_BINDINGS_ENV]; else process.env[SUBAGENT_EXTENSION_BINDINGS_ENV] = beforeChild;
            if (beforeRequested === undefined) delete process.env[TOOL_GROUPS_REQUESTED_TOOLS_ENV]; else process.env[TOOL_GROUPS_REQUESTED_TOOLS_ENV] = beforeRequested;
        }
    });
    test('workflow lease is exclusive, masks inactive members and survives role changes until revoked', () => {
        const broker = getSharedVisibilityBroker();
        broker.registerWorkflowGroup('fixture-a', ['workflow_a']);
        broker.registerWorkflowGroup('fixture-b', ['workflow_b']);
        const f = fixture({ registered: ['read', 'edit', 'workflow_a', 'workflow_b'] }); f.start(); f.role();
        expect(f.active()).toEqual(['read', 'edit']);
        expect(broker.activateWorkflow(f.pi, 'fixture-a').ok).toBe(true);
        expect(f.active()).toEqual(['read', 'edit', 'workflow_a']);
        expect(broker.activateWorkflow(f.pi, 'fixture-b').ok).toBe(false);
        f.role(['read']); expect(f.active()).toEqual(['read', 'workflow_a']);
        broker.deactivateWorkflow(f.pi, 'fixture-a'); expect(f.active()).toEqual(['read']);
        expect(f.hooks.get('tool_call')!({ toolName: 'workflow_a' }, f.ctx)).toMatchObject({ block: true });
    });
    test('workflow activation reports the actual capped result, not an attempted merge', () => {
        const broker = getSharedVisibilityBroker();
        broker.registerWorkflowGroup('fixture-capped', ['workflow_capped']);
        const f = fixture({ registered: ['read', 'workflow_capped'], active: ['read'], child: ['read'] });
        f.start();
        expect(broker.activateWorkflow(f.pi, 'fixture-capped')).toMatchObject({ ok: true, changed: false });
        expect(f.active()).toEqual(['read']);
    });
    test('reload/startup replaces contribution handles and shutdown removes event subscriptions', () => {
        const f = fixture();
        const c = registerToolPolicyContribution(f.pi, 'reload-probe', () => ({ deny: ['edit'] }));
        f.start(); const stale = c.captureRefresh();
        f.start(); expect(() => stale()).toThrow('Stale');
        f.hooks.get('session_shutdown')!({}, f.ctx);
        expect(f.policy.inspect()).toBeUndefined();
        f.role(['edit']); expect(f.policy.getRole()).toBeUndefined();
    });
});
