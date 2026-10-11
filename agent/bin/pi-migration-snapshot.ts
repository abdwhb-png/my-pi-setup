import { createHash } from 'node:crypto';
import {
    constants,
    cpSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    readlinkSync,
    renameSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

interface Entry {
    path: string;
    backup: string;
    before: string;
    after?: string;
}
interface Journal {
    version: 1;
    status: 'prepared' | 'applied' | 'restoring' | 'rolled-back';
    entries: Entry[];
}

function present(path: string): boolean {
    try {
        lstatSync(path);
        return true;
    } catch (error) {
        if (
            error instanceof Error &&
            'code' in error &&
            error.code === 'ENOENT'
        )
            return false;
        throw error;
    }
}
function fingerprint(path: string): string {
    const hash = createHash('sha256');
    function visit(current: string, name: string): void {
        if (!present(current)) {
            hash.update(JSON.stringify([name, 'absent']));
            return;
        }
        const info = lstatSync(current);
        const kind = info.isSymbolicLink()
            ? 'link'
            : info.isDirectory()
              ? 'directory'
              : info.isFile()
                ? 'file'
                : undefined;
        if (!kind) throw new Error(`Unsupported snapshot entry: ${current}`);
        hash.update(JSON.stringify([name, kind, info.mode & 0o777]));
        if (kind === 'link') hash.update(readlinkSync(current));
        else if (kind === 'file')
            hash.update(
                createHash('sha256').update(readFileSync(current)).digest(),
            );
        else
            for (const child of readdirSync(current).sort())
                visit(join(current, child), join(name, child));
    }
    visit(path, '');
    return hash.digest('hex');
}
function contains(parent: string, child: string): boolean {
    const rel = relative(parent, child);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function copy(source: string, target: string): void {
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    cpSync(source, target, {
        recursive: true,
        dereference: false,
        verbatimSymlinks: true,
        preserveTimestamps: true,
        mode: constants.COPYFILE_FICLONE,
    });
}
function save(path: string, journal: Journal): void {
    const temp = `${path}.tmp`;
    writeFileSync(temp, JSON.stringify(journal, null, 2) + '\n', {
        mode: 0o600,
    });
    renameSync(temp, path);
}
function restore(path: string, journal: Journal): void {
    // Verify every backup before touching live paths, including absent entries.
    for (const entry of journal.entries)
        if (fingerprint(entry.backup) !== entry.before)
            throw new Error(`Migration backup changed: ${entry.backup}`);
    journal.status = 'restoring';
    save(path, journal);
    for (const entry of journal.entries) {
        rmSync(entry.path, { recursive: true, force: true });
        if (present(entry.backup)) copy(entry.backup, entry.path);
        if (fingerprint(entry.path) !== entry.before)
            throw new Error(
                `Migration restore verification failed: ${entry.path}`,
            );
    }
    journal.status = 'rolled-back';
    save(path, journal);
}

/** Call only after stopping the affected Pi processes. Sessions and unrelated paths stay outside the explicit migration set. */
export async function runMigration(options: {
    paths: readonly string[];
    snapshotDir: string;
    apply: () => Promise<void>;
    verify: () => Promise<void>;
}): Promise<string> {
    const snapshotDir = resolve(options.snapshotDir),
        paths = options.paths.map((path) => resolve(path));
    if (paths.length === 0)
        throw new Error('Migration requires explicit paths');
    for (const [index, path] of paths.entries()) {
        if (
            path === dirname(path) ||
            contains(path, snapshotDir) ||
            contains(snapshotDir, path)
        )
            throw new Error(`Unsafe migration snapshot path: ${path}`);
        if (
            paths.some(
                (other, i) =>
                    i !== index &&
                    (contains(path, other) || contains(other, path)),
            )
        )
            throw new Error(`Overlapping migration paths: ${path}`);
    }
    if (existsSync(snapshotDir))
        throw new Error('Migration snapshot directory already exists');
    mkdirSync(snapshotDir, { recursive: true, mode: 0o700 });
    const journalPath = join(snapshotDir, 'journal.json');
    const journal: Journal = { version: 1, status: 'prepared', entries: [] };
    for (const [index, path] of paths.entries()) {
        const backup = join(snapshotDir, 'before', String(index)),
            before = fingerprint(path);
        if (present(path)) copy(path, backup);
        if (fingerprint(backup) !== before || fingerprint(path) !== before)
            throw new Error(`Path changed while capturing migration: ${path}`);
        journal.entries.push({ path, backup, before });
    }
    save(journalPath, journal);
    try {
        await options.apply();
        await options.verify();
        for (const entry of journal.entries)
            entry.after = fingerprint(entry.path);
        journal.status = 'applied';
        save(journalPath, journal);
        return journalPath;
    } catch (error) {
        try {
            restore(journalPath, journal);
        } catch (recovery) {
            throw new AggregateError(
                [error, recovery],
                `Migration and restoration failed. Recovery journal: ${journalPath}`,
            );
        }
        throw error;
    }
}

/** Refuses concurrent edits. A failed restoration can be retried from its retained journal. */
export function rollbackMigration(journalPath: string): void {
    const parsed: unknown = JSON.parse(readFileSync(journalPath, 'utf8'));
    if (
        !parsed ||
        typeof parsed !== 'object' ||
        !('version' in parsed) ||
        parsed.version !== 1 ||
        !('status' in parsed) ||
        (parsed.status !== 'prepared' &&
            parsed.status !== 'applied' &&
            parsed.status !== 'restoring' &&
            parsed.status !== 'rolled-back') ||
        !('entries' in parsed) ||
        !Array.isArray(parsed.entries)
    )
        throw new Error('Invalid migration journal');
    const entries: Entry[] = parsed.entries.map((entry: unknown) => {
        if (
            !entry ||
            typeof entry !== 'object' ||
            !('path' in entry) ||
            typeof entry.path !== 'string' ||
            !('backup' in entry) ||
            typeof entry.backup !== 'string' ||
            !('before' in entry) ||
            typeof entry.before !== 'string' ||
            ('after' in entry && typeof entry.after !== 'string')
        )
            throw new Error('Invalid migration journal');
        return {
            path: entry.path,
            backup: entry.backup,
            before: entry.before,
            ...('after' in entry && typeof entry.after === 'string'
                ? { after: entry.after }
                : {}),
        };
    });
    const journal: Journal = { version: 1, status: parsed.status, entries };
    const snapshotDir = dirname(resolve(journalPath));
    if (journal.entries.length === 0)
        throw new Error('Invalid migration journal');
    for (const [index, entry] of journal.entries.entries()) {
        if (
            !entry ||
            typeof entry.path !== 'string' ||
            !isAbsolute(entry.path) ||
            resolve(entry.path) !== entry.path ||
            entry.path === dirname(entry.path) ||
            contains(entry.path, snapshotDir) ||
            contains(snapshotDir, entry.path) ||
            entry.backup !== join(snapshotDir, 'before', String(index)) ||
            typeof entry.before !== 'string' ||
            !/^[a-f0-9]{64}$/.test(entry.before) ||
            (journal.status === 'applied' &&
                (typeof entry.after !== 'string' ||
                    !/^[a-f0-9]{64}$/.test(entry.after)))
        )
            throw new Error('Invalid migration journal');
    }
    if (
        journal.entries.some((entry, index) =>
            journal.entries.some(
                (other, i) =>
                    i !== index &&
                    (contains(entry.path, other.path) ||
                        contains(other.path, entry.path)),
            ),
        )
    )
        throw new Error('Invalid migration journal');
    if (journal.status === 'rolled-back') return;
    if (journal.status === 'applied')
        for (const entry of journal.entries)
            if (fingerprint(entry.path) !== entry.after)
                throw new Error(`Path changed after migration: ${entry.path}`);
    restore(journalPath, journal);
}
