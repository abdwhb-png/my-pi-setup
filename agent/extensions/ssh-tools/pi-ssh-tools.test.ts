import { describe, expect, it } from "bun:test";
import { TestHooks, mountPolicy } from '../__tests__/policy-fixture.ts';

function createExtensionApi() {
    const tools: string[] = [];

    return {
        api: {
            getActiveTools: () => [],
            on: () => undefined,
            registerCommand: () => undefined,
            registerTool: ({ name }: { name: string }) => tools.push(name),
            setActiveTools: () => undefined,
        },
        tools,
    };
}

describe("pi-ssh-tools", () => {
    it('activates and revokes SSH under an explicit role without retaining an old-session activation', async () => {
        const { default: extension } = await import('./pi-ssh-tools.ts');
        const hooks = new TestHooks();
        const commands = new Map<string, any>();
        const registered = ['read'];
        let active = ['read'];
        const pi = { on: (event: string, fn: any) => hooks.set(event, fn),
            registerTool: (tool: { name: string }) => registered.push(tool.name),
            registerCommand: (name: string, command: any) => commands.set(name, command),
            getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; },
        };
        const policy = mountPolicy({ registered: () => registered, active: pi.getActiveTools, apply: pi.setActiveTools }, hooks);
        extension(pi as never);
        const ctx = { ui: { setStatus() {}, notify() {}, theme: { fg: (_color: string, text: string) => text } } };
        hooks.get('session_start')!({}, ctx);
        policy.setRole({ version: 1, roleName: 'inspect', mode: 'set', toolNames: ['read'] });
        await commands.get('ssh').handler('fixture:/repo', ctx); // Explicit cwd avoids SSH I/O.
        expect(active).toContain('ssh_read');
        await commands.get('ssh').handler('off', ctx);
        expect(active).toEqual(['read']);
        const pending = commands.get('ssh').handler('fixture:/repo', ctx);
        hooks.get('session_start')!({}, ctx);
        await expect(pending).rejects.toThrow('Stale');
        expect(active).toEqual(['read']);
    });
    it("registers SSH tools", async () => {
        const { default: sshToolsExtension } = await import("./pi-ssh-tools.ts");
        const { api, tools } = createExtensionApi();

        sshToolsExtension(api as never);

        expect(tools).toEqual(["ssh_read", "ssh_write", "ssh_edit", "ssh_bash"]);
    }, 15_000);
});
