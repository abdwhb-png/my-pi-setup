import { expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

mock.module('@plannotator/pi-extension/config.js', () => ({
    loadPlannotatorConfig: () => ({ config: {} }),
    resolvePlanFileDir: () => 'docs/plans',
}));
mock.module('./plan-auto-switch.ts', () => ({ default: () => undefined }));
mock.module('./prompt-role-switch.ts', () => ({ default: () => undefined }));
mock.module('./role-subagents.ts', () => ({ default: () => undefined }));

test('pi-roles addons registers no tools owned by pi-scoped-write', async () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('write_plan');
    expect(source).not.toContain('edit_plan');

    const registered = new Map<string, { execute: Function }>();
    const pi = {
        on: () => undefined,
        registerTool: (tool: { name: string; execute: Function }) => registered.set(tool.name, tool),
    } as unknown as ExtensionAPI;
    const { default: registerAddons } = await import('./index.ts');

    registerAddons(pi);

    expect([...registered.keys()]).not.toEqual(
        expect.arrayContaining([
            'write_plan',
            'edit_plan',
            'write_report',
            'edit_report',
            'artifacts_purge',
        ]),
    );
});
