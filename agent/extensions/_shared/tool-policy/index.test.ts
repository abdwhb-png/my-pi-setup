import { describe, expect, test } from 'bun:test';
import { createToolPolicyCoordinator, type PolicyConfiguration } from './index.ts';

function fixture(config: Partial<PolicyConfiguration> = {}) {
    let active = ['read', 'edit', 'bash'];
    let registered = ['read', 'edit', 'write', 'bash', 'safe_bash', 'herdr', 'think'];
    const policy = createToolPolicyCoordinator();
    const writes: string[][] = [];
    policy.bind({ registered: () => registered, active: () => active, apply: names => { active = names; writes.push(names); } },
        { groups: { inspect: ['read'], implement: ['read', 'edit', 'write', 'safe_bash'] }, resolveMcp: () => [], ...config });
    policy.beginSession('first');
    policy.start();
    return { policy, writes, active: () => active, external: (names: string[]) => { active = names; }, registry: (names: string[]) => { registered = names; } };
}
const role = (mode: 'set' | 'all', toolNames: string[] = []): import('../pi-roles/index.ts').RoleToolPolicyPayload => mode === 'all'
    ? { version: 1, roleName: 'test', mode, toolNames: [] }
    : { version: 1, roleName: 'test', mode, toolNames };

describe('tool policy coordinator', () => {
    test('invalidates old session callbacks before registering the new session', () => {
        const f = fixture();
        const old = f.policy.register('previous-session', () => ({ grants: ['herdr'] }));
        f.policy.beginSession('second');
        expect(() => old.refresh()).toThrow('Stale');
    });
    test('rejects attempts to mutate the role view inside a contribution', () => {
        const f = fixture();
        f.policy.register('bad', view => { Array.prototype.push.call(view.registered, 'unexpected'); return {}; });
        expect(() => f.policy.refresh()).toThrow();
    });
    test('rebuilds all from registry, not the restricted active list', () => {
        const f = fixture();
        f.policy.setRole(role('set', ['@inspect']));
        expect(f.active()).toEqual(['read']);
        f.policy.setRole(role('all'));
        expect(f.active()).toContain('edit');
        expect(f.active()).toContain('safe_bash');
    });
    test('defaults do not widen explicit empty roles', () => {
        const f = fixture();
        f.policy.register('defaults', () => ({ defaults: ['edit'] }));
        f.policy.setRole(role('set'));
        expect(f.active()).toEqual([]);
    });
    test('explicit grants remain below both ceilings and denials', () => {
        const f = fixture({ requested: ['@implement', 'herdr'], childAllowed: ['read', 'edit', 'herdr'] });
        f.policy.register('user-entry', () => ({ grants: ['herdr', 'write'] }));
        f.policy.register('sandbox', () => ({ deny: ['edit'] }));
        f.policy.setRole(role('set', ['@implement']));
        expect(f.active()).toEqual(['read', 'herdr']);
    });
    test('restores capabilities from policy, not a remembered hidden list', () => {
        const f = fixture(); let ready = false;
        const c = f.policy.register('sandbox', () => ({ deny: ready ? [] : ['think'] }));
        f.policy.setRole(role('set', ['think', 'read']));
        expect(f.active()).toEqual(['read']);
        ready = true; c.refresh();
        expect(f.active()).toEqual(['think', 'read']);
        f.policy.setRole(role('set', ['read']));
        ready = false; c.refresh(); ready = true; c.refresh();
        expect(f.active()).toEqual(['read']);
    });
    test('observes O3 drift without adopting or repeatedly overwriting it', () => {
        const f = fixture(); f.policy.setRole(role('all'));
        const count = f.writes.length;
        f.external(['read']);
        expect(f.policy.inspect()?.externalDrift?.removed).toContain('edit');
        expect(f.writes).toHaveLength(count);
        expect(f.policy.refresh()?.externalDrift?.removed).toContain('edit');
        f.policy.refresh();
        expect(f.writes).toHaveLength(count);
        expect(f.active()).toEqual(['read']);
        f.policy.setRole(role('set', ['edit']));
        expect(f.active()).toEqual(['edit']);
    });
    test('reevaluates registry membership changes', () => {
        const f = fixture(); f.policy.setRole(role('all'));
        f.registry(['read', 'edit']); f.policy.refresh();
        expect(f.active()).toEqual(['read', 'edit']);
    });
    test('rejects mutation while evaluating a contribution', () => {
        const f = fixture(); f.policy.register('invalid', () => { f.policy.setRole(role('all')); return {}; });
        expect(() => f.policy.refresh()).toThrow('must be pure');
    });
    test('replacing a source invalidates its old callbacks', () => {
        const f = fixture(); const old = f.policy.register('a', () => ({}));
        const current = f.policy.register('a', () => ({ deny: ['bash'] }));
        old.dispose(); current.refresh();
        expect(() => old.refresh()).toThrow('Stale');
        expect(f.active()).not.toContain('bash');
    });
    test('converges when a host application invalidates synchronously', () => {
        const p = createToolPolicyCoordinator(); let active = ['read']; let once = true;
        p.bind({ registered: () => ['read', 'edit'], active: () => active, apply: names => {
            active = names;
            if (once) { once = false; p.setRole(role('set', ['read'])); }
        } }, { groups: {}, resolveMcp: () => [] });
        p.start(); p.setRole(role('all'));
        expect(active).toEqual(['read']);
    });
    test('a new session discards previous role and observed drift', () => {
        const f = fixture(); f.policy.setRole(role('set', ['edit']));
        f.policy.beginSession('second'); f.external(['read']); f.policy.start();
        expect(f.active()).toEqual(['read']);
        expect(f.policy.getRole()).toBeUndefined();
    });
});
