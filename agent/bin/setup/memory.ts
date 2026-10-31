import { Database } from 'bun:sqlite';
import {
    existsSync,
    readFileSync,
    writeFileSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    renameSync,
    readdirSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { digest, json, object } from './files.ts';

type Target = 'memory' | 'user' | 'failure';
interface MemoryRow {
    project: string | null;
    target: Target;
    content: string;
    category: string | null;
}
interface HermesDatabase {
    getDb(): { prepare(sql: string): { all(): MemoryRow[] } };
    close(): void;
}
interface HermesStores {
    DatabaseManager: new (directory: string) => HermesDatabase;
    ENTRY_DELIMITER: string;
    reconcileMarkdownMemoryScope(
        db: HermesDatabase,
        entries: string[],
        target: Target,
        project: null,
    ): { degraded?: boolean };
    reconcileMarkdownFailureScopes(
        db: HermesDatabase,
        entries: string[],
    ): { degraded?: boolean };
}
const FILES = {
    memory: 'MEMORY.md',
    user: 'USER.md',
    failure: 'failures.md',
} as const;
const SUPPORTED_HERMES = '0.9.10';

async function hermes(): Promise<HermesStores> {
    const root = resolve(
        import.meta.dir,
        '../../npm/node_modules/pi-hermes-memory',
    );
    if (json(join(root, 'package.json')).version !== SUPPORTED_HERMES)
        throw new Error(
            'Memory transport requires the qualified Hermes version 0.9.10',
        );
    const [db, memories, constants] = await Promise.all([
        import(join(root, 'src/store/db.ts')),
        import(join(root, 'src/store/sqlite-memory-store.ts')),
        import(join(root, 'src/constants.ts')),
    ]);
    // Version-bound adapter: reuse Hermes parsing, scope ownership and index construction.
    return {
        DatabaseManager: db.DatabaseManager,
        ENTRY_DELIMITER: constants.ENTRY_DELIMITER,
        reconcileMarkdownMemoryScope: memories.reconcileMarkdownMemoryScope,
        reconcileMarkdownFailureScopes: memories.reconcileMarkdownFailureScopes,
    };
}
function memoryDirectory(agentDir: string): string {
    const path = join(agentDir, 'hermes-memory-config.json');
    const configured = existsSync(path) ? json(path).memoryDir : undefined;
    const defaultDirectory = join(agentDir, 'pi-hermes-memory');
    const legacyDirectory = join(agentDir, 'memory');
    if (configured === undefined) {
        if (!existsSync(defaultDirectory) && existsSync(legacyDirectory))
            throw new Error(
                'Legacy Hermes memory requires migration by Hermes before transfer',
            );
        return defaultDirectory;
    }
    if (typeof configured !== 'string' || !configured.trim())
        throw new Error('Invalid configured memory directory');
    const normalized = configured.startsWith('~/')
        ? resolve(homedir(), configured.slice(2))
        : resolve(agentDir, configured);
    if (normalized === resolve(legacyDirectory)) {
        if (!existsSync(defaultDirectory) && existsSync(legacyDirectory))
            throw new Error(
                'Legacy Hermes memory requires migration by Hermes before transfer',
            );
        return defaultDirectory;
    }
    return normalized;
}
export async function exportGlobalMemory(
    agentDir: string,
    output: string,
): Promise<void> {
    const api = await hermes();
    const source = memoryDirectory(agentDir);
    const temporary = mkdtempSync(join(tmpdir(), 'pi-memory-export-'));
    const db = new api.DatabaseManager(temporary);
    const files: Record<string, string> = {};
    const originals: Record<string, string> = {};
    try {
        for (const [target, filename] of Object.entries(FILES) as [
            Target,
            string,
        ][]) {
            const path = join(source, filename);
            const raw = existsSync(path) ? readFileSync(path, 'utf8') : '';
            originals[filename] = raw;
            let entries = raw
                .split(api.ENTRY_DELIMITER)
                .map((entry) => entry.trim())
                .filter(Boolean);
            if (target === 'failure')
                entries = entries.filter((entry) => {
                    const result = api.reconcileMarkdownFailureScopes(db, [
                        entry,
                    ]);
                    if (result.degraded)
                        throw new Error('Hermes index reconstruction failed');
                    return (
                        db
                            .getDb()
                            .prepare(
                                "SELECT project FROM memories WHERE target = 'failure' AND project IS NULL",
                            )
                            .all().length > 0
                    );
                });
            files[filename] =
                target === 'failure' ? entries.join(api.ENTRY_DELIMITER) : raw;
            const result =
                target === 'failure'
                    ? api.reconcileMarkdownFailureScopes(db, entries)
                    : api.reconcileMarkdownMemoryScope(
                          db,
                          entries,
                          target,
                          null,
                      );
            if (result.degraded)
                throw new Error('Hermes index reconstruction failed');
        }
        originals['STANDING.md'] = existsSync(join(source, 'STANDING.md'))
            ? readFileSync(join(source, 'STANDING.md'), 'utf8')
            : '';
        files['STANDING.md'] = originals['STANDING.md']!;
        const rows = db
            .getDb()
            .prepare(
                'SELECT project, target, content, category FROM memories WHERE project IS NULL',
            )
            .all();
        const identity = (row: MemoryRow) =>
            JSON.stringify([row.target, row.category, row.content]);
        const covered = new Set(rows.map(identity));
        const sourceDatabase = join(source, 'sessions.db');
        if (existsSync(sourceDatabase)) {
            const sourceDb = new Database(sourceDatabase, { readonly: true });
            try {
                const databaseRows = sourceDb
                    .query<MemoryRow, []>(
                        'SELECT project, target, content, category FROM memories WHERE project IS NULL',
                    )
                    .all();
                if (databaseRows.some((row) => !covered.has(identity(row))))
                    throw new Error(
                        'Global SQLite memories are not covered by the canonical Markdown files; export refused to prevent data loss',
                    );
            } finally {
                sourceDb.close();
            }
        }
        for (const [filename, before] of Object.entries(originals)) {
            const path = join(source, filename);
            const after = existsSync(path) ? readFileSync(path, 'utf8') : '';
            if (after !== before)
                throw new Error(
                    'Memory changed during export; stop Pi and retry',
                );
        }
        writeFileSync(
            output,
            JSON.stringify(
                {
                    schemaVersion: 1,
                    hermesVersion: SUPPORTED_HERMES,
                    files,
                    sha256: digest(JSON.stringify(files)),
                },
                null,
                2,
            ) + '\n',
            { flag: 'wx', mode: 0o600 },
        );
    } finally {
        db.close();
        rmSync(temporary, { recursive: true, force: true });
    }
}
export async function importGlobalMemory(
    agentDir: string,
    input: string,
): Promise<void> {
    const api = await hermes();
    const archive = json(input);
    if (
        archive.schemaVersion !== 1 ||
        archive.hermesVersion !== SUPPORTED_HERMES
    )
        throw new Error('Unsupported memory archive');
    const files = object(archive.files);
    if (
        Object.keys(files).toSorted().join(',') !==
            ['MEMORY.md', 'USER.md', 'failures.md', 'STANDING.md']
                .toSorted()
                .join(',') ||
        !Object.values(files).every((value) => typeof value === 'string') ||
        archive.sha256 !== digest(JSON.stringify(files))
    )
        throw new Error('Invalid memory archive or checksum');
    const target = memoryDirectory(agentDir);
    if (existsSync(target) && readdirSync(target).length > 0) {
        const marker = join(target, '.pi-setup-memory.json');
        if (
            existsSync(marker) &&
            json(marker).sha256 === archive.sha256 &&
            Object.entries(files).every(
                ([name, text]) =>
                    existsSync(join(target, name)) &&
                    readFileSync(join(target, name), 'utf8') === text,
            )
        )
            return;
        throw new Error(
            'Global memory already exists; refusing to overwrite it',
        );
    }
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const temporary = mkdtempSync(join(dirname(target), '.pi-memory-import-'));
    const db = new api.DatabaseManager(temporary);
    try {
        for (const [memoryTarget, filename] of Object.entries(FILES) as [
            Target,
            string,
        ][]) {
            const text = files[filename] as string;
            writeFileSync(join(temporary, filename), text, { mode: 0o600 });
            const entries = text
                .split(api.ENTRY_DELIMITER)
                .map((entry) => entry.trim())
                .filter(Boolean);
            const result =
                memoryTarget === 'failure'
                    ? api.reconcileMarkdownFailureScopes(db, entries)
                    : api.reconcileMarkdownMemoryScope(
                          db,
                          entries,
                          memoryTarget,
                          null,
                      );
            if (result.degraded)
                throw new Error('Hermes index reconstruction failed');
        }
        if (
            db
                .getDb()
                .prepare(
                    'SELECT project FROM memories WHERE project IS NOT NULL',
                )
                .all().length
        )
            throw new Error('Archive contains project memory');
        writeFileSync(
            join(temporary, 'STANDING.md'),
            files['STANDING.md'] as string,
            { mode: 0o600 },
        );
        writeFileSync(
            join(temporary, '.pi-setup-memory.json'),
            JSON.stringify({ sha256: archive.sha256 }),
            { mode: 0o600 },
        );
        db.close();
        if (existsSync(target)) {
            if (readdirSync(target).length)
                throw new Error('Memory destination changed during import');
            rmSync(target, { recursive: true });
        }
        renameSync(temporary, target);
    } finally {
        db.close();
        rmSync(temporary, { recursive: true, force: true });
    }
}
