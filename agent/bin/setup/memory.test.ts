import { Database } from 'bun:sqlite';
import { test, expect } from 'bun:test';
import {
    mkdtempSync,
    mkdirSync,
    writeFileSync,
    readFileSync,
    rmSync,
    existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJson } from './files.ts';
import { exportGlobalMemory, importGlobalMemory } from './memory.ts';

test('legacy Hermes configuration selects the migrated global memory directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-setup-legacy-memory-'));
    try {
        const agent = join(root, 'agent');
        mkdirSync(join(agent, 'pi-hermes-memory'), { recursive: true });
        writeFileSync(
            join(agent, 'pi-hermes-memory/MEMORY.md'),
            'Migrated knowledge',
        );
        writeJson(join(agent, 'hermes-memory-config.json'), {
            memoryDir: join(agent, 'memory'),
        });
        await exportGlobalMemory(agent, join(root, 'export.json'));
        expect(readFileSync(join(root, 'export.json'), 'utf8')).toContain(
            'Migrated knowledge',
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('memory transfer excludes project entries and conversations and rebuilds searchable global memory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-setup-memory-'));
    try {
        const source = join(root, 'alice/agent'),
            target = join(root, 'bob/agent');
        mkdirSync(join(source, 'pi-hermes-memory'), { recursive: true });
        mkdirSync(target, { recursive: true });
        writeFileSync(
            join(source, 'pi-hermes-memory/MEMORY.md'),
            'Prefer deterministic tools',
        );
        writeFileSync(
            join(source, 'pi-hermes-memory/USER.md'),
            'Concise answers',
        );
        writeFileSync(
            join(source, 'pi-hermes-memory/STANDING.md'),
            'Never publish automatically',
        );
        writeFileSync(
            join(source, 'pi-hermes-memory/failures.md'),
            '[failure] Global failure\n§\n[failure] Project-only failure <!-- created=2026-01-01, last=2026-01-01, project64=cHJvamVjdA -->',
        );
        writeFileSync(
            join(source, 'pi-hermes-memory/session.jsonl'),
            'PRIVATE TRANSCRIPT',
        );
        const archive = join(root, 'memory.json');
        await exportGlobalMemory(source, archive);
        expect(readFileSync(archive, 'utf8')).not.toContain('Project-only');
        expect(readFileSync(archive, 'utf8')).not.toContain(
            'PRIVATE TRANSCRIPT',
        );
        await importGlobalMemory(target, archive);
        await importGlobalMemory(target, archive);
        expect(
            readFileSync(join(target, 'pi-hermes-memory/STANDING.md'), 'utf8'),
        ).toBe('Never publish automatically');
        const db = new Database(join(target, 'pi-hermes-memory/sessions.db'), {
            readonly: true,
        });
        try {
            expect(
                db
                    .query(
                        'SELECT COUNT(*) AS n FROM memories WHERE project IS NOT NULL',
                    )
                    .get(),
            ).toEqual({ n: 0 });
            expect(
                db.query('SELECT COUNT(*) AS n FROM messages').get(),
            ).toEqual({ n: 0 });
            expect(
                db
                    .query(
                        "SELECT COUNT(*) AS n FROM memory_fts WHERE memory_fts MATCH 'deterministic'",
                    )
                    .get(),
            ).toEqual({ n: 1 });
        } finally {
            db.close();
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('export refuses to omit SQLite-only global memories and import refuses existing memories', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-setup-memory-conflict-'));
    try {
        const agent = join(root, 'agent');
        const memory = join(agent, 'pi-hermes-memory');
        mkdirSync(memory, { recursive: true });
        writeFileSync(join(memory, 'MEMORY.md'), 'Existing knowledge');
        const first = join(root, 'first.json');
        await exportGlobalMemory(agent, first);
        await expect(importGlobalMemory(agent, first)).rejects.toThrow(
            'already exists',
        );
        const db = new Database(join(memory, 'sessions.db'));
        db.exec(
            "CREATE TABLE memories(project TEXT, target TEXT, content TEXT, category TEXT); INSERT INTO memories VALUES(NULL, 'memory', 'SQLite-only knowledge', NULL)",
        );
        db.close();
        await expect(
            exportGlobalMemory(agent, join(root, 'incomplete.json')),
        ).rejects.toThrow('not covered');
        expect(existsSync(join(root, 'incomplete.json'))).toBe(false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
