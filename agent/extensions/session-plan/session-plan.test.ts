import { afterEach, describe, expect, it } from 'bun:test';
import {
    existsSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
    ExtensionAPI,
    ExtensionContext,
    ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import sessionPlanExtension from './index';

describe('session_plan extension', () => {
    const temporaryDirectories: string[] = [];

    afterEach(() => {
        for (const directory of temporaryDirectories.splice(0)) {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it('saves a versioned plan in CWD under .pi/session-plans', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'session-plan-cwd-'));
        temporaryDirectories.push(cwd);
        const sessionDirectory = mkdtempSync(
            join(tmpdir(), 'session-plan-session-'),
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

        const context = {
            cwd,
            sessionManager: {
                getSessionDir: () => sessionDirectory,
                getSessionId: () => 'session-one',
            },
        } as unknown as ExtensionContext;

        const result = await registeredTool!.execute(
            'call-1',
            {
                action: 'save',
                topic: 'my plan',
                content: '# My plan\n\nDo things.',
            },
            undefined,
            undefined,
            context,
        );

        const planDirs = readdirSync(join(cwd, '.pi', 'session-plans'));
        expect(planDirs.length).toBe(1);
        expect(planDirs[0]).toMatch(/^\d{4}-\d{2}-\d{2}-my-plan$/);

        const manifestPath = join(
            cwd,
            '.pi',
            'session-plans',
            planDirs[0],
            'manifest.json',
        );
        expect(existsSync(manifestPath)).toBe(true);

        const v1Path = join(
            cwd,
            '.pi',
            'session-plans',
            planDirs[0],
            'v001.md',
        );
        expect(readFileSync(v1Path, 'utf8')).toBe('# My plan\n\nDo things.\n');

        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        expect(manifest.latestVersion).toBe(1);
        expect(manifest.topic).toBe('my plan');

        const contentBytes = Buffer.byteLength('# My plan\n\nDo things.\n', 'utf8');
        expect(result.details).toMatchObject({
            action: 'save',
            exists: true,
            bytes: contentBytes,
        });
    });

    it('creates v002.md on second save and updates manifest', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'session-plan-cwd-'));
        temporaryDirectories.push(cwd);
        const sessionDirectory = mkdtempSync(
            join(tmpdir(), 'session-plan-session-'),
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
            cwd,
            sessionManager: {
                getSessionDir: () => sessionDirectory,
                getSessionId: () => 's1',
            },
        } as unknown as ExtensionContext;

        await registeredTool!.execute(
            'save-1',
            {
                action: 'save',
                topic: 'rev plan',
                content: '# Rev plan\n\nv1.',
            },
            undefined,
            undefined,
            context,
        );

        const result = await registeredTool!.execute(
            'save-2',
            {
                action: 'save',
                topic: 'rev plan',
                content: '# Rev plan\n\nv2.',
            },
            undefined,
            undefined,
            context,
        );

        const dirs = readdirSync(join(cwd, '.pi', 'session-plans'));
        const planDirName = dirs[0];
        const planPath = join(cwd, '.pi', 'session-plans', planDirName);

        expect(existsSync(join(planPath, 'v001.md'))).toBe(true);
        expect(existsSync(join(planPath, 'v002.md'))).toBe(true);
        expect(readFileSync(join(planPath, 'v002.md'), 'utf8')).toBe(
            '# Rev plan\n\nv2.\n',
        );

        const manifest = JSON.parse(
            readFileSync(join(planPath, 'manifest.json'), 'utf8'),
        );
        expect(manifest.latestVersion).toBe(2);
        expect(result.details).toMatchObject({
            action: 'save',
            exists: true,
        });
    });

    it('read returns the latest version', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'session-plan-cwd-'));
        temporaryDirectories.push(cwd);
        const sessionDirectory = mkdtempSync(
            join(tmpdir(), 'session-plan-session-'),
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
            cwd,
            sessionManager: {
                getSessionDir: () => sessionDirectory,
                getSessionId: () => 's1',
            },
        } as unknown as ExtensionContext;

        await registeredTool!.execute(
            'save-1',
            {
                action: 'save',
                topic: 'read plan',
                content: '# Read plan\n\nv1.',
            },
            undefined,
            undefined,
            context,
        );
        await registeredTool!.execute(
            'save-2',
            {
                action: 'save',
                topic: 'read plan',
                content: '# Read plan\n\nv2.',
            },
            undefined,
            undefined,
            context,
        );

        const result = await registeredTool!.execute(
            'read-1',
            { action: 'read', topic: 'read plan' },
            undefined,
            undefined,
            context,
        );

        expect(result.content).toEqual([
            { type: 'text', text: '# Read plan\n\nv2.\n' },
        ]);
    });

    it('clear removes all versions and manifest', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'session-plan-cwd-'));
        temporaryDirectories.push(cwd);
        const sessionDirectory = mkdtempSync(
            join(tmpdir(), 'session-plan-session-'),
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
            cwd,
            sessionManager: {
                getSessionDir: () => sessionDirectory,
                getSessionId: () => 's1',
            },
        } as unknown as ExtensionContext;

        await registeredTool!.execute(
            'save-1',
            {
                action: 'save',
                topic: 'clear plan',
                content: '# Clear plan',
            },
            undefined,
            undefined,
            context,
        );
        await registeredTool!.execute(
            'save-2',
            {
                action: 'save',
                topic: 'clear plan',
                content: '# Clear plan v2',
            },
            undefined,
            undefined,
            context,
        );

        await registeredTool!.execute(
            'clear-1',
            { action: 'clear', topic: 'clear plan' },
            undefined,
            undefined,
            context,
        );

        const planDirs = readdirSync(join(cwd, '.pi', 'session-plans'));
        expect(planDirs.length).toBe(0);
    });

    it('save without topic extracts heading from content', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'session-plan-cwd-'));
        temporaryDirectories.push(cwd);
        const sessionDirectory = mkdtempSync(
            join(tmpdir(), 'session-plan-session-'),
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
            cwd,
            sessionManager: {
                getSessionDir: () => sessionDirectory,
                getSessionId: () => 's1',
            },
        } as unknown as ExtensionContext;

        await registeredTool!.execute(
            'save-1',
            {
                action: 'save',
                content: '# My Heading\n\nBody text.',
            },
            undefined,
            undefined,
            context,
        );

        const dirs = readdirSync(join(cwd, '.pi', 'session-plans'));
        expect(dirs.length).toBe(1);
        expect(dirs[0]).toMatch(/^\d{4}-\d{2}-\d{2}-my-heading$/);
    });

    it('save without topic and without heading falls back to plan-{sessionId}', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'session-plan-cwd-'));
        temporaryDirectories.push(cwd);
        const sessionDirectory = mkdtempSync(
            join(tmpdir(), 'session-plan-session-'),
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
            cwd,
            sessionManager: {
                getSessionDir: () => sessionDirectory,
                getSessionId: () => 'abc12345-def0',
            },
        } as unknown as ExtensionContext;

        await registeredTool!.execute(
            'save-1',
            {
                action: 'save',
                content: 'No heading here.',
            },
            undefined,
            undefined,
            context,
        );

        const dirs = readdirSync(join(cwd, '.pi', 'session-plans'));
        expect(dirs.length).toBe(1);
        expect(dirs[0]).toMatch(/^\d{4}-\d{2}-\d{2}-plan-abc12345$/);
    });

    it('read without topic returns error', async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'session-plan-cwd-'));
        temporaryDirectories.push(cwd);
        const sessionDirectory = mkdtempSync(
            join(tmpdir(), 'session-plan-session-'),
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
            cwd,
            sessionManager: {
                getSessionDir: () => sessionDirectory,
                getSessionId: () => 's1',
            },
        } as unknown as ExtensionContext;

        await expect(
            registeredTool!.execute(
                'read-1',
                { action: 'read' },
                undefined,
                undefined,
                context,
            ),
        ).rejects.toThrow('topic');
    });

    it('is the only plan persistence tool configured for quick-planner', () => {
        const role = readFileSync(
            join(import.meta.dir, '..', '..', 'roles', 'quick-planner.md'),
            'utf8',
        );

        expect(role).toContain('session_plan');
        expect(role).not.toMatch(/tools:.*\bmemory\b(?!-)/);
        expect(role).not.toContain('#tool:vscode/memory');
        expect(role).not.toContain('/quick-plans/');
    });
});
