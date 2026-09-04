import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import type {
    ExtensionAPI,
    SlashCommandInfo,
} from '@earendil-works/pi-coding-agent';
import { Container, Text } from '@earendil-works/pi-tui';
import {
    resetAuditState,
    setActiveProfile,
} from '../_shared/audit-mode/audit-state';
import {
    isMarkdownLinkTransformRequest,
    MARKDOWN_LINKS_TRANSFORM_EVENT,
} from '../_shared/markdown-links.ts';

const {
    createFindToolDefinition,
    createGrepToolDefinition,
    createLsToolDefinition,
    createReadToolDefinition,
} = await import('@earendil-works/pi-coding-agent');
const settingsManagerCreate = mock(() => ({
    getGlobalSettings: () => ({}),
    getProjectSettings: () => ({}),
}));

// Register before loading index.ts so config.ts never reads real settings.json.
void mock.module('@earendil-works/pi-coding-agent', () => ({
    createFindToolDefinition,
    createGrepToolDefinition,
    createLsToolDefinition,
    createReadToolDefinition,
    getAgentDir: () => '/tmp/pi-agent',
    SettingsManager: {
        create: settingsManagerCreate,
        inMemory: (data: unknown) => ({
            getGlobalSettings: () => data,
            getProjectSettings: () => data,
        }),
    },
}));

const {
    default: piOverrides,
    auditAwareLsOperations,
    auditAwareFindOperations,
} = await import('./index');

function createMockTheme() {
    return {
        fg: (_color: string, text: string) => text,
        bold: (text: string) => text,
    };
}

function createMockExtensionApi(
    initialSessionName?: string,
    commands?: SlashCommandInfo[],
) {
    const handlers = new Map<
        string,
        (event: object, ctx: object) => Promise<unknown> | unknown
    >();
    const registeredTools = new Map<
        string,
        {
            name: string;
            renderResult?: (
                ...args: [object, object, object, object]
            ) => object;
        }
    >();
    const registeredCommands = new Map<
        string,
        {
            handler?: (
                args: string,
                ctx: object,
            ) => Promise<unknown> | unknown;
        }
    >();
    let activeTools: string[] = ['read', 'bash', 'edit', 'write'];
    let sessionName = initialSessionName;
    const eventHandlers = new Map<string, Set<(value: unknown) => void>>();
    const events = {
        emit(channel: string, value: unknown) {
            for (const handler of eventHandlers.get(channel) ?? []) handler(value);
        },
        on(channel: string, handler: (value: unknown) => void) {
            const registered = eventHandlers.get(channel) ?? new Set();
            registered.add(handler);
            eventHandlers.set(channel, registered);
            return () => registered.delete(handler);
        },
    };
    const pi = {
        events,
        on(
            event: string,
            handler: (event: object, ctx: object) => Promise<unknown> | unknown,
        ) {
            handlers.set(event, (value, ctx) =>
                handler(value, {
                    sessionManager: { getEntries: () => [] },
                    ...ctx,
                }),
            );
        },
        registerTool(tool: {
            name: string;
            renderResult?: (
                ...args: [object, object, object, object]
            ) => object;
        }) {
            registeredTools.set(tool.name, tool);
        },
        getActiveTools: () => activeTools,
        setActiveTools: (tools: string[]) => {
            activeTools = tools;
        },
        getSessionName: () => sessionName,
        setSessionName: (name: string) => {
            sessionName = name;
        },
        getCommands: () => commands ?? [],
        setThinkingLevel: mock(() => undefined),
        registerCommand: mock(
            (
                name: string,
                command: {
                    handler?: (
                        args: string,
                        ctx: object,
                    ) => Promise<unknown> | unknown;
                },
            ) => registeredCommands.set(name, command),
        ),
        sendMessage: mock(() => undefined),
    } as unknown as ExtensionAPI;
    return {
        pi,
        handlers,
        registeredCommands,
        registeredTools,
        getActiveTools: () => activeTools,
        getSessionName: () => sessionName,
    };
}

describe('pi-overrides', () => {
    beforeEach(() => {
        resetAuditState('standard');
        settingsManagerCreate.mockClear();
    });

    afterEach(() => {
        resetAuditState('standard');
    });

    it('registers read grep ls find and augments active toolset', async () => {
        const { pi, handlers, registeredTools, getActiveTools } =
            createMockExtensionApi();
        piOverrides(pi);
        expect(getActiveTools()).toEqual(['read', 'bash', 'edit', 'write']);
        await handlers.get('session_start')?.(
            {},
            { cwd: '~/.pi/agent' },
        );
        expect(Array.from(registeredTools.keys()).toSorted()).toEqual([
            'find',
            'grep',
            'ls',
            'read',
        ]);
        expect(getActiveTools()).toContain('grep');
        expect(getActiveTools()).toContain('find');
        expect(getActiveTools()).toContain('ls');
        expect(getActiveTools()).toContain('read');
        expect(getActiveTools()).toContain('bash');
        expect(getActiveTools()).toContain('edit');
        expect(getActiveTools()).toContain('write');
        expect(settingsManagerCreate).toHaveBeenCalledWith(
            '~/.pi/agent',
            '/tmp/pi-agent',
        );
    });

    it('transforms a rescued BOM skill slash command before Pi core expansion', async () => {
        const root = await mkdtemp(nodePath.join(tmpdir(), 'pi-overrides-skill-'));
        try {
            const skillDir = nodePath.join(root, '.agents', 'skills', 'bom-skill');
            await mkdir(skillDir, { recursive: true });
            await writeFile(
                nodePath.join(skillDir, 'SKILL.md'),
                '\uFEFF---\nname: bom-skill\ndescription: Rescued skill\n---\n\n# Instructions\n',
            );

            const { pi, handlers } = createMockExtensionApi();
            piOverrides(pi);
            await handlers.get('session_start')?.(
                {},
                {
                    cwd: root,
                    hasUI: false,
                    isProjectTrusted: () => true,
                },
            );
            const input = handlers.get('input');
            if (!input) throw new Error('input handler not registered');

            const result = await input(
                { text: '/skill:bom-skill Apply it now', source: 'user' },
                {},
            );

            expect(result).toEqual({
                action: 'transform',
                text: `<skill name="bom-skill" location="${nodePath.join(skillDir, 'SKILL.md')}">\nReferences are relative to ${skillDir}.\n\n# Instructions\n</skill>\n\nApply it now`,
            });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('returns normalized rescued content when load_skill misses a BOM skill', async () => {
        const root = await mkdtemp(nodePath.join(tmpdir(), 'pi-overrides-skill-'));
        try {
            const skillDir = nodePath.join(root, '.agents', 'skills', 'bom-skill');
            await mkdir(skillDir, { recursive: true });
            const skillPath = nodePath.join(skillDir, 'SKILL.md');
            await writeFile(
                skillPath,
                '\uFEFF---\nname: bom-skill\ndescription: Rescued skill\n---\n\n# Instructions\n\nRead [guide](guide.md).\n',
            );

            const { pi, handlers } = createMockExtensionApi();
            pi.events.on(MARKDOWN_LINKS_TRANSFORM_EVENT, (value) => {
                if (!isMarkdownLinkTransformRequest(value)) return;
                expect(value.sourcePath).toBe(skillPath);
                expect(value.sourceKind).toBe('bom-skill-fallback');
                value.result = value.content.replace(
                    'guide.md',
                    nodePath.join(skillDir, 'guide.md'),
                );
            });
            piOverrides(pi);
            await handlers.get('session_start')?.(
                {},
                { cwd: root, hasUI: false, isProjectTrusted: () => true },
            );
            const toolResult = handlers.get('tool_result');
            if (!toolResult) throw new Error('tool_result handler not registered');

            const result = await toolResult(
                {
                    toolName: 'load_skill',
                    input: { name: 'bom-skill' },
                    content: [
                        {
                            type: 'text',
                            text: 'Skill "bom-skill" not found. Use search_skill to discover available skills.',
                        },
                    ],
                    details: undefined,
                    isError: false,
                },
                {},
            );

            expect(result).toEqual({
                content: [
                    {
                        type: 'text',
                        text: `---\nname: bom-skill\ndescription: Rescued skill\n---\n\n# Instructions\n\nRead [guide](${nodePath.join(skillDir, 'guide.md')}).\n`,
                    },
                ],
                details: undefined,
                isError: false,
            });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('adds rescued BOM skills to search_skill results', async () => {
        const root = await mkdtemp(nodePath.join(tmpdir(), 'pi-overrides-skill-'));
        try {
            const skillDir = nodePath.join(root, '.agents', 'skills', 'bom-skill');
            await mkdir(skillDir, { recursive: true });
            await writeFile(
                nodePath.join(skillDir, 'SKILL.md'),
                '\uFEFF---\nname: bom-skill\ndescription: Rescued skill\n---\n\n# Instructions\n',
            );

            const { pi, handlers } = createMockExtensionApi();
            piOverrides(pi);
            await handlers.get('session_start')?.(
                {},
                { cwd: root, hasUI: false, isProjectTrusted: () => true },
            );
            const toolResult = handlers.get('tool_result');
            if (!toolResult) throw new Error('tool_result handler not registered');

            const result = await toolResult(
                {
                    toolName: 'search_skill',
                    input: { query: 'bom' },
                    content: [
                        {
                            type: 'text',
                            text: 'No skills found matching your query. Try a different search term.',
                        },
                    ],
                    details: undefined,
                    isError: false,
                },
                {},
            );

            expect(result).toEqual({
                content: [
                    {
                        type: 'text',
                        text: 'Found 1 BOM-normalized fallback skill(s) matching "bom":\n\n  • bom-skill\n    Rescued skill\n\nUse load_skill("bom-skill") to load its full instructions.',
                    },
                ],
                details: undefined,
                isError: false,
            });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('advertises rescued skills to the model before an agent starts', async () => {
        const root = await mkdtemp(nodePath.join(tmpdir(), 'pi-overrides-skill-'));
        try {
            const skillDir = nodePath.join(root, '.agents', 'skills', 'bom-skill');
            await mkdir(skillDir, { recursive: true });
            await writeFile(
                nodePath.join(skillDir, 'SKILL.md'),
                '\uFEFF---\nname: bom-skill\ndescription: Rescued skill\n---\n\n# Instructions\n',
            );

            const { pi, handlers } = createMockExtensionApi();
            piOverrides(pi);
            await handlers.get('session_start')?.(
                {},
                { cwd: root, hasUI: false, isProjectTrusted: () => true },
            );
            const beforeAgentStart = handlers.get('before_agent_start');
            if (!beforeAgentStart)
                throw new Error('before_agent_start handler not registered');

            const result = await beforeAgentStart(
                { systemPrompt: 'Base prompt' },
                {},
            );

            expect(result).toEqual({
                systemPrompt:
                    'Base prompt\n\n## BOM-normalized fallback skills\n- `bom-skill`: Rescued skill\n  Load full instructions with `load_skill`.',
            });
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('names an unnamed session from a skill-prefixed user message', async () => {
        const { pi, handlers, getSessionName } = createMockExtensionApi();
        piOverrides(pi);
        const handler = handlers.get('message_end');
        if (!handler) throw new Error('message_end handler not registered');

        await handler(
            {
                message: {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: '<skill name="diagnose" location="/skills/diagnose/SKILL.md">instructions</skill>\n\nInvestigate color',
                        },
                    ],
                },
            },
            {},
        );

        expect(getSessionName()).toBe('/skill:diagnose Investigate color');
    });

    it('preserves an existing explicit session name', async () => {
        const { pi, handlers, getSessionName } =
            createMockExtensionApi('custom name');
        piOverrides(pi);
        const handler = handlers.get('message_end');
        if (!handler) throw new Error('message_end handler not registered');

        await handler(
            {
                message: {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: '<skill name="diagnose" location="/skills/diagnose/SKILL.md">instructions</skill>\n\nInvestigate color',
                        },
                    ],
                },
            },
            {},
        );

        expect(getSessionName()).toBe('custom name');
    });

    it('combines user text blocks before deriving the name', async () => {
        const { pi, handlers, getSessionName } = createMockExtensionApi();
        piOverrides(pi);
        const handler = handlers.get('message_end');
        if (!handler) throw new Error('message_end handler not registered');

        await handler(
            {
                message: {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: '<skill name="diagnose" location="/skills/diagnose/SKILL.md">instructions</skill>',
                        },
                        { type: 'text', text: 'Investigate color' },
                    ],
                },
            },
            {},
        );

        expect(getSessionName()).toBe('/skill:diagnose Investigate color');
    });

    it('does not name a session from a skill after the first user message', async () => {
        const { pi, handlers, getSessionName } = createMockExtensionApi();
        piOverrides(pi);
        const handler = handlers.get('message_end');
        if (!handler) throw new Error('message_end handler not registered');

        await handler(
            { message: { role: 'user', content: 'Ordinary first message' } },
            {},
        );
        expect(getSessionName()).toBeUndefined();

        await handler(
            {
                message: {
                    role: 'user',
                    content:
                        '<skill name="tdd" location="/skills/tdd/SKILL.md">instructions</skill>\n\nFix login',
                },
            },
            {},
        );

        expect(getSessionName()).toBeUndefined();
    });

    it('compacts a skill-expanded user message after tree navigation', async () => {
        const { pi, handlers } = createMockExtensionApi();
        piOverrides(pi);
        const beforeTree = handlers.get('session_before_tree');
        const sessionTree = handlers.get('session_tree');
        if (!beforeTree || !sessionTree) {
            throw new Error('tree lifecycle handlers not registered');
        }
        const setEditorText = mock(() => undefined);
        const skillMessage = {
            type: 'message',
            message: {
                role: 'user',
                content:
                    '<skill name="diagnose" location="/skills/diagnose/SKILL.md">instructions</skill>\n\nInvestigate color',
            },
        };

        await beforeTree(
            { preparation: { targetId: 'skill-message' } },
            {
                sessionManager: {
                    getEntry: (entryId: string) =>
                        entryId === 'skill-message' ? skillMessage : undefined,
                },
            },
        );
        await sessionTree({}, { hasUI: true, ui: { setEditorText } });

        expect(setEditorText).toHaveBeenCalledWith(
            '/skill:diagnose Investigate color',
        );
    });

    it('does not name a resumed session from a later skill message', async () => {
        const { pi, handlers, getSessionName } = createMockExtensionApi();
        piOverrides(pi);
        const sessionStart = handlers.get('session_start');
        const messageEnd = handlers.get('message_end');
        if (!sessionStart) throw new Error('session_start not registered');
        if (!messageEnd) throw new Error('message_end not registered');

        await sessionStart(
            {},
            {
                cwd: '/tmp',
                sessionManager: {
                    getEntries: () => [
                        {
                            type: 'message',
                            message: {
                                role: 'user',
                                content: 'Ordinary first message',
                            },
                        },
                    ],
                },
            },
        );
        await messageEnd(
            {
                message: {
                    role: 'user',
                    content:
                        '<skill name="tdd" location="/skills/tdd/SKILL.md">instructions</skill>\n\nFix login',
                },
            },
            {},
        );

        expect(getSessionName()).toBeUndefined();
    });

    it.each(['assistant', 'toolResult', 'custom'])(
        'ignores %s messages',
        async (role) => {
            const { pi, handlers, getSessionName } = createMockExtensionApi();
            piOverrides(pi);
            const handler = handlers.get('message_end');
            if (!handler) throw new Error('message_end handler not registered');

            await handler(
                {
                    message: {
                        role,
                        content:
                            '<skill name="diagnose">instructions</skill>\n\nInvestigate color',
                    },
                },
                {},
            );

            expect(getSessionName()).toBeUndefined();
        },
    );

    it('does not mutate the original user message', async () => {
        const { pi, handlers } = createMockExtensionApi();
        piOverrides(pi);
        const handler = handlers.get('message_end');
        if (!handler) throw new Error('message_end handler not registered');
        const message = {
            role: 'user',
            content: [
                {
                    type: 'text',
                    text: '<skill name="diagnose">instructions</skill>\n\nInvestigate color',
                },
            ],
        };
        const original = structuredClone(message);

        await handler({ message }, {});

        expect(message).toEqual(original);
    });

    it('wraps read renderResult with compression footer when compression details exist', async () => {
        const { pi, handlers, registeredTools } = createMockExtensionApi();
        piOverrides(pi);
        await handlers.get('session_start')?.(
            {},
            { cwd: '~/.pi/agent' },
        );
        const readTool = registeredTools.get('read');
        if (!readTool?.renderResult)
            throw new Error('read tool not registered');

        const component = readTool.renderResult(
            {
                content: [{ type: 'text', text: 'hello' }],
                details: {
                    compression: {
                        originalLength: 100,
                        compressedLength: 40,
                        savedBytes: 60,
                        savedPct: 60,
                    },
                },
                isError: false,
            },
            { expanded: false, isPartial: false },
            createMockTheme(),
            {
                args: { path: '/tmp/x' },
                toolCallId: '1',
                invalidate() {},
                lastComponent: undefined,
                state: {},
                cwd: '/tmp',
                executionStarted: false,
                argsComplete: true,
                isPartial: false,
                expanded: false,
                showImages: true,
                isError: false,
            },
        );

        expect(
            component instanceof Container || component instanceof Text,
        ).toBe(true);
        expect(component).toBeInstanceOf(Container);
    });

    // ─── Audit-aware ls operations (unit-level) ──────────────────────────────
    //
    // Tests call auditAwareLsOperations.readdir() directly so we exercise the
    // real filtering logic without going through the tool factory. /tmp is a
    // reliable choice because it always contains dotfiles (.ICE-unix, .config,
    // .X11-unix, etc.) on Linux.

    describe('auditAwareLsOperations.readdir', () => {
        it('hides dotfiles in standard mode', async () => {
            resetAuditState('standard');
            const entries = await auditAwareLsOperations.readdir('/tmp');
            expect(entries.length).toBeGreaterThan(0);
            const dotEntries = entries.filter((e) => e.startsWith('.'));
            expect(dotEntries).toEqual([]);
        });

        it('shows dotfiles in audit mode', async () => {
            setActiveProfile('audit');
            const entries = await auditAwareLsOperations.readdir('/tmp');
            const dotEntries = entries.filter((e) => e.startsWith('.'));
            expect(dotEntries.length).toBeGreaterThan(0);
        });

        it('shows dotfiles in advanced mode', async () => {
            setActiveProfile('advanced');
            const entries = await auditAwareLsOperations.readdir('/tmp');
            const dotEntries = entries.filter((e) => e.startsWith('.'));
            expect(dotEntries.length).toBeGreaterThan(0);
        });

        it('standard mode hides dots that audit mode reveals — same directory, different policy', async () => {
            // Core behavioral contract: same directory, different results per profile.
            setActiveProfile('audit');
            const auditEntries = await auditAwareLsOperations.readdir('/tmp');
            const auditDots = auditEntries.filter((e) => e.startsWith('.'));

            resetAuditState('standard');
            const standardEntries =
                await auditAwareLsOperations.readdir('/tmp');
            const standardDots = standardEntries.filter((e) =>
                e.startsWith('.'),
            );

            expect(auditDots.length).toBeGreaterThan(0);
            expect(standardDots.length).toBe(0);
        });
    });

    // ─── ls integration: tool execute reflects the active policy ─────────────────

    describe('ls audit-mode: listing.showHidden via tool execute', () => {
        it('filters dotfiles from ls results in standard mode', async () => {
            resetAuditState('standard');
            const { pi, handlers, registeredTools } = createMockExtensionApi();
            piOverrides(pi);
            await handlers.get('session_start')?.({}, { cwd: '/tmp' });

            const lsTool = registeredTools.get('ls') as {
                execute?: (
                    id: string,
                    args: object,
                    signal: AbortSignal,
                ) => Promise<{
                    content: Array<{ type: string; text: string }>;
                }>;
            };
            if (!lsTool?.execute)
                throw new Error('ls tool execute not present');

            const result = await lsTool.execute(
                'call1',
                { path: '/tmp' },
                new AbortController().signal,
            );
            const text =
                result.content.find((c) => c.type === 'text')?.text ?? '';
            const lines = text.split('\n').filter(Boolean);
            expect(lines.every((l) => !l.startsWith('.'))).toBe(true);
        });

        it('includes dotfiles in ls results in audit mode', async () => {
            setActiveProfile('audit');
            const { pi, handlers, registeredTools } = createMockExtensionApi();
            piOverrides(pi);
            await handlers.get('session_start')?.({}, { cwd: '/tmp' });

            const lsTool = registeredTools.get('ls') as {
                execute?: (
                    id: string,
                    args: object,
                    signal: AbortSignal,
                ) => Promise<{
                    content: Array<{ type: string; text: string }>;
                }>;
            };
            if (!lsTool?.execute)
                throw new Error('ls tool execute not present');

            const result = await lsTool.execute(
                'call2',
                { path: '/tmp' },
                new AbortController().signal,
            );
            const text =
                result.content.find((c) => c.type === 'text')?.text ?? '';
            const lines = text.split('\n').filter(Boolean);
            // /tmp always has dotfiles (.ICE-unix etc.) — audit mode must reveal at least one
            const dotLines = lines.filter((l) => l.startsWith('.'));
            expect(dotLines.length).toBeGreaterThan(0);
        });
    });

    // ─── Audit-mode: tool registration uses audit-aware operations ────────────────

    describe('audit-mode: tool registration uses audit-aware operations', () => {
        it('registers ls grep find in standard mode', async () => {
            resetAuditState('standard');
            const { pi, handlers, registeredTools } = createMockExtensionApi();
            piOverrides(pi);
            await handlers.get('session_start')?.({}, { cwd: '/tmp' });
            expect(registeredTools.has('ls')).toBe(true);
            expect(registeredTools.has('grep')).toBe(true);
            expect(registeredTools.has('find')).toBe(true);
        });

        it('registers ls in audit mode', async () => {
            setActiveProfile('audit');
            const { pi, handlers, registeredTools } = createMockExtensionApi();
            piOverrides(pi);
            await handlers.get('session_start')?.({}, { cwd: '/tmp' });
            expect(registeredTools.has('ls')).toBe(true);
        });

        it('registers ls in advanced mode', async () => {
            setActiveProfile('advanced');
            const { pi, handlers, registeredTools } = createMockExtensionApi();
            piOverrides(pi);
            await handlers.get('session_start')?.({}, { cwd: '/tmp' });
            expect(registeredTools.has('ls')).toBe(true);
        });
    });

    // ─── Audit-aware find operations (unit-level) ──────────────────────────────────
    //
    // glob() spawns the fd binary. We test it directly against a real directory
    // so that any FD_BIN path breakage is caught early.
    // The --no-ignore behaviour difference is verified in a disposable fixture:
    // standard mode respects its .gitignore while audit mode traverses
    // node_modules. The fixture keeps this contract independent of the user home.

    describe('auditAwareFindOperations.glob', () => {
        let fixtureDir: string;

        beforeEach(async () => {
            fixtureDir = await mkdtemp(nodePath.join(tmpdir(), 'pi-fd-'));
            await writeFile(nodePath.join(fixtureDir, '.gitignore'), 'node_modules/\n');
            await writeFile(nodePath.join(fixtureDir, 'fixture.json'), '{}\n');
            await mkdir(nodePath.join(fixtureDir, 'node_modules', 'fixture'), {
                recursive: true,
            });
            await writeFile(
                nodePath.join(fixtureDir, 'node_modules', 'fixture', 'package.json'),
                '{}\n',
            );
        });

        afterEach(async () => {
            await rm(fixtureDir, { recursive: true, force: true });
        });

        it('glob runs without error in standard mode (fd binary is reachable)', async () => {
            resetAuditState('standard');
            const results = await auditAwareFindOperations.glob(
                '*.json',
                fixtureDir,
                {
                    ignore: [],
                    limit: 10,
                },
            );
            expect(Array.isArray(results)).toBe(true);
        });

        it('glob runs without error in audit mode (fd binary is reachable)', async () => {
            setActiveProfile('audit');
            const results = await auditAwareFindOperations.glob(
                '*.json',
                fixtureDir,
                {
                    ignore: [],
                    limit: 10,
                },
            );
            expect(Array.isArray(results)).toBe(true);
        });

        it('standard mode respects gitignore: node_modules package.json hidden', async () => {
            resetAuditState('standard');
            const results = await auditAwareFindOperations.glob(
                '**/node_modules/*/package.json',
                fixtureDir,
                { ignore: [], limit: 500 },
            );
            expect(results).toEqual([]);
        });

        it('audit mode ignores gitignore: node_modules package.json visible', async () => {
            setActiveProfile('audit');
            const results = await auditAwareFindOperations.glob(
                '**/node_modules/*/package.json',
                fixtureDir,
                { ignore: [], limit: 500 },
            );
            expect(results).toHaveLength(1);
        });

        it('audit sees more gitignored content than standard — canonical behavioral contract', async () => {
            setActiveProfile('audit');
            const auditResults = await auditAwareFindOperations.glob(
                '**/node_modules/*/package.json',
                fixtureDir,
                { ignore: [], limit: 1000 },
            );

            resetAuditState('standard');
            const standardResults = await auditAwareFindOperations.glob(
                '**/node_modules/*/package.json',
                fixtureDir,
                { ignore: [], limit: 1000 },
            );

            expect(auditResults.length).toBeGreaterThan(standardResults.length);
        });
    });

    // ─── Audit-mode: grep.ignoreGitignore (BLOCKED) ──────────────────────────────────
    //
    // grep.ignoreGitignore is NOT implemented. The createGrepToolDefinition()
    // factory has no hook to inject --no-ignore into the rg invocation.
    // See the BLOCKERS comment in index.ts for full evidence.
    //
    // These tests document the current state accurately:
    //   - grep IS registered (factory works).
    //   - grep.ignoreGitignore has NO behavioral effect — we do NOT assert
    //     otherwise, as that would give false confidence.

    describe('grep audit-mode: grep.ignoreGitignore is blocked (documented)', () => {
        it('grep tool is registered in standard mode', async () => {
            resetAuditState('standard');
            const { pi, handlers, registeredTools } = createMockExtensionApi();
            piOverrides(pi);
            await handlers.get('session_start')?.(
                {},
                { cwd: '~/.pi/agent' },
            );
            expect(registeredTools.has('grep')).toBe(true);
            // NOTE: grep.ignoreGitignore is NOT enforced. rg --no-ignore cannot be
            // injected via the current factory API. Both profiles behave identically
            // with respect to .gitignore. See BLOCKERS in index.ts.
        });

        it('grep tool is registered in audit mode', async () => {
            setActiveProfile('audit');
            const { pi, handlers, registeredTools } = createMockExtensionApi();
            piOverrides(pi);
            await handlers.get('session_start')?.(
                {},
                { cwd: '~/.pi/agent' },
            );
            expect(registeredTools.has('grep')).toBe(true);
            // NOTE: See above — grep.ignoreGitignore is blocked (no factory hook).
        });
    });

    // ─── LLM-disambiguation: pattern vs description docs ─────────────────────────
    //
    // Lighter LLMs repeatedly confuse JSON-Schema field `description` (which
    // annotates the `pattern` prop on pi's schemas) for a tool argument. They
    // emit { "description": "pattern: php" } instead of { "pattern": "php" }
    // and loop forever on validation errors. Pi does NOT silently repair args
    // — we steer the LLM via three official doc channels (description,
    // promptSnippet, promptGuidelines). promptGuidelines lands in the
    // Guidelines section of the system prompt every turn.

    describe('LLM-disambiguation: docs steer LLM away from `description` confusion', () => {
        it('grep tool surfaces pattern/description disambiguation in docs', async () => {
            resetAuditState('standard');
            const { pi, handlers, registeredTools } = createMockExtensionApi();
            piOverrides(pi);
            await handlers.get('session_start')?.({}, { cwd: '/tmp' });
            const grep = registeredTools.get('grep') as {
                description?: string;
                promptSnippet?: string;
                promptGuidelines?: string[];
            };
            if (!grep) throw new Error('grep tool not registered');
            // Description must name `pattern` as the required argument
            expect(grep.description).toMatch(/`pattern`/);
            // Description must explicitly warn against the `description` failure mode
            expect(grep.description?.toLowerCase()).toContain(
                'do not use `description`',
            );
            // Prompt snippet must mention `pattern`
            expect(grep.promptSnippet).toMatch(/`pattern`/);
            // Prompt guidelines present and at least one explicitly mentions the `pattern` arg
            expect(Array.isArray(grep.promptGuidelines)).toBe(true);
            expect(grep.promptGuidelines!.length).toBeGreaterThan(0);
            expect(
                grep.promptGuidelines!.some((g) => /`pattern`/i.test(g)),
            ).toBe(true);
        });

        it('find tool surfaces pattern/description disambiguation in docs', async () => {
            resetAuditState('standard');
            const { pi, handlers, registeredTools } = createMockExtensionApi();
            piOverrides(pi);
            await handlers.get('session_start')?.({}, { cwd: '/tmp' });
            const find = registeredTools.get('find') as {
                description?: string;
                promptSnippet?: string;
                promptGuidelines?: string[];
            };
            if (!find) throw new Error('find tool not registered');
            expect(find.description).toMatch(/`pattern`/);
            expect(find.promptSnippet).toMatch(/`pattern`/);
            expect(Array.isArray(find.promptGuidelines)).toBe(true);
            expect(
                find.promptGuidelines!.some((g) => /`pattern`/i.test(g)),
            ).toBe(true);
        });

        it('ls tool surfaces `path` argument in docs', async () => {
            resetAuditState('standard');
            const { pi, handlers, registeredTools } = createMockExtensionApi();
            piOverrides(pi);
            await handlers.get('session_start')?.({}, { cwd: '/tmp' });
            const ls = registeredTools.get('ls') as {
                promptGuidelines?: string[];
            };
            if (!ls) throw new Error('ls tool not registered');
            expect(Array.isArray(ls.promptGuidelines)).toBe(true);
            expect(ls.promptGuidelines!.some((g) => /`path`/i.test(g))).toBe(
                true,
            );
        });

        it('read tool surfaces `path` argument in docs', async () => {
            resetAuditState('standard');
            const { pi, handlers, registeredTools } = createMockExtensionApi();
            piOverrides(pi);
            await handlers.get('session_start')?.({}, { cwd: '/tmp' });
            const read = registeredTools.get('read') as {
                promptGuidelines?: string[];
            };
            if (!read) throw new Error('read tool not registered');
            expect(Array.isArray(read.promptGuidelines)).toBe(true);
            expect(read.promptGuidelines!.some((g) => /`path`/i.test(g))).toBe(
                true,
            );
        });
    });

    describe('path-redirect: read on directory, ls on file', () => {
        let tmpDir: string;

        afterEach(async () => {
            if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
        });

        async function setupEnv(): Promise<{
            cwd: string;
            subDir: string;
            filePath: string;
        }> {
            tmpDir = await mkdtemp(
                nodePath.join(tmpdir(), 'pi-overrides-test-'),
            );
            const subDir = nodePath.join(tmpDir, 'subdir');
            const { mkdir } = await import('node:fs/promises');
            await mkdir(subDir);
            const filePath = nodePath.join(tmpDir, 'hello.txt');
            await writeFile(filePath, 'line one\nline two\nline three\n');
            return { cwd: tmpDir, subDir, filePath };
        }

        type ToolExec = {
            execute?: (
                id: string,
                args: { path?: string; offset?: number; limit?: number },
                signal: AbortSignal,
            ) => Promise<{ content: Array<{ type: string; text: string }> }>;
        };

        it('read on directory returns directory listing (not EISDIR)', async () => {
            resetAuditState('standard');
            const { cwd } = await setupEnv();
            const { pi, handlers, registeredTools } = createMockExtensionApi();
            piOverrides(pi);
            await handlers.get('session_start')?.({}, { cwd });

            const readTool = registeredTools.get('read') as ToolExec;
            if (!readTool?.execute) throw new Error('read tool not registered');

            const result = await readTool.execute(
                'call1',
                { path: 'subdir' },
                new AbortController().signal,
            );
            const text =
                result.content.find((c) => c.type === 'text')?.text ?? '';
            expect(text).toContain('Path is a directory. Contents of');
            expect(text).not.toContain('EISDIR');
        });

        it('read on file returns file content (normal behavior)', async () => {
            resetAuditState('standard');
            const { cwd } = await setupEnv();
            const { pi, handlers, registeredTools } = createMockExtensionApi();
            piOverrides(pi);
            await handlers.get('session_start')?.({}, { cwd });

            const readTool = registeredTools.get('read') as ToolExec;
            if (!readTool?.execute) throw new Error('read tool not registered');

            const result = await readTool.execute(
                'call2',
                { path: 'hello.txt' },
                new AbortController().signal,
            );
            const text =
                result.content.find((c) => c.type === 'text')?.text ?? '';
            expect(text).toContain('line one');
            expect(text).toContain('line two');
            expect(text).toContain('line three');
        });

        it('ls on file returns stat info + preview (not an error)', async () => {
            resetAuditState('standard');
            const { cwd } = await setupEnv();
            const { pi, handlers, registeredTools } = createMockExtensionApi();
            piOverrides(pi);
            await handlers.get('session_start')?.({}, { cwd });

            const lsTool = registeredTools.get('ls') as ToolExec;
            if (!lsTool?.execute) throw new Error('ls tool not registered');

            const result = await lsTool.execute(
                'call3',
                { path: 'hello.txt' },
                new AbortController().signal,
            );
            const text =
                result.content.find((c) => c.type === 'text')?.text ?? '';
            expect(text).toContain('Path is a file.');
            expect(text).toContain('line one');
            expect(text).toContain('Modified:');
        });

        it('ls on directory returns directory listing (normal behavior)', async () => {
            resetAuditState('standard');
            const { cwd } = await setupEnv();
            const { pi, handlers, registeredTools } = createMockExtensionApi();
            piOverrides(pi);
            await handlers.get('session_start')?.({}, { cwd });

            const lsTool = registeredTools.get('ls') as ToolExec;
            if (!lsTool?.execute) throw new Error('ls tool not registered');

            const result = await lsTool.execute(
                'call4',
                { path: '.' },
                new AbortController().signal,
            );
            const text =
                result.content.find((c) => c.type === 'text')?.text ?? '';
            expect(text).toContain('hello.txt');
            expect(text).toContain('subdir');
        });

        it('read on symlink to directory redirects to listing', async () => {
            resetAuditState('standard');
            const { cwd, subDir } = await setupEnv();
            const symlinkPath = nodePath.join(cwd, 'link-to-dir');
            const { symlink } = await import('node:fs/promises');
            await symlink(subDir, symlinkPath, 'dir');

            const { pi, handlers, registeredTools } = createMockExtensionApi();
            piOverrides(pi);
            await handlers.get('session_start')?.({}, { cwd });

            const readTool = registeredTools.get('read') as ToolExec;
            if (!readTool?.execute) throw new Error('read tool not registered');

            const result = await readTool.execute(
                'call5',
                { path: 'link-to-dir' },
                new AbortController().signal,
            );
            const text =
                result.content.find((c) => c.type === 'text')?.text ?? '';
            expect(text).toContain('Path is a directory. Contents of');
        });
    });

    describe('prompt input session naming', () => {
        const promptCommands: SlashCommandInfo[] = [
            {
                name: 'debug-issue',
                description: 'Debug an issue',
                source: 'prompt',
                sourceInfo: {
                    path: '/prompts/debug-issue.md',
                    source: 'prompt',
                    scope: 'user',
                    origin: 'package',
                },
            },
            {
                name: 'review-code',
                description: 'Review code',
                source: 'prompt',
                sourceInfo: {
                    path: '/prompts/review-code.md',
                    source: 'prompt',
                    scope: 'user',
                    origin: 'package',
                },
            },
        ];
        const nonPromptCommands: SlashCommandInfo[] = [
            {
                name: 'diagnose',
                source: 'skill',
                sourceInfo: {
                    path: '/skills/diagnose/SKILL.md',
                    source: 'skill',
                    scope: 'user',
                    origin: 'package',
                },
            },
            {
                name: 'custom-cmd',
                source: 'extension',
                sourceInfo: {
                    path: '/extensions/test-ext/cmd.ts',
                    source: 'extension',
                    scope: 'user',
                    origin: 'package',
                },
            },
        ];

        it('registers an input handler', async () => {
            const { pi, handlers } = createMockExtensionApi();
            piOverrides(pi);
            expect(handlers.has('input')).toBe(true);
        });

        it('names an unnamed session from a known prompt command with args', async () => {
            const { pi, handlers, getSessionName } = createMockExtensionApi(
                undefined,
                promptCommands,
            );
            piOverrides(pi);
            const handler = handlers.get('input');
            if (!handler) throw new Error('input handler not registered');

            await handler(
                { text: '/debug-issue sandbox colors', type: 'input' },
                {},
            );

            expect(getSessionName()).toBe('/prompt:debug-issue sandbox colors');
        });

        it('names an unnamed session from a known prompt command without args', async () => {
            const { pi, handlers, getSessionName } = createMockExtensionApi(
                undefined,
                promptCommands,
            );
            piOverrides(pi);
            const handler = handlers.get('input');
            if (!handler) throw new Error('input handler not registered');

            await handler({ text: '/debug-issue', type: 'input' }, {});

            expect(getSessionName()).toBe('/prompt:debug-issue');
        });

        it('preserves an existing explicit session name', async () => {
            const { pi, handlers, getSessionName } = createMockExtensionApi(
                'custom name',
                promptCommands,
            );
            piOverrides(pi);
            const handler = handlers.get('input');
            if (!handler) throw new Error('input handler not registered');

            await handler(
                { text: '/debug-issue sandbox colors', type: 'input' },
                {},
            );

            expect(getSessionName()).toBe('custom name');
        });

        it('ignores unknown commands not in promptNames', async () => {
            const { pi, handlers, getSessionName } = createMockExtensionApi(
                undefined,
                promptCommands,
            );
            piOverrides(pi);
            const handler = handlers.get('input');
            if (!handler) throw new Error('input handler not registered');

            await handler({ text: '/unknown arg1', type: 'input' }, {});

            expect(getSessionName()).toBeUndefined();
        });

        it('ignores skill-source commands', async () => {
            const { pi, handlers, getSessionName } = createMockExtensionApi(
                undefined,
                nonPromptCommands,
            );
            piOverrides(pi);
            const handler = handlers.get('input');
            if (!handler) throw new Error('input handler not registered');

            await handler({ text: '/diagnose investigate', type: 'input' }, {});

            expect(getSessionName()).toBeUndefined();
        });

        it('names a first skill after its input expands', async () => {
            const { pi, handlers, getSessionName } = createMockExtensionApi(
                undefined,
                nonPromptCommands,
            );
            piOverrides(pi);
            const input = handlers.get('input');
            const messageEnd = handlers.get('message_end');
            if (!input) throw new Error('input handler not registered');
            if (!messageEnd) throw new Error('message_end not registered');

            await input({ text: '/diagnose investigate', type: 'input' }, {});
            await messageEnd(
                {
                    message: {
                        role: 'user',
                        content:
                            '<skill name="diagnose">instructions</skill>\n\nInvestigate',
                    },
                },
                {},
            );

            expect(getSessionName()).toBe('/skill:diagnose Investigate');
        });

        it('ignores extension-source commands', async () => {
            const { pi, handlers, getSessionName } = createMockExtensionApi(
                undefined,
                nonPromptCommands,
            );
            piOverrides(pi);
            const handler = handlers.get('input');
            if (!handler) throw new Error('input handler not registered');

            await handler({ text: '/custom-cmd do-thing', type: 'input' }, {});

            expect(getSessionName()).toBeUndefined();
        });

        it('does not name a resumed session after an existing first user message', async () => {
            const { pi, handlers, getSessionName } = createMockExtensionApi(
                undefined,
                promptCommands,
            );
            piOverrides(pi);
            const sessionStart = handlers.get('session_start');
            const input = handlers.get('input');
            if (!sessionStart) throw new Error('session_start not registered');
            if (!input) throw new Error('input handler not registered');

            await sessionStart(
                {},
                {
                    cwd: '/tmp',
                    sessionManager: {
                        getEntries: () => [
                            {
                                type: 'message',
                                message: {
                                    role: 'user',
                                    content: 'Ordinary first message',
                                },
                            },
                        ],
                    },
                },
            );
            await input({ text: '/debug-issue fix login', type: 'input' }, {});

            expect(getSessionName()).toBeUndefined();
        });

        it('counts a first user message delivered without an input event', async () => {
            const { pi, handlers, getSessionName } = createMockExtensionApi(
                undefined,
                promptCommands,
            );
            piOverrides(pi);
            const messageEnd = handlers.get('message_end');
            const input = handlers.get('input');
            if (!messageEnd) throw new Error('message_end not registered');
            if (!input) throw new Error('input handler not registered');

            await messageEnd(
                {
                    message: {
                        role: 'user',
                        content: 'Programmatic first message',
                    },
                },
                {},
            );
            await input({ text: '/debug-issue fix login', type: 'input' }, {});

            expect(getSessionName()).toBeUndefined();
        });

        it('does not name a session from a prompt after the first user input', async () => {
            const { pi, handlers, getSessionName } = createMockExtensionApi(
                undefined,
                promptCommands,
            );
            piOverrides(pi);
            const handler = handlers.get('input');
            if (!handler) throw new Error('input handler not registered');

            await handler({ text: '/unknown first', type: 'input' }, {});
            expect(getSessionName()).toBeUndefined();

            await handler(
                { text: '/debug-issue fix login', type: 'input' },
                {},
            );
            expect(getSessionName()).toBeUndefined();
        });

        it('existing skill message_end behavior still works unchanged', async () => {
            const { pi, handlers, getSessionName } = createMockExtensionApi();
            piOverrides(pi);
            const handler = handlers.get('message_end');
            if (!handler) throw new Error('message_end handler not registered');

            await handler(
                {
                    message: {
                        role: 'user',
                        content: [
                            {
                                type: 'text',
                                text: '<skill name="diagnose" location="/skills/diagnose/SKILL.md">instructions</skill>\n\nInvestigate color',
                            },
                        ],
                    },
                },
                {},
            );

            expect(getSessionName()).toBe('/skill:diagnose Investigate color');
        });
    });
});
