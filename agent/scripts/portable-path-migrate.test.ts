import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateOperationalState } from './portable-path-migrate.ts';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), 'portable-path-migrate-'));
    temporaryDirectories.push(directory);
    return directory;
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        rmSync(directory, { recursive: true, force: true });
    }
});

describe('migrateOperationalState', () => {
    it('dry-runs and then converts supported operational JSON without touching secrets or sessions', () => {
        const root = temporaryDirectory();
        const agentDir = join(root, 'agent');
        const home = join(root, 'home');
        const settingsPath = join(agentDir, 'settings.json');
        const queuePath = join(agentDir, '.sdd', 'queue', 'run.json');
        const secretPath = join(agentDir, 'auth.json');
        const sessionPath = join(agentDir, 'sessions', 'old', 'session.jsonl');

        mkdirSync(join(agentDir, '.sdd', 'queue'), { recursive: true });
        mkdirSync(join(agentDir, 'sessions', 'old'), { recursive: true });
        writeFileSync(settingsPath, JSON.stringify({ source: `${home}/projects/pi` }));
        writeFileSync(queuePath, JSON.stringify({ planPath: `${home}/plans/plan.md` }));
        writeFileSync(secretPath, JSON.stringify({ tokenPath: `${home}/secret` }));
        writeFileSync(sessionPath, `${home}/historical-session\n`);

        const preview = migrateOperationalState({ agentDir, home });
        expect(preview.changedFiles).toEqual([queuePath, settingsPath]);
        expect(JSON.parse(readFileSync(settingsPath, 'utf8')).source).toBe(
            `${home}/projects/pi`,
        );

        const applied = migrateOperationalState({ agentDir, home, apply: true });
        expect(applied.backupDir).toBeDefined();
        expect(JSON.parse(readFileSync(settingsPath, 'utf8')).source).toBe(
            '~/projects/pi',
        );
        expect(JSON.parse(readFileSync(queuePath, 'utf8')).planPath).toBe(
            '~/plans/plan.md',
        );
        expect(JSON.parse(readFileSync(secretPath, 'utf8')).tokenPath).toBe(
            `${home}/secret`,
        );
        expect(readFileSync(sessionPath, 'utf8')).toBe(`${home}/historical-session\n`);
        expect(existsSync(join(applied.backupDir!, 'manifest.json'))).toBe(true);
    });

    it('rejects malformed supported JSON before writing any file', () => {
        const root = temporaryDirectory();
        const agentDir = join(root, 'agent');
        const home = join(root, 'home');
        const settingsPath = join(agentDir, 'settings.json');
        const queuePath = join(agentDir, '.sdd', 'queue', 'broken.json');

        mkdirSync(join(agentDir, '.sdd', 'queue'), { recursive: true });
        writeFileSync(settingsPath, JSON.stringify({ source: `${home}/projects/pi` }));
        writeFileSync(queuePath, '{not-json');

        expect(() => migrateOperationalState({ agentDir, home, apply: true })).toThrow(
            'Invalid JSON',
        );
        expect(JSON.parse(readFileSync(settingsPath, 'utf8')).source).toBe(
            `${home}/projects/pi`,
        );
    });

    it('converts path keys and serialized JSON while excluding credential-bearing model backups', () => {
        const root = temporaryDirectory();
        const agentDir = join(root, 'agent');
        const home = join(root, 'home');
        const trustPath = join(agentDir, 'trust.json');
        const onboardingPath = join(agentDir, 'mcp-onboarding.json');
        const modelBackupPath = join(agentDir, 'models.backup');

        mkdirSync(agentDir, { recursive: true });
        writeFileSync(trustPath, JSON.stringify({ [home]: true }));
        writeFileSync(
            onboardingPath,
            JSON.stringify({
                fingerprint: JSON.stringify({ importPath: `${home}/.claude.json` }),
                instructions: `Inspect ${home}/projects/pi before continuing.`,
                nonPathText: `${home}-backup is not a home path.`,
            }),
        );
        writeFileSync(
            modelBackupPath,
            JSON.stringify({ apiKey: `!cat ${home}/secret` }),
        );

        const preview = migrateOperationalState({ agentDir, home });
        expect(preview.changedFiles).toEqual([onboardingPath, trustPath]);

        migrateOperationalState({ agentDir, home, apply: true });
        expect(JSON.parse(readFileSync(trustPath, 'utf8'))).toEqual({ '~': true });
        expect(JSON.parse(JSON.parse(readFileSync(onboardingPath, 'utf8')).fingerprint)).toEqual({
            importPath: '~/.claude.json',
        });
        expect(JSON.parse(readFileSync(onboardingPath, 'utf8')).instructions).toBe(
            'Inspect ~/projects/pi before continuing.',
        );
        expect(JSON.parse(readFileSync(onboardingPath, 'utf8')).nonPathText).toBe(
            `${home}-backup is not a home path.`,
        );
        expect(JSON.parse(readFileSync(modelBackupPath, 'utf8')).apiKey).toBe(
            `!cat ${home}/secret`,
        );
    });
});
