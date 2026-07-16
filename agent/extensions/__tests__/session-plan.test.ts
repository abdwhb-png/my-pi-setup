import { afterEach, describe, expect, it } from 'bun:test';
import {
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
    ExtensionAPI,
    ExtensionContext,
    ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import sessionPlanExtension from '../session-plan';

describe('session_plan extension', () => {
    const temporaryDirectories: string[] = [];

    afterEach(() => {
        for (const directory of temporaryDirectories.splice(0)) {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it('saves the current plan under the active Pi session', async () => {
        const sessionDirectory = mkdtempSync(
            join(tmpdir(), 'session-plan-test-'),
        );
        temporaryDirectories.push(sessionDirectory);

        let registeredTool: ToolDefinition | undefined;
        const pi = {
            registerTool(tool: ToolDefinition) {
                registeredTool = tool;
            },
            on() {},
        } as unknown as ExtensionAPI;

        sessionPlanExtension(pi);

        expect(registeredTool?.name).toBe('session_plan');
        expect(registeredTool?.executionMode).toBe('sequential');

        const context = {
            sessionManager: {
                getSessionDir: () => sessionDirectory,
                getSessionId: () => 'session-one',
            },
        } as unknown as ExtensionContext;

        await registeredTool!.execute(
            'tool-call-one',
            { action: 'save', content: '# Session plan\n\nFirst version.' },
            undefined,
            undefined,
            context,
        );

        expect(
            readFileSync(
                join(sessionDirectory, 'plans', 'session-one.md'),
                'utf8',
            ),
        ).toBe('# Session plan\n\nFirst version.');
    });

    it('replaces the complete plan atomically and reports UTF-8 bytes', async () => {
        const sessionDirectory = mkdtempSync(
            join(tmpdir(), 'session-plan-test-'),
        );
        temporaryDirectories.push(sessionDirectory);

        let registeredTool: ToolDefinition | undefined;
        const pi = {
            registerTool(tool: ToolDefinition) {
                registeredTool = tool;
            },
            on() {},
        } as unknown as ExtensionAPI;
        sessionPlanExtension(pi);

        const context = {
            sessionManager: {
                getSessionDir: () => sessionDirectory,
                getSessionId: () => 'session-one',
            },
        } as unknown as ExtensionContext;

        await registeredTool!.execute(
            'first-save',
            { action: 'save', content: '# Obsolete plan' },
            undefined,
            undefined,
            context,
        );
        const content = '# Plan révisé';
        const result = await registeredTool!.execute(
            'second-save',
            { action: 'save', content },
            undefined,
            undefined,
            context,
        );

        expect(
            readFileSync(
                join(sessionDirectory, 'plans', 'session-one.md'),
                'utf8',
            ),
        ).toBe(content);
        expect(result.details).toMatchObject({
            action: 'save',
            exists: true,
            bytes: Buffer.byteLength(content, 'utf8'),
        });
        expect(readdirSync(join(sessionDirectory, 'plans'))).toEqual([
            'session-one.md',
        ]);
    });

    it('reads a previously saved plan from the active Pi session', async () => {
        const sessionDirectory = mkdtempSync(
            join(tmpdir(), 'session-plan-test-'),
        );
        temporaryDirectories.push(sessionDirectory);

        let registeredTool: ToolDefinition | undefined;
        const pi = {
            registerTool(tool: ToolDefinition) {
                registeredTool = tool;
            },
            on() {},
        } as unknown as ExtensionAPI;
        sessionPlanExtension(pi);

        const context = {
            sessionManager: {
                getSessionDir: () => sessionDirectory,
                getSessionId: () => 'session-one',
            },
        } as unknown as ExtensionContext;

        await registeredTool!.execute(
            'save-call',
            { action: 'save', content: '# Persisted plan' },
            undefined,
            undefined,
            context,
        );
        const result = await registeredTool!.execute(
            'read-call',
            { action: 'read' },
            undefined,
            undefined,
            context,
        );

        expect(result.content).toEqual([
            { type: 'text', text: '# Persisted plan' },
        ]);
    });

    it('clears the active session plan idempotently', async () => {
        const sessionDirectory = mkdtempSync(
            join(tmpdir(), 'session-plan-test-'),
        );
        temporaryDirectories.push(sessionDirectory);

        let registeredTool: ToolDefinition | undefined;
        const pi = {
            registerTool(tool: ToolDefinition) {
                registeredTool = tool;
            },
            on() {},
        } as unknown as ExtensionAPI;
        sessionPlanExtension(pi);

        const context = {
            sessionManager: {
                getSessionDir: () => sessionDirectory,
                getSessionId: () => 'session-one',
            },
        } as unknown as ExtensionContext;

        await registeredTool!.execute(
            'save-call',
            { action: 'save', content: '# Disposable plan' },
            undefined,
            undefined,
            context,
        );
        await registeredTool!.execute(
            'clear-call',
            { action: 'clear' },
            undefined,
            undefined,
            context,
        );
        await registeredTool!.execute(
            'clear-again',
            { action: 'clear' },
            undefined,
            undefined,
            context,
        );
        const result = await registeredTool!.execute(
            'read-call',
            { action: 'read' },
            undefined,
            undefined,
            context,
        );

        expect(result.content).toEqual([
            { type: 'text', text: 'No session plan has been saved.' },
        ]);
    });

    it('copies the parent plan once when Pi starts a forked session', async () => {
        const sessionDirectory = mkdtempSync(
            join(tmpdir(), 'session-plan-test-'),
        );
        temporaryDirectories.push(sessionDirectory);
        const parentSessionFile = join(
            sessionDirectory,
            'timestamp_parent-session.jsonl',
        );
        writeFileSync(
            parentSessionFile,
            `${JSON.stringify({
                type: 'session',
                version: 3,
                id: 'parent-session',
                timestamp: new Date().toISOString(),
                cwd: '/project',
            })}\n`,
            'utf8',
        );
        mkdirSync(join(sessionDirectory, 'plans'), { recursive: true });
        writeFileSync(
            join(sessionDirectory, 'plans', 'parent-session.md'),
            '# Parent plan',
            'utf8',
        );

        let sessionStartHandler:
            | ((
                  event: { reason: string },
                  context: ExtensionContext,
              ) => Promise<void> | void)
            | undefined;
        const pi = {
            registerTool() {},
            on(eventName: string, handler: typeof sessionStartHandler) {
                if (eventName === 'session_start')
                    sessionStartHandler = handler;
            },
        } as unknown as ExtensionAPI;
        sessionPlanExtension(pi);

        const context = {
            sessionManager: {
                getSessionDir: () => sessionDirectory,
                getSessionId: () => 'fork-session',
                getHeader: () => ({
                    type: 'session',
                    version: 3,
                    id: 'fork-session',
                    timestamp: new Date().toISOString(),
                    cwd: '/project',
                    parentSession: parentSessionFile,
                }),
            },
        } as unknown as ExtensionContext;

        await sessionStartHandler!({ reason: 'fork' }, context);
        expect(
            readFileSync(
                join(sessionDirectory, 'plans', 'fork-session.md'),
                'utf8',
            ),
        ).toBe('# Parent plan');

        writeFileSync(
            join(sessionDirectory, 'plans', 'fork-session.md'),
            '# Fork plan',
            'utf8',
        );
        await sessionStartHandler!({ reason: 'fork' }, context);
        expect(
            readFileSync(
                join(sessionDirectory, 'plans', 'fork-session.md'),
                'utf8',
            ),
        ).toBe('# Fork plan');
        expect(
            readFileSync(
                join(sessionDirectory, 'plans', 'parent-session.md'),
                'utf8',
            ),
        ).toBe('# Parent plan');
    });

    it('is the only plan persistence tool configured for quick-planner', () => {
        const role = readFileSync(
            join(import.meta.dir, '..', '..', 'roles', 'quick-planner.md'),
            'utf8',
        );

        expect(role).toContain('session_plan');
        expect(role).not.toMatch(/tools:.*\bmemory\b/);
        expect(role).not.toContain('#tool:vscode/memory');
        expect(role).not.toContain('/quick-plans/');
    });
});
