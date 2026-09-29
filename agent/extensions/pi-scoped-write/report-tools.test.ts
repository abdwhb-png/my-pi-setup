import { afterEach, describe, expect, test } from 'bun:test';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    createCommonArtifactRoots,
    createReportWriter,
    registerArtifactRunRoot,
    sharedArtifactRootRegistry,
} from './index.ts';
import registerScopedWrite from './index.ts';

const temporaryDirectories: string[] = [];

function temporaryProject(): string {
    const directory = mkdtempSync(join(tmpdir(), 'pi-scoped-write-tools-'));
    temporaryDirectories.push(directory);
    return directory;
}

function registerScopedWriteFixture(): {
    tools: Map<string, { execute: Function }>;
    commands: Map<string, { handler: Function }>;
} {
    const tools = new Map<string, { execute: Function }>();
    const commands = new Map<string, { handler: Function }>();
    registerScopedWrite({
        registerTool(tool: { name: string; execute: Function }) {
            tools.set(tool.name, tool);
        },
        registerCommand(name: string, command: { handler: Function }) {
            commands.set(name, command);
        },
    } as never);
    return { tools, commands };
}

function purgeContext(
    cwd: string,
    ui: { hasUI?: boolean; select?: (message: string, options: string[]) => Promise<string> },
) {
    return {
        cwd,
        hasUI: ui.hasUI ?? true,
        sessionManager: {
            getSessionId: () => 'session-1',
            getEntries: () => [{
                type: 'custom', customType: 'pi-roles:active-role',
                data: { name: 'sdd-qa-tester', source: 'user', path: 'qa.md', appliedAt: 1 },
            }],
        },
        ui: {
            select: ui.select ?? (async () => 'Cancel'),
            notify: () => undefined,
        },
    };
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

describe('scoped report tools', () => {
    test('writes a report under the active role and session root and registers it for purge', () => {
        const cwd = temporaryProject();
        const writer = createReportWriter({
            cwd,
            role: 'sdd-qa-tester',
            sessionId: 'session-1',
            agent: 'sdd-qa-tester',
        });

        expect(writer.create({
            path: 'summary.md',
            content: '# QA passed\n',
            tool: 'write_report',
        }).kind).toBe('success');
        expect(readFileSync(join(cwd, '.pi/artifacts/reports/sdd-qa-tester/session-1/summary.md'), 'utf8')).toBe('# QA passed\n');

        const roots = createCommonArtifactRoots();
        expect(roots.resolve(cwd, 'session-1')).toContain(
            join(cwd, '.pi/artifacts/reports/sdd-qa-tester/session-1'),
        );
        expect(existsSync(join(cwd, '.pi/artifacts/.audit/session-1.jsonl'))).toBeTrue();
    });

    test('registers report tools and the purge command, which refuses to run without a UI', async () => {
        const { tools, commands } = registerScopedWriteFixture();
        const cwd = temporaryProject();
        const context = purgeContext(cwd, { hasUI: false });

        const write = tools.get('write_report');
        if (!write) throw new Error('write_report was not registered');
        const written = await write.execute('call-1', {
            path: 'summary.md', content: '# Complete\n',
        }, undefined, undefined, context);

        expect(written.details.kind).toBe('success');
        expect(tools.has('artifacts_purge')).toBeFalse();
        const purge = commands.get('purge-artifacts');
        if (!purge) throw new Error('/purge-artifacts was not registered');
        await expect(purge.handler('session-1', context))
            .rejects.toThrow('requires an interactive confirmation');
    });

    test('purges only the confirmed run and audits the operator command', async () => {
        const { commands } = registerScopedWriteFixture();
        const cwd = temporaryProject();
        const firstRun = join(cwd, '.pi/artifacts/reports/sdd-qa-tester/run-1');
        const secondRun = join(cwd, '.pi/artifacts/reports/sdd-qa-tester/run-2');
        mkdirSync(firstRun, { recursive: true });
        mkdirSync(secondRun, { recursive: true });
        writeFileSync(join(firstRun, 'report.md'), 'old', 'utf8');
        writeFileSync(join(secondRun, 'report.md'), 'keep', 'utf8');
        const context = purgeContext(cwd, { select: async () => 'Purge' });

        const purge = commands.get('purge-artifacts');
        if (!purge) throw new Error('/purge-artifacts was not registered');
        await purge.handler('run-1', context);

        expect(existsSync(firstRun)).toBeFalse();
        expect(existsSync(secondRun)).toBeTrue();
        const audit = readFileSync(
            join(cwd, '.pi/artifacts/.audit/run-1.jsonl'),
            'utf8',
        );
        expect(audit).toContain('"operation":"purge"');
        expect(audit).toContain('"tool":"command:/purge-artifacts"');
    });

    test('keeps every artefact when the operator cancels the confirmation', async () => {
        const { commands } = registerScopedWriteFixture();
        const cwd = temporaryProject();
        const run = join(cwd, '.pi/artifacts/reports/sdd-qa-tester/run-1');
        mkdirSync(run, { recursive: true });
        writeFileSync(join(run, 'report.md'), 'keep', 'utf8');
        const context = purgeContext(cwd, { select: async () => 'Cancel' });

        const purge = commands.get('purge-artifacts');
        if (!purge) throw new Error('/purge-artifacts was not registered');
        await purge.handler('run-1', context);

        expect(existsSync(join(run, 'report.md'))).toBeTrue();
    });

    test('accepts an explicitly registered extension-owned run root', () => {
        const cwd = temporaryProject();
        registerArtifactRunRoot({
            id: 'test-extension-root',
            resolve: (root, runId) => [join(root, '.test-artifacts', runId)],
        });

        expect(sharedArtifactRootRegistry().resolve(cwd, 'session-1')).toContain(
            join(cwd, '.test-artifacts/session-1'),
        );
    });
});
