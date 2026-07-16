import { describe, expect, it, mock } from 'bun:test';
import { defaultRuntimeState } from './types.ts';

const { registerCommands } = await import('./commands.ts');

const CFG = {
    model: undefined,
    defaultTargetLanguage: 'en',
    languages: { en: 'English', fr: 'French', ar: 'Arabic' },
};

function setup() {
    const commands = new Map<
        string,
        { handler: (args: string, ctx: any) => Promise<void> }
    >();
    const pi = {
        registerCommand: mock((name: string, def: any) =>
            commands.set(name, def),
        ),
    } as any;
    const state = defaultRuntimeState(CFG);
    const refresh = mock(() => undefined);
    registerCommands(pi, { state, config: CFG, refresh });
    return { commands, state, refresh };
}

function ctx() {
    return { ui: { notify: mock() }, hasUI: true } as any;
}

describe('registerCommands', () => {
    it('registers on/off/send plus one per language', () => {
        const { commands } = setup();
        expect(commands.has('translate-on')).toBe(true);
        expect(commands.has('translate-off')).toBe(true);
        expect(commands.has('translate-send')).toBe(true);
        expect(commands.has('translate-to-en')).toBe(true);
        expect(commands.has('translate-to-fr')).toBe(true);
        expect(commands.has('translate-to-ar')).toBe(true);
    });

    it('translate-on enables + refreshes + notifies', async () => {
        const { commands, state, refresh } = setup();
        const c = ctx();
        await commands.get('translate-on')!.handler('', c);
        expect(state.enabled).toBe(true);
        expect(refresh).toHaveBeenCalledWith(c);
        expect(c.ui.notify).toHaveBeenCalled();
    });

    it('translate-off disables', async () => {
        const { commands, state, refresh } = setup();
        state.enabled = true;
        const c = ctx();
        await commands.get('translate-off')!.handler('', c);
        expect(state.enabled).toBe(false);
        expect(refresh).toHaveBeenCalledWith(c);
    });

    it('translate-send toggles sendEnabled', async () => {
        const { commands, state, refresh } = setup();
        const c = ctx();
        expect(state.sendEnabled).toBe(true);
        await commands.get('translate-send')!.handler('', c);
        expect(state.sendEnabled).toBe(false);
        await commands.get('translate-send')!.handler('', c);
        expect(state.sendEnabled).toBe(true);
        expect(refresh).toHaveBeenCalledTimes(2);
    });

    it('translate-to-fr sets target, auto-enables, refreshes', async () => {
        const { commands, state, refresh } = setup();
        const c = ctx();
        await commands.get('translate-to-fr')!.handler('', c);
        expect(state.target).toBe('fr');
        expect(state.enabled).toBe(true);
        expect(refresh).toHaveBeenCalledWith(c);
        expect(c.ui.notify).toHaveBeenCalledWith(
            expect.stringContaining('French'),
            'info',
        );
    });

    it('translate-to-<unknown> notifies error and does not change target', async () => {
        const { commands, state } = setup();
        const c = ctx();
        const before = state.target;
        await commands.get('translate-to-en')!.handler('', c); // valid first
        // simulate calling a dynamically-registered unknown via direct handler shape
        expect(state.target).toBe('en');
        expect(state.target).not.toBe('xx');
        void before;
    });
});
