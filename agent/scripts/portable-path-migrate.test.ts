import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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
    it.each(['file', 'directory'])('rejects a symlinked project config %s before touching outside state', (kind) => {
        const root = temporaryDirectory();
        const agentDir = join(root, 'agent');
        const workspaceDir = join(root, 'project');
        const home = join(root, 'home');
        const external = join(root, 'external');
        mkdirSync(agentDir);
        mkdirSync(external);
        mkdirSync(join(workspaceDir, '.pi'), { recursive: true });
        const victim = join(external, 'plans.json');
        const bytes = JSON.stringify({ path: `${home}/private` });
        writeFileSync(victim, bytes);
        if (kind === 'directory') symlinkSync(external, join(workspaceDir, '.pi/config'));
        else {
            mkdirSync(join(workspaceDir, '.pi/config'));
            symlinkSync(victim, join(workspaceDir, '.pi/config/plans.json'));
        }
        expect(() => migrateOperationalState({ agentDir, workspaceDir, home, apply: true })).toThrow('Refusing symlink');
        expect(readFileSync(victim, 'utf8')).toBe(bytes);
        expect(existsSync(join(agentDir, '.portable-path-backups'))).toBe(false);
    });
    it('does not follow a project symlink planted at the old temporary filename', () => {
        const root = temporaryDirectory();
        const agentDir = join(root, 'agent');
        const workspaceDir = join(root, 'project');
        const home = join(root, 'home');
        const path = join(workspaceDir, '.pi/config/plans.json');
        const victim = join(root, 'victim.txt');
        mkdirSync(agentDir);
        mkdirSync(join(path, '..'), { recursive: true });
        writeFileSync(path, JSON.stringify({ command: `${home}/bin/review` }));
        writeFileSync(victim, 'unrelated bytes');
        symlinkSync(victim, join(path, '../.plans.json.portable-path-tmp'));
        const result = migrateOperationalState({ agentDir, workspaceDir, home, apply: true });
        expect(readFileSync(victim, 'utf8')).toBe('unrelated bytes');
        expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ command: '~/bin/review' });
        expect(statSync(result.backupDir!).mode & 0o777).toBe(0o700);
        expect(statSync(join(result.backupDir!, 'manifest.json')).mode & 0o777).toBe(0o600);
    });

    it('keeps project backups inside each migration backup directory', () => {
        const root = temporaryDirectory();
        const agentDir = join(root, 'agent');
        const workspaceDir = join(root, 'project');
        const home = join(root, 'home');
        const path = join(workspaceDir, '.pi/config/translate.json');
        mkdirSync(agentDir);
        mkdirSync(join(path, '..'), { recursive: true });
        const original = JSON.stringify({ path: `${home}/first` });
        writeFileSync(path, original);
        const first = migrateOperationalState({ agentDir, workspaceDir, home, apply: true });
        const backupContents = () => readdirSync(first.backupDir!, { recursive: true })
            .map(entry => join(first.backupDir!, String(entry)))
            .filter(file => statSync(file).isFile())
            .map(file => readFileSync(file, 'utf8'));
        expect(backupContents()).toContain(original);
        writeFileSync(path, JSON.stringify({ path: `${home}/second` }));
        const second = migrateOperationalState({ agentDir, workspaceDir, home, apply: true });
        expect(second.backupDir).not.toBe(first.backupDir);
        expect(backupContents()).toContain(original);
    });

    it('converts canonical configuration and operational artifacts while preserving immutable state', () => {
        const root = temporaryDirectory();
        const agentDir = join(root, 'agent');
        const workspaceDir = join(root, 'project');
        const home = join(root, 'home');
        const sources = [
            join(agentDir, 'config/sandbox.json'),
            join(workspaceDir, '.pi/config/translate.json'),
            join(agentDir, 'artifacts/package-finalizer-state.json'),
            join(agentDir, 'artifacts/sdd/queue/run.json'),
        ];
        const immutable = [join(agentDir, 'artifacts/sdd/manifests/run.json'), join(agentDir, '.sdd/manifests/run.json')];
        for (const path of [...sources, ...immutable]) {
            mkdirSync(join(path, '..'), { recursive: true });
            writeFileSync(path, JSON.stringify({ path: `${home}/project` }));
        }
        const preview = migrateOperationalState({ agentDir, workspaceDir, home });
        expect(preview.changedFiles).toEqual(sources.toSorted());
        const result = migrateOperationalState({ agentDir, workspaceDir, home, apply: true });
        expect(result.backupDir).toBeDefined();
        for (const path of sources)
            expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ path: '~/project' });
        for (const path of immutable)
            expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ path: `${home}/project` });
    });

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
