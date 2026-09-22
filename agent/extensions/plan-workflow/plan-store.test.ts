import { describe, expect, it } from 'bun:test';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { savePlan, readPlan, clearPlan, PLAN_ROOT } from './plan-store';

describe('plan-store', () => {
    const temporaryDirectories: string[] = [];

    function cleanup() {
        for (const dir of temporaryDirectories.splice(0)) {
            rmSync(dir, { recursive: true, force: true });
        }
    }

    it('savePlan creates v001.md and manifest', () => {
        const cwd = mkdtempSync(join(tmpdir(), 'ps-test-'));
        temporaryDirectories.push(cwd);

        const result = savePlan(cwd, 'my topic', '# My Topic\n\nBody.');
        expect(result.version).toBe(1);

        const dirs = readdirSync(join(cwd, PLAN_ROOT));
        expect(dirs.length).toBe(1);
        expect(dirs[0]).toBe('my-topic');

        const planPath = join(cwd, PLAN_ROOT, dirs[0]);
        expect(existsSync(join(planPath, 'v001.md'))).toBe(true);
        expect(existsSync(join(planPath, 'manifest.json'))).toBe(true);

        const manifest = JSON.parse(readFileSync(join(planPath, 'manifest.json'), 'utf8'));
        expect(manifest.latestVersion).toBe(1);
        expect(manifest.topic).toBe('my topic');
        cleanup();
    });

    it('savePlan creates v002.md on second call', () => {
        const cwd = mkdtempSync(join(tmpdir(), 'ps-test-'));
        temporaryDirectories.push(cwd);

        savePlan(cwd, 'rev plan', '# Rev plan\n\nv1.');
        const r2 = savePlan(cwd, 'rev plan', '# Rev plan\n\nv2.');

        expect(r2.version).toBe(2);

        const dirs = readdirSync(join(cwd, PLAN_ROOT));
        const planPath = join(cwd, PLAN_ROOT, dirs[0]);
        expect(existsSync(join(planPath, 'v001.md'))).toBe(true);
        expect(existsSync(join(planPath, 'v002.md'))).toBe(true);

        const manifest = JSON.parse(readFileSync(join(planPath, 'manifest.json'), 'utf8'));
        expect(manifest.latestVersion).toBe(2);
        expect(manifest.versions.length).toBe(2);
        cleanup();
    });

    it('readPlan returns latest version', () => {
        const cwd = mkdtempSync(join(tmpdir(), 'ps-test-'));
        temporaryDirectories.push(cwd);

        savePlan(cwd, 'read test', '# Read\n\nv1.');
        savePlan(cwd, 'read test', '# Read\n\nv2.');

        const result = readPlan(cwd, 'read test');
        expect(result).toBeDefined();
        expect(result!.version).toBe(2);
        expect(result!.content).toContain('v2.');
        cleanup();
    });

    it('clearPlan removes all files', () => {
        const cwd = mkdtempSync(join(tmpdir(), 'ps-test-'));
        temporaryDirectories.push(cwd);

        savePlan(cwd, 'clear test', '# Clear');
        savePlan(cwd, 'clear test', '# Clear v2');

        const cleared = clearPlan(cwd, 'clear test');
        expect(cleared).toBe(true);

        const plansRoot = join(cwd, PLAN_ROOT);
        expect(existsSync(plansRoot)).toBe(true);
        const remaining = readdirSync(plansRoot).filter(d => d !== '.migrated');
        expect(remaining.length).toBe(0);
        cleanup();
    });

    it('appends N+1 from a different session to an existing dated plan', () => {
        const cwd = mkdtempSync(join(tmpdir(), 'ps-test-'));
        temporaryDirectories.push(cwd);
        const legacyRoot = join(PLAN_ROOT, '2026-01-01-shared-plan');
        const legacyDir = join(cwd, legacyRoot);
        mkdirSync(legacyDir, { recursive: true });
        writeFileSync(join(legacyDir, 'v001.md'), '# Shared plan\n\nv1.\n');
        writeFileSync(
            join(legacyDir, 'manifest.json'),
            JSON.stringify({
                version: 1,
                topic: 'shared plan',
                root: legacyRoot,
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
                latestVersion: 1,
                versions: [
                    {
                        version: 1,
                        path: `${legacyRoot}/v001.md`,
                        createdAt: '2026-01-01T00:00:00.000Z',
                        bytes: 18,
                        sessionId: 'session-one',
                    },
                ],
            }),
        );

        const result = savePlan(
            cwd,
            'shared plan',
            '# Shared plan\n\nv2.',
            'session-two',
        );

        expect(result.version).toBe(2);
        expect(result.path).toBe(join(legacyDir, 'v002.md'));
        const manifest = JSON.parse(
            readFileSync(join(legacyDir, 'manifest.json'), 'utf8'),
        );
        expect(manifest.versions[1].sessionId).toBe('session-two');
        cleanup();
    });

    it('savePlan without topic uses session ID fallback', () => {
        const cwd = mkdtempSync(join(tmpdir(), 'ps-test-'));
        temporaryDirectories.push(cwd);

        const result = savePlan(cwd, 'plan-abc12345', 'No heading.', 'abc12345-def0');
        expect(result.version).toBe(1);

        const dirs = readdirSync(join(cwd, PLAN_ROOT));
        expect(dirs[0]).toBe('plan-abc12345');
        cleanup();
    });
});
