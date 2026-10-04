import { afterEach, expect, test } from 'bun:test';
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
    existsSync,
    symlinkSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, relative } from 'node:path';
import { planLayoutMigration } from './extension-layout-migration.ts';
const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0))
        rmSync(root, { recursive: true, force: true });
});
function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'pi-layout-migrate-'));
    roots.push(root);
    const agentDir = join(root, 'agent'),
        cwd = join(root, 'project');
    mkdirSync(agentDir);
    mkdirSync(cwd);
    return { root, agentDir, cwd };
}
test('refuses an empty preflight after a new legacy source appears', async () => {
    const { applyLayoutMigration } = await import('./extension-layout-migration.ts');
    const { agentDir, cwd } = fixture();
    const plan = planLayoutMigration({ agentDir, projects: [cwd] });
    expect(plan.changes).toEqual([]);
    mkdirSync(join(agentDir, 'save-tokens-telemetry'));
    writeFileSync(join(agentDir, 'save-tokens-telemetry/new.jsonl'), 'new');
    expect(() => applyLayoutMigration(plan)).toThrow('Artifact source inventory changed');
});

test('rejects a relative archive override before scheduling a migration', () => {
    const previous = process.env.PI_TOOL_RESULT_ARCHIVE_DIR;
    try {
        const { agentDir, cwd } = fixture();
        process.env.PI_TOOL_RESULT_ARCHIVE_DIR = 'archives';
        mkdirSync(join(cwd, 'archives'));
        const source = join(cwd, 'archives/1-bash-call-aaaaaaaaaaaa.txt');
        writeFileSync(source, 'archive');
        expect(() => planLayoutMigration({ agentDir, projects: [cwd] })).toThrow('Relative PI_TOOL_RESULT_ARCHIVE_DIR');
        expect(readFileSync(source, 'utf8')).toBe('archive');
        process.env.PI_TOOL_RESULT_ARCHIVE_DIR = join(cwd, 'archives');
        expect(planLayoutMigration({ agentDir, projects: [cwd] }).changes.some(change => change.path === source && change.after === null)).toBe(true);
    } finally {
        if (previous === undefined) delete process.env.PI_TOOL_RESULT_ARCHIVE_DIR;
        else process.env.PI_TOOL_RESULT_ARCHIVE_DIR = previous;
    }
});

test.each(['absolute', 'home-relative'])('rejects a second project claiming a previously moved %s global plan root', async (kind) => {
    const { applyLayoutMigration } = await import('./extension-layout-migration.ts');
    const { root, agentDir, cwd } = fixture();
    const shared = join(root, 'shared-plans');
    const later = join(root, 'later');
    mkdirSync(shared);
    mkdirSync(later);
    writeFileSync(join(shared, 'p.md'), '# plan');
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ plans: { planFileDir: kind === 'absolute' ? shared : `~/${relative(homedir(), shared)}` } }));
    applyLayoutMigration(planLayoutMigration({ agentDir, projects: [cwd] }));
    mkdirSync(join(agentDir, 'sessions'));
    const sessionPath = join(agentDir, 'sessions/later.jsonl');
    const session = JSON.stringify({ type: 'session', cwd: later }) + '\n' + JSON.stringify({ type: 'custom', customType: 'plans:approved', data: { planPath: join(shared, 'p.md') } }) + '\n';
    writeFileSync(sessionPath, session);
    expect(() => planLayoutMigration({ agentDir, projects: [later] })).toThrow('Ambiguous project ownership');
    expect(readFileSync(sessionPath, 'utf8')).toBe(session);
    expect(readFileSync(join(cwd, '.pi/planning/plans/p.md'), 'utf8')).toBe('# plan');
    expect(planLayoutMigration({ agentDir, projects: [cwd] }).changes).toEqual([]);
});
test('leaves external subagent transcripts inside session artifacts untouched', () => {
    const { agentDir, cwd } = fixture();
    const directory = join(agentDir, 'sessions/--project--/subagent-artifacts');
    mkdirSync(directory, { recursive: true });
    const transcript = join(directory, 'run_reviewer_transcript.jsonl');
    const bytes = JSON.stringify({ role: 'assistant', content: 'Historical transcript' }) + '\n';
    writeFileSync(transcript, bytes);
    const plan = planLayoutMigration({ agentDir, projects: [cwd] });
    expect(plan.changes).toEqual([]);
    expect(readFileSync(transcript, 'utf8')).toBe(bytes);
});

test('dry run identifies owned settings and preserves every input byte', () => {
    const { agentDir, cwd } = fixture();
    const settings =
        '{ "model": "keep", "plans": { "autoExecute": false }, "subagents": { "agentOverrides": {} }, "piSubagentsAddons": {"generatedToolOverrides":{}} }\n';
    writeFileSync(join(agentDir, 'settings.json'), settings);
    const plan = planLayoutMigration({ agentDir, projects: [cwd] });
    expect(plan.changes.length).toBeGreaterThan(0);
    expect(readFileSync(join(agentDir, 'settings.json'), 'utf8')).toBe(
        settings,
    );
    expect(existsSync(join(agentDir, 'config'))).toBe(false);
});

test('leaves a shared global plan root unclaimed when the selected project overrides it', async () => {
    const { applyLayoutMigration } = await import('./extension-layout-migration.ts');
    const { root, agentDir, cwd } = fixture();
    const shared = join(root, 'shared-plans'), own = join(cwd, 'docs/plans'), later = join(root, 'later');
    mkdirSync(shared);
    mkdirSync(own, { recursive: true });
    mkdirSync(join(cwd, '.pi'));
    mkdirSync(later);
    writeFileSync(join(shared, 'global.md'), '# global');
    writeFileSync(join(own, 'own.md'), '# own');
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ plans: { planFileDir: shared } }));
    writeFileSync(join(cwd, '.pi/settings.json'), JSON.stringify({ plans: { planFileDir: 'docs/plans' } }));
    applyLayoutMigration(planLayoutMigration({ agentDir, projects: [cwd], artifactSources: [own] }));
    expect(planLayoutMigration({ agentDir, projects: [cwd] }).changes).toEqual([]);
    expect(readFileSync(join(shared, 'global.md'), 'utf8')).toBe('# global');
    applyLayoutMigration(planLayoutMigration({ agentDir, projects: [later] }));
    expect(readFileSync(join(later, '.pi/planning/plans/global.md'), 'utf8')).toBe('# global');
    expect(planLayoutMigration({ agentDir, projects: [cwd, later] }).changes).toEqual([]);
});

test('requires recovery when all migration writes landed but the journal is still applying', async () => {
    const { applyLayoutMigration, recoverLayoutMigration } = await import('./extension-layout-migration.ts');
    const { agentDir, cwd } = fixture();
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ plans: { autoExecute: false } }));
    const plan = planLayoutMigration({ agentDir, projects: [cwd] });
    const journal = applyLayoutMigration(plan);
    if (!journal) throw new Error('Expected a migration journal');
    writeFileSync(journal, JSON.stringify({ ...plan, state: 'applying' }));
    const repeated = planLayoutMigration({ agentDir, projects: [cwd] });
    expect(repeated.changes).toEqual([]);
    expect(() => applyLayoutMigration(repeated)).toThrow('Unfinished migration');
    recoverLayoutMigration(journal, 'resume');
    expect(applyLayoutMigration(repeated)).toBeUndefined();
});

test.each(['apply', 'resume'])('refuses %s when new source artifacts appeared after preflight', async (action) => {
    const { applyLayoutMigration, recoverLayoutMigration } = await import('./extension-layout-migration.ts');
    const { agentDir, cwd } = fixture();
    const source = join(agentDir, 'save-tokens-telemetry');
    mkdirSync(source);
    writeFileSync(join(source, 'old.jsonl'), 'old');
    const plan = planLayoutMigration({ agentDir, projects: [cwd] });
    writeFileSync(join(source, 'new.jsonl'), 'new');
    const journal = join(agentDir, 'interrupted.json');
    writeFileSync(journal, JSON.stringify({ ...plan, state: 'applying' }));
    expect(() => action === 'apply' ? applyLayoutMigration(plan) : recoverLayoutMigration(journal, 'resume')).toThrow('Artifact source inventory changed');
    expect(readFileSync(join(source, 'old.jsonl'), 'utf8')).toBe('old');
    expect(readFileSync(join(source, 'new.jsonl'), 'utf8')).toBe('new');
    expect(existsSync(join(agentDir, 'artifacts/save-tokens-telemetry/old.jsonl'))).toBe(false);
});

test.each(['safeBash', 'saveTokens'])('requires an unambiguous global %s telemetry root before removing its override', async (owner) => {
    const { applyLayoutMigration } = await import('./extension-layout-migration.ts');
    const { agentDir, cwd } = fixture();
    const directory = join(cwd, 'telemetry');
    mkdirSync(directory);
    const source = join(directory, 'events.jsonl');
    writeFileSync(source, 'telemetry bytes');
    const settingsPath = join(agentDir, 'settings.json');
    const settings = JSON.stringify({ [owner]: { telemetry: { directory: 'telemetry' } } });
    writeFileSync(settingsPath, settings);
    expect(() => planLayoutMigration({ agentDir, projects: [cwd] })).toThrow('Relative global telemetry directory');
    expect(readFileSync(settingsPath, 'utf8')).toBe(settings);
    expect(readFileSync(source, 'utf8')).toBe('telemetry bytes');
    writeFileSync(settingsPath, JSON.stringify({ [owner]: { telemetry: { directory } } }));
    applyLayoutMigration(planLayoutMigration({ agentDir, projects: [cwd] }));
    const destination = owner === 'safeBash' ? 'safe-bash-telemetry' : 'save-tokens-telemetry';
    expect(readFileSync(join(agentDir, 'artifacts', destination, 'events.jsonl'), 'utf8')).toBe('telemetry bytes');
    expect(existsSync(source)).toBe(false);
});

test.each(['safeBash', 'saveTokens', 'plans'])(
    'rejects external migration sources supplied by project %s settings',
    (owner) => {
        const { root, agentDir, cwd } = fixture();
        const external = join(root, 'project-outside');
        mkdirSync(external);
        const source = join(external, 'keep.md');
        writeFileSync(source, 'external bytes');
        mkdirSync(join(cwd, '.pi'));
        const settingsPath = join(cwd, '.pi/settings.json');
        const settings = JSON.stringify({
            [owner]: owner === 'plans'
                ? { planFileDir: external }
                : { telemetry: { directory: external } },
        });
        writeFileSync(settingsPath, settings);

        expect(() => planLayoutMigration({ agentDir, projects: [cwd] })).toThrow(
            'Project configuration cannot authorize a migration source',
        );
        expect(readFileSync(source, 'utf8')).toBe('external bytes');
        expect(readFileSync(settingsPath, 'utf8')).toBe(settings);
        expect(existsSync(join(agentDir, 'artifacts'))).toBe(false);
    },
);

test('project migration rejects symlink sources that escape the project', () => {
    const { root, agentDir, cwd } = fixture();
    const external = join(root, 'external');
    mkdirSync(external);
    writeFileSync(join(external, 'keep.md'), 'external bytes');
    symlinkSync(external, join(cwd, 'telemetry'));
    mkdirSync(join(cwd, '.pi'));
    writeFileSync(join(cwd, '.pi/settings.json'), JSON.stringify({
        safeBash: { telemetry: { directory: 'telemetry' } },
    }));
    expect(() => planLayoutMigration({ agentDir, projects: [cwd], artifactSources: [join(cwd, 'telemetry')] })).toThrow('Refusing symlink');
    expect(readFileSync(join(external, 'keep.md'), 'utf8')).toBe('external bytes');
});

test.each(['safeBash', 'saveTokens', 'plans'])(
    'requires operator selection for project-authored %s source even when its files look managed',
    (owner) => {
        const { agentDir, cwd } = fixture();
        const source = join(cwd, 'src');
        mkdirSync(join(source, '2026-10-03'), { recursive: true });
        const file = join(source, '2026-10-03', owner === 'plans' ? 'customer.md' : 'customer.jsonl');
        writeFileSync(file, 'unrelated customer data');
        mkdirSync(join(cwd, '.pi'));
        writeFileSync(join(cwd, '.pi/settings.json'), JSON.stringify({
            [owner]: owner === 'plans' ? { planFileDir: 'src' } : { telemetry: { directory: 'src' } },
        }));
        expect(() => planLayoutMigration({ agentDir, projects: [cwd] })).toThrow('Project configuration cannot authorize a migration source');
        expect(readFileSync(file, 'utf8')).toBe('unrelated customer data');
    },
);

test.each(['.', '.pi', 'src', '.pi/config/sandbox.json'])(
    'rejects project telemetry source %s containing unrelated project state',
    (directory) => {
        const { agentDir, cwd } = fixture();
        mkdirSync(join(cwd, '.pi/config'), { recursive: true });
        mkdirSync(join(cwd, 'src'));
        const retained = {
            'README.md': '# Keep this project',
            'src/main.ts': 'export const keep = true;',
            '.pi/config/sandbox.json': '{}',
            '.pi/settings.json': JSON.stringify({ safeBash: { telemetry: { directory } } }),
        };
        for (const [path, bytes] of Object.entries(retained)) writeFileSync(join(cwd, path), bytes);
        expect(() => planLayoutMigration({ agentDir, projects: [cwd] })).toThrow('Project configuration cannot authorize a migration source');
        for (const [path, bytes] of Object.entries(retained)) expect(readFileSync(join(cwd, path), 'utf8')).toBe(bytes);
        expect(existsSync(join(agentDir, 'artifacts'))).toBe(false);
    },
);

test('CLI migrates an external project source only when the operator selects that exact root', async () => {
    const { root, agentDir, cwd } = fixture();
    const external = join(root, 'external');
    const { createPrivateTelemetryWriter } = await import('../private-telemetry/storage.ts');
    const writer = createPrivateTelemetryWriter<{ timestamp: string }>({
        root: external, sessionId: 'trace', scopeName: 'fixture', timestampOf: (event) => event.timestamp,
    });
    await writer.append({ timestamp: '2026-10-03T00:00:00Z' });
    const source = join(external, '2026-10-03/trace.jsonl');
    const bytes = readFileSync(source, 'utf8');
    mkdirSync(join(cwd, '.pi'));
    const settingsPath = join(cwd, '.pi/settings.json');
    const settings = JSON.stringify({ saveTokens: { telemetry: { directory: external } } });
    writeFileSync(settingsPath, settings);
    const script = join(import.meta.dir, '../../../bin/migrate-extension-layout.ts');
    const invoke = (selected: string) => Bun.spawnSync([
        process.execPath, script, '--agent-dir', agentDir, '--project', cwd,
        '--artifact-source', selected, '--apply', '--pi-stopped', '--json',
    ], { stdout: 'pipe', stderr: 'pipe' });

    const parent = invoke(root);
    expect(parent.exitCode).toBe(1);
    expect(parent.stderr.toString()).toContain('Project configuration cannot authorize');
    expect(readFileSync(settingsPath, 'utf8')).toBe(settings);
    expect(readFileSync(source, 'utf8')).toBe(bytes);

    const selected = invoke(external);
    expect(selected.stderr.toString()).toBe('');
    expect(selected.exitCode).toBe(0);
    expect(JSON.parse(selected.stdout.toString())).toMatchObject({ status: 'complete' });
    expect(readFileSync(join(agentDir, 'artifacts/save-tokens-telemetry/2026-10-03/trace.jsonl'), 'utf8')).toBe(bytes);
    expect(existsSync(source)).toBe(false);
}, 30_000);

test.each([
    ['safeBash', 'safe-bash-telemetry'],
    ['saveTokens', 'save-tokens-telemetry'],
])('migrates a dedicated project %s telemetry directory', async (owner, destination) => {
    const { agentDir, cwd } = fixture();
    const { createPrivateTelemetryWriter } = await import('../private-telemetry/storage.ts');
    const { applyLayoutMigration } = await import('./extension-layout-migration.ts');
    const writer = createPrivateTelemetryWriter<{ timestamp: string }>({
        root: join(cwd, 'telemetry'), sessionId: 'trace', scopeName: 'fixture', timestampOf: (event) => event.timestamp,
    });
    await writer.append({ timestamp: '2026-10-03T00:00:00Z' });
    const source = join(cwd, 'telemetry/2026-10-03/trace.jsonl');
    const bytes = readFileSync(source);
    mkdirSync(join(cwd, '.pi'));
    writeFileSync(join(cwd, '.pi/settings.json'), JSON.stringify({ [owner]: { telemetry: { directory: 'telemetry' } } }));
    applyLayoutMigration(planLayoutMigration({ agentDir, projects: [cwd], artifactSources: [join(cwd, 'telemetry')] }));
    expect(readFileSync(join(agentDir, 'artifacts', destination, '2026-10-03/trace.jsonl'))).toEqual(bytes);
    expect(existsSync(source)).toBe(false);
});

test('operator-owned global plan settings authorize their configured external source', async () => {
    const { root, agentDir, cwd } = fixture();
    const { applyLayoutMigration } = await import('./extension-layout-migration.ts');
    const external = join(root, 'plans');
    mkdirSync(external);
    writeFileSync(join(external, 'plan.md'), '# Approved external plan');
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ plans: { planFileDir: external } }));
    applyLayoutMigration(planLayoutMigration({ agentDir, projects: [cwd] }));
    expect(readFileSync(join(cwd, '.pi/planning/plans/plan.md'), 'utf8')).toBe('# Approved external plan');
    expect(existsSync(join(external, 'plan.md'))).toBe(false);
    expect(planLayoutMigration({ agentDir, projects: [cwd] }).changes).toEqual([]);
});

test('apply preserves core settings and external ledgers and supports byte-exact rollback', async () => {
    const { agentDir, cwd } = fixture();
    const { applyLayoutMigration, recoverLayoutMigration } =
        await import('./extension-layout-migration.ts');
    const settings = {
        model: 'keep',
        plans: { autoExecute: false },
        subagents: { agentOverrides: { x: { tools: ['read'] } } },
        piSubagentsAddons: { generatedToolOverrides: { version: 1 } },
    };
    const original = JSON.stringify(settings);
    writeFileSync(join(agentDir, 'settings.json'), original);
    const journal = applyLayoutMigration(
        planLayoutMigration({ agentDir, projects: [cwd] }),
    )!;
    expect(
        JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8')),
    ).toEqual({
        model: settings.model,
        subagents: settings.subagents,
        piSubagentsAddons: settings.piSubagentsAddons,
    });
    expect(
        JSON.parse(readFileSync(join(agentDir, 'config/plans.json'), 'utf8')),
    ).toEqual({ autoExecute: false });
    expect(planLayoutMigration({ agentDir, projects: [cwd] }).changes).toEqual(
        [],
    );
    recoverLayoutMigration(journal, 'rollback');
    expect(readFileSync(join(agentDir, 'settings.json'), 'utf8')).toBe(
        original,
    );
    expect(existsSync(join(agentDir, 'config/plans.json'))).toBe(false);
});

test('migrates package lifecycle project settings and applies them only after persisted trust', async () => {
    const { agentDir, cwd } = fixture();
    const { ProjectTrustStore } = await import('@earendil-works/pi-coding-agent');
    const { loadPackageLifecycleTrustConfig } = await import('../package-install/config.ts');
    const { applyLayoutMigration } = await import('./extension-layout-migration.ts');
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({
        packageLifecycleTrust: { confirm: true },
    }));
    mkdirSync(join(cwd, '.pi'));
    writeFileSync(join(cwd, '.pi/settings.json'), JSON.stringify({
        model: 'keep', packageLifecycleTrust: { showStatus: false },
    }));
    applyLayoutMigration(planLayoutMigration({ agentDir, projects: [cwd] }));
    const trust = new ProjectTrustStore(agentDir);
    for (const decision of [null, false, true]) {
        trust.set(cwd, decision);
        expect(loadPackageLifecycleTrustConfig(cwd, agentDir)).toEqual({
            confirm: true, showStatus: decision !== true,
        });
    }
    expect(JSON.parse(readFileSync(join(cwd, '.pi/settings.json'), 'utf8'))).toEqual({ model: 'keep' });
    expect(JSON.parse(readFileSync(join(cwd, '.pi/config/package-finalizer.json'), 'utf8'))).toEqual({ showStatus: false });
    expect(planLayoutMigration({ agentDir, projects: [cwd] }).changes).toEqual([]);
});
test('conflicting configuration and stale preflight fail before changing files', async () => {
    const { agentDir, cwd } = fixture();
    const { applyLayoutMigration } =
        await import('./extension-layout-migration.ts');
    writeFileSync(join(agentDir, 'slow-mode.json'), '{"read":false}');
    const plan = planLayoutMigration({ agentDir, projects: [cwd] });
    writeFileSync(join(agentDir, 'slow-mode.json'), '{"read":true}');
    expect(() => applyLayoutMigration(plan)).toThrow('Preflight is stale');
    mkdirSync(join(agentDir, 'config'));
    writeFileSync(join(agentDir, 'config/slow-mode.json'), '{}');
    expect(() => planLayoutMigration({ agentDir, projects: [cwd] })).toThrow(
        'Configuration conflict',
    );
});
test('moves plans and durable artifacts, rewrites operational references, and leaves SDD manifests immutable', async () => {
    const { agentDir, cwd } = fixture();
    const { applyLayoutMigration } =
        await import('./extension-layout-migration.ts');
    function write(path: string, value: string) {
        mkdirSync(join(path, '..'), { recursive: true });
        writeFileSync(path, value);
    }
    const oldPlan = join(cwd, 'docs/plans/proposal.md'),
        newPlan = join(cwd, '.pi/planning/plans/proposal.md');
    write(oldPlan, '# Approved plan\n');
    write(
        join(agentDir, 'settings.json'),
        JSON.stringify({
            plans: { planFileDir: 'docs/plans', autoExecute: false },
        }),
    );
    const manifest = JSON.stringify({
        manifestId: 'immutable',
        planPath: oldPlan,
        sourceDigest: 'unchanged',
    });
    write(join(agentDir, '.sdd/manifests/run.json'), manifest);
    write(join(agentDir, 'cache/models-dev-catalog-v1.json'), 'cached bytes');
    write(join(cwd, '.pi/session-plans/topic/v001.md'), '# Session plan\n');
    write(
        join(cwd, '.pi/session-plans/topic/manifest.json'),
        JSON.stringify({
            version: 1,
            root: '.pi/session-plans/topic',
            versions: [{ version: 1, path: '.pi/session-plans/topic/v001.md' }],
        }),
    );
    const entries = [
        { type: 'session', id: 'session', cwd },
        {
            type: 'custom',
            id: 'revision',
            parentId: null,
            customType: 'plan-review-guard:revision',
            data: { path: 'docs/plans/proposal.md', revision: 7 },
        },
        {
            type: 'custom',
            id: 'approved',
            parentId: 'revision',
            customType: 'plans:approved',
            data: {
                planPath: oldPlan,
                contentHash: 'unchanged',
                autoExecute: false,
            },
        },
    ];
    write(
        join(agentDir, 'sessions/project/run.jsonl'),
        entries.map((e) => JSON.stringify(e)).join('\n') + '\n',
    );
    applyLayoutMigration(planLayoutMigration({ agentDir, projects: [cwd] }));
    expect(existsSync(newPlan)).toBe(true);
    expect(existsSync(oldPlan)).toBe(false);
    expect(
        readFileSync(
            join(agentDir, 'artifacts/sdd/manifests/run.json'),
            'utf8',
        ),
    ).toBe(manifest);
    expect(
        readFileSync(
            join(agentDir, 'artifacts/cache/models-dev-catalog-v1.json'),
            'utf8',
        ),
    ).toBe('cached bytes');
    expect(
        JSON.parse(
            readFileSync(
                join(cwd, '.pi/planning/session-plans/topic/manifest.json'),
                'utf8',
            ),
        ),
    ).toHaveProperty('versions.0.path', '.pi/planning/session-plans/topic/v001.md');
    const migrated = readFileSync(
        join(agentDir, 'sessions/project/run.jsonl'),
        'utf8',
    )
        .trim()
        .split('\n')
        .map((line): unknown => JSON.parse(line));
    expect(migrated[1]).toEqual({
        ...entries[1],
        data: { path: '.pi/planning/plans/proposal.md', revision: 7 },
    });
    expect(migrated[2]).toEqual({
        ...entries[2],
        data: {
            planPath: newPlan,
            contentHash: 'unchanged',
            autoExecute: false,
        },
    });
    expect(planLayoutMigration({ agentDir, projects: [cwd] }).changes).toEqual(
        [],
    );
});

test('relocates SQLite archive references without changing project identity', async () => {
    const { Database } = await import('bun:sqlite');
    const { applyLayoutMigration } =
        await import('./extension-layout-migration.ts');
    const { agentDir, cwd } = fixture();
    const oldRoot = join(agentDir, 'think-in-code/projects/key'),
        newRoot = join(agentDir, 'artifacts/think-in-code/projects/key');
    mkdirSync(join(oldRoot, 'archives'), { recursive: true });
    writeFileSync(join(oldRoot, 'archives/a.txt'), 'archive');
    const db = new Database(join(oldRoot, 'store.sqlite'));
    db.run(
        'PRAGMA journal_mode=WAL; CREATE TABLE archives (id TEXT PRIMARY KEY, archive_path TEXT); CREATE TABLE project_meta (key TEXT PRIMARY KEY,value TEXT);',
    );
    db.query('INSERT INTO archives VALUES (?,?)').run(
        'a',
        join(oldRoot, 'archives/a.txt'),
    );
    db.query('INSERT INTO project_meta VALUES (?,?)').run(
        'canonical_path',
        cwd,
    );
    db.close();
    const before = readFileSync(join(oldRoot, 'store.sqlite'));
    const plan = planLayoutMigration({ agentDir, projects: [cwd] });
    expect(readFileSync(join(oldRoot, 'store.sqlite'))).toEqual(before);
    applyLayoutMigration(plan);
    const migrated = new Database(join(newRoot, 'store.sqlite'), {
        readonly: true,
    });
    try {
        expect(
            migrated.query('SELECT archive_path FROM archives').get(),
        ).toEqual({ archive_path: join(newRoot, 'archives/a.txt') });
        expect(
            migrated
                .query(
                    "SELECT value FROM project_meta WHERE key='canonical_path'",
                )
                .get(),
        ).toEqual({ value: cwd });
    } finally {
        migrated.close();
    }
});

test('moves historical Think repair backups byte-for-byte without repairing their references', async () => {
    const { Database } = await import('bun:sqlite');
    const { applyLayoutMigration, recoverLayoutMigration } = await import('./extension-layout-migration.ts');
    const { agentDir, cwd } = fixture();
    const source = join(agentDir, 'think-in-code/repair-backups/old-repair/store.sqlite');
    const destination = join(agentDir, 'artifacts/think-in-code/repair-backups/old-repair/store.sqlite');
    mkdirSync(join(source, '..'), { recursive: true });
    const db = new Database(source);
    db.run('CREATE TABLE archives (id TEXT PRIMARY KEY, archive_path TEXT)');
    db.query('INSERT INTO archives VALUES (?, ?)').run('lost', join(agentDir, 'think-in-code/projects/old/archives/missing.bin'));
    db.close();
    const bytes = readFileSync(source);
    const journal = applyLayoutMigration(planLayoutMigration({ agentDir, projects: [cwd] }));
    expect(readFileSync(destination)).toEqual(bytes);
    expect(existsSync(source)).toBe(false);
    recoverLayoutMigration(journal!, 'rollback');
    expect(readFileSync(source)).toEqual(bytes);
    expect(existsSync(destination)).toBe(false);
});

test('recovery resumes an interrupted write and refuses subsequent edits', async () => {
    const { agentDir, cwd } = fixture();
    const { recoverLayoutMigration } =
        await import('./extension-layout-migration.ts');
    writeFileSync(join(agentDir, 'slow-mode.json'), '{"read":false}');
    const plan = planLayoutMigration({ agentDir, projects: [cwd] });
    const journal = join(agentDir, 'journal.json');
    writeFileSync(journal, JSON.stringify({ ...plan, state: 'applying' }));
    const created = plan.changes.find((change) => change.after !== null)!;
    mkdirSync(join(created.path, '..'), { recursive: true });
    writeFileSync(created.path, Buffer.from(created.after!.data, 'base64'), {
        mode: created.after!.mode,
    });
    recoverLayoutMigration(journal, 'resume');
    expect(existsSync(join(agentDir, 'slow-mode.json'))).toBe(false);
    writeFileSync(created.path, 'edited later');
    expect(() => recoverLayoutMigration(journal, 'rollback')).toThrow(
        'Migration recovery conflict',
    );
    expect(readFileSync(created.path, 'utf8')).toBe('edited later');
});
test.each([
    ['.pi/plans/approved.md', '.pi/planning/plans/approved.md'],
    ['.pi/session-plans/topic/v001.md', '.pi/planning/session-plans/topic/v001.md'],
    ['docs/brainstorms/topic/proposal.md', '.pi/artifacts/brainstorms/topic/proposal.md'],
])('migrated plan lookup preserves approved source %s and verifies its bytes', async (oldPath, newPath) => {
    const { agentDir, cwd } = fixture();
    const { applyLayoutMigration } =
        await import('./extension-layout-migration.ts');
    const { resolveMigratedPlanPath } =
        await import('../migrated-plan-path.ts');
    const source = join(cwd, oldPath);
    mkdirSync(join(source, '..'), { recursive: true });
    writeFileSync(source, '# Approved\n');
    const manifest = JSON.stringify({ planPath: source, sourceDigest: 'immutable-digest' });
    mkdirSync(join(agentDir, '.sdd/manifests'), { recursive: true });
    writeFileSync(join(agentDir, '.sdd/manifests/approved.json'), manifest);
    applyLayoutMigration(planLayoutMigration({ agentDir, projects: [cwd] }));
    const target = join(cwd, newPath);
    expect(readFileSync(join(agentDir, 'artifacts/sdd/manifests/approved.json'), 'utf8')).toBe(manifest);
    expect(resolveMigratedPlanPath(source, cwd, agentDir)).toBe(target);
    expect(resolveMigratedPlanPath('unrelated.md', cwd, agentDir)).toBe(
        join(cwd, 'unrelated.md'),
    );
    writeFileSync(target, '# Changed\n');
    expect(() => resolveMigratedPlanPath(source, cwd, agentDir)).toThrow(
        'content changed',
    );
});

test('later project migrations retain the original global plan root', async () => {
    const { agentDir, cwd, root } = fixture();
    const { applyLayoutMigration } =
        await import('./extension-layout-migration.ts');
    const second = join(root, 'second');
    mkdirSync(second);
    writeFileSync(
        join(agentDir, 'settings.json'),
        JSON.stringify({ plans: { planFileDir: 'docs/plans' } }),
    );
    for (const project of [cwd, second]) {
        mkdirSync(join(project, 'docs/plans'), { recursive: true });
        writeFileSync(join(project, 'docs/plans/plan.md'), '# Plan');
    }
    applyLayoutMigration(planLayoutMigration({ agentDir, projects: [cwd] }));
    applyLayoutMigration(planLayoutMigration({ agentDir, projects: [second] }));
    expect(
        readFileSync(join(second, '.pi/planning/plans/plan.md'), 'utf8'),
    ).toBe('# Plan');
    expect(
        planLayoutMigration({ agentDir, projects: [cwd, second] }).changes,
    ).toEqual([]);
});

test('repeated migration preserves a project plan root override over the global default', async () => {
    const { agentDir, cwd } = fixture();
    const { applyLayoutMigration } = await import('./extension-layout-migration.ts');
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ plans: { planFileDir: 'docs/global' } }));
    mkdirSync(join(cwd, '.pi'));
    writeFileSync(join(cwd, '.pi/settings.json'), JSON.stringify({ plans: { planFileDir: 'docs/custom' } }));
    for (const directory of ['global', 'custom']) {
        mkdirSync(join(cwd, 'docs', directory), { recursive: true });
        writeFileSync(join(cwd, 'docs', directory, `${directory}.md`), `# ${directory}`);
    }
    applyLayoutMigration(planLayoutMigration({ agentDir, projects: [cwd], artifactSources: [join(cwd, 'docs/custom')] }));
    expect(readFileSync(join(cwd, '.pi/planning/plans/custom.md'), 'utf8')).toBe('# custom');
    expect(planLayoutMigration({ agentDir, projects: [cwd] }).changes).toEqual([]);
    expect(readFileSync(join(cwd, 'docs/global/global.md'), 'utf8')).toBe('# global');
});

test('nested manifest roots move with their files', async () => {
    const { agentDir, cwd } = fixture();
    const { applyLayoutMigration } =
        await import('./extension-layout-migration.ts');
    mkdirSync(join(cwd, '.pi/session-plans/topic'), { recursive: true });
    writeFileSync(
        join(cwd, '.pi/session-plans/topic/manifest.json'),
        JSON.stringify({ root: '.pi/session-plans/topic' }),
    );
    applyLayoutMigration(planLayoutMigration({ agentDir, projects: [cwd] }));
    expect(
        JSON.parse(
            readFileSync(
                join(cwd, '.pi/planning/session-plans/topic/manifest.json'),
                'utf8',
            ),
        ),
    ).toHaveProperty('root', '.pi/planning/session-plans/topic');
});

test('migrates legacy queued absolute plan references without rewriting immutable manifests', async () => {
    const { agentDir, cwd } = fixture();
    const { applyLayoutMigration } =
        await import('./extension-layout-migration.ts');
    const source = join(cwd, '.pi/plans/plan.md');
    mkdirSync(join(source, '..'), { recursive: true });
    writeFileSync(source, '# Plan');
    mkdirSync(join(agentDir, '.sdd/queue'), { recursive: true });
    writeFileSync(
        join(agentDir, '.sdd/queue/run.json'),
        JSON.stringify({ runId: 'run', planPath: source }),
    );
    applyLayoutMigration(planLayoutMigration({ agentDir, projects: [cwd] }));
    expect(
        JSON.parse(
            readFileSync(
                join(agentDir, 'artifacts/sdd/queue/run.json'),
                'utf8',
            ),
        ),
    ).toHaveProperty('planPath', join(cwd, '.pi/planning/plans/plan.md'));
});

test.each(['absolute', 'relative'])('updates canonical SDD queue references during a later project migration (%s)', async (kind) => {
    const { applyLayoutMigration, recoverLayoutMigration } = await import('./extension-layout-migration.ts');
    const { root, agentDir, cwd } = fixture();
    const later = join(root, 'later-project');
    const source = join(later, '.pi/plans/p.md');
    mkdirSync(join(later, '.pi/plans'), { recursive: true });
    writeFileSync(source, '# Later plan');
    mkdirSync(join(agentDir, '.sdd/queue'), { recursive: true });
    const queued = { runId: 'run', planPath: kind === 'absolute' ? source : '.pi/plans/p.md', ...(kind === 'relative' ? { cwd: later } : {}) };
    writeFileSync(join(agentDir, '.sdd/queue/run.json'), JSON.stringify(queued));
    applyLayoutMigration(planLayoutMigration({ agentDir, projects: [cwd] }));
    const queuePath = join(agentDir, 'artifacts/sdd/queue/run.json');
    const before = readFileSync(queuePath);
    const journal = applyLayoutMigration(planLayoutMigration({ agentDir, projects: [later] }));
    if (!journal) throw new Error('Expected a migration journal for the later project');
    expect(JSON.parse(readFileSync(queuePath, 'utf8'))).toEqual({ ...queued, planPath: kind === 'absolute' ? join(later, '.pi/planning/plans/p.md') : '.pi/planning/plans/p.md' });
    expect(existsSync(source)).toBe(false);
    expect(planLayoutMigration({ agentDir, projects: [later] }).changes).toEqual([]);
    recoverLayoutMigration(journal, 'rollback');
    expect(readFileSync(queuePath)).toEqual(before);
    expect(readFileSync(source, 'utf8')).toBe('# Later plan');
});

test('archive migration leaves unrelated files at the source', async () => {
    const { agentDir, cwd } = fixture();
    const { applyLayoutMigration } =
        await import('./extension-layout-migration.ts');
    const source = join(agentDir, 'tool-result-archive');
    mkdirSync(source);
    const filename = '123-bash-call-aaaaaaaaaaaa.txt';
    writeFileSync(join(source, filename), 'output');
    writeFileSync(join(source, 'notes.txt'), 'unrelated');
    applyLayoutMigration(planLayoutMigration({ agentDir, projects: [cwd] }));
    expect(readFileSync(join(source, 'notes.txt'), 'utf8')).toBe('unrelated');
    expect(
        readFileSync(
            join(agentDir, 'artifacts/tool-result-archive', filename),
            'utf8',
        ),
    ).toBe('output');
});

test('preserves source permissions when the migration process has a stricter umask', async () => {
    const { agentDir, cwd } = fixture();
    const { applyLayoutMigration } =
        await import('./extension-layout-migration.ts');
    const { chmodSync, statSync } = await import('node:fs');
    const source = join(agentDir, 'package-finalizer-state.json');
    writeFileSync(source, '{}');
    chmodSync(source, 0o640);
    const previous = process.umask(0o077);
    try {
        applyLayoutMigration(
            planLayoutMigration({ agentDir, projects: [cwd] }),
        );
        expect(
            statSync(join(agentDir, 'artifacts/package-finalizer-state.json'))
                .mode & 0o777,
        ).toBe(0o640);
    } finally {
        process.umask(previous);
    }
});

test('CLI dry-run is private and JSON recovery reports remain machine-readable', () => {
    const { agentDir, cwd } = fixture();
    const script = join(
        import.meta.dir,
        '../../../bin/migrate-extension-layout.ts',
    );
    const settings = JSON.stringify({
        plans: { browserCommand: 'private-fixture-value' },
    });
    writeFileSync(join(agentDir, 'settings.json'), settings);
    const invoke = (args: string[]) =>
        Bun.spawnSync([process.execPath, script, ...args], {
            stdout: 'pipe',
            stderr: 'pipe',
        });
    const flags = ['--agent-dir', agentDir, '--project', cwd, '--json'];
    const preview = invoke(flags);
    expect(preview.exitCode).toBe(0);
    expect(JSON.parse(preview.stdout.toString())).toMatchObject({ status: 'dry-run' });
    expect(preview.stdout.toString()).not.toContain('private-fixture-value');
    expect(readFileSync(join(agentDir, 'settings.json'), 'utf8')).toBe(
        settings,
    );
    expect(invoke([...flags, '--apply']).exitCode).toBe(1);
    const applied = invoke([...flags, '--apply', '--pi-stopped']);
    expect(applied.exitCode).toBe(0);
    const report: unknown = JSON.parse(applied.stdout.toString());
    if (!report || typeof report !== 'object' || !('journal' in report) || typeof report.journal !== 'string')
        throw new Error('Expected the CLI to return a journal path');
    const rollback = invoke(['--rollback', report.journal, '--pi-stopped', '--json']);
    expect(rollback.exitCode).toBe(0);
    expect(JSON.parse(rollback.stdout.toString())).toMatchObject({ status: 'rolled-back' });
    expect(readFileSync(join(agentDir, 'settings.json'), 'utf8')).toBe(
        settings,
    );
}, 30_000);
