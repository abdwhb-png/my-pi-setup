import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

    test('registers report tools and refuses purge when no UI is available', async () => {
        const tools = new Map<string, { execute: Function }>();
        registerScopedWrite({
            registerTool(tool: { name: string; execute: Function }) {
                tools.set(tool.name, tool);
            },
        } as never);
        const cwd = temporaryProject();
        const context = {
            cwd,
            hasUI: false,
            sessionManager: {
                getSessionId: () => 'session-1',
                getEntries: () => [{
                    type: 'custom', customType: 'pi-roles:active-role',
                    data: { name: 'sdd-qa-tester', source: 'user', path: 'qa.md', appliedAt: 1 },
                }],
            },
        };

        const write = tools.get('write_report');
        if (!write) throw new Error('write_report was not registered');
        const written = await write.execute('call-1', {
            path: 'summary.md', content: '# Complete\n',
        }, undefined, undefined, context);

        expect(written.details.kind).toBe('success');
        const purge = tools.get('artifacts_purge');
        if (!purge) throw new Error('artifacts_purge was not registered');
        await expect(purge.execute('call-2', { runId: 'session-1' }, undefined, undefined, context))
            .rejects.toThrow('requires an interactive confirmation');
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
