import { createHash, randomUUID } from 'node:crypto';
import {
    accessSync,
    chmodSync,
    constants,
    lstatSync,
    readFileSync,
    realpathSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import lockfile from 'proper-lockfile';

export interface MigrationTarget {
    path: string;
    /** Explicit former addon mappings, now manual native overrides. */
    manualTools?: Record<string, string[]>;
    /** Only set on the global settings target. */
    resolver?: string;
}
interface FieldValue {
    present: boolean;
    value?: unknown;
}
interface FieldChange {
    keys: string[];
    before: FieldValue;
    after: FieldValue;
}

function object(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error(`Invalid ${label}: expected object`);
    return value as Record<string, unknown>;
}

function fingerprint(tools: unknown): string {
    return createHash('sha256')
        .update(JSON.stringify(tools) ?? 'missing')
        .digest('hex');
}

interface Ownership {
    sources: string[];
    fingerprint: string;
    objectCreated: boolean;
}

function readOwnership(value: unknown): Record<string, Ownership> {
    if (value === undefined) return {};
    const ledger = object(value, 'generatedToolOverrides');
    if (ledger.version !== 1)
        throw new Error('Unsupported generatedToolOverrides version');
    return Object.fromEntries(
        Object.entries(
            object(ledger.agents, 'generatedToolOverrides.agents'),
        ).map(([name, raw]) => {
            const entry = object(raw, `ownership for ${name}`);
            if (
                !Array.isArray(entry.sources) ||
                !entry.sources.every(
                    (source): source is string => typeof source === 'string',
                ) ||
                typeof entry.fingerprint !== 'string' ||
                !/^[a-f0-9]{64}$/.test(entry.fingerprint) ||
                typeof entry.objectCreated !== 'boolean'
            )
                throw new Error(`Invalid ownership for ${name}`);
            return [
                name,
                {
                    sources: entry.sources,
                    fingerprint: entry.fingerprint,
                    objectCreated: entry.objectCreated,
                },
            ];
        }),
    );
}

function readSettings(path: string): {
    bytes: string | undefined;
    mode: number;
} {
    try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink())
            throw new Error(
                `Settings must be a regular file, not a symlink: ${path}`,
            );
        accessSync(path, constants.R_OK | constants.W_OK);
        return { bytes: readFileSync(path, 'utf8'), mode: stat.mode & 0o777 };
    } catch (error) {
        if (
            error instanceof Error &&
            'code' in error &&
            error.code === 'ENOENT'
        )
            return { bytes: undefined, mode: 0o600 };
        throw error;
    }
}

function field(settings: Record<string, unknown>, keys: string[]): FieldValue {
    let current: unknown = settings;
    for (const key of keys) {
        if (
            !current ||
            typeof current !== 'object' ||
            !Object.hasOwn(current, key)
        )
            return { present: false };
        current = (current as Record<string, unknown>)[key];
    }
    return { present: true, value: current };
}
function assign(
    settings: Record<string, unknown>,
    keys: string[],
    value: FieldValue,
): void {
    let current = settings;
    for (const key of keys.slice(0, -1)) {
        if (!Object.hasOwn(current, key))
            Object.defineProperty(current, key, {
                value: {},
                enumerable: true,
                configurable: true,
                writable: true,
            });
        current = object(current[key], `settings field ${key}`);
    }
    const key = keys.at(-1)!;
    if (value.present)
        Object.defineProperty(current, key, {
            value: value.value,
            enumerable: true,
            configurable: true,
            writable: true,
        });
    else delete current[key];
}
function parseSettings(
    bytes: string | undefined,
    path: string,
): Record<string, unknown> {
    try {
        return object(JSON.parse(bytes ?? '{}'), 'settings');
    } catch {
        throw new Error(`Invalid settings JSON: ${path}`);
    }
}
function prepare(
    target: MigrationTarget,
    bytes: string | undefined,
): { next?: string; changes: FieldChange[] } {
    const settings = parseSettings(bytes, target.path);
    const changes: FieldChange[] = [];
    function change(keys: string[], after: FieldValue) {
        const before = field(settings, keys);
        if (JSON.stringify(before) === JSON.stringify(after)) return;
        changes.push({ keys, before, after });
        assign(settings, keys, after);
    }
    const ownershipKeys = ['piSubagentsAddons', 'generatedToolOverrides'];
    const owned = readOwnership(field(settings, ownershipKeys).value);
    for (const [name, ownership] of Object.entries(owned)) {
        const tools = field(settings, [
            'subagents',
            'agentOverrides',
            name,
            'tools',
        ]);
        if (
            !tools.present ||
            fingerprint(tools.value) !== ownership.fingerprint
        )
            throw new Error(
                `Manual edit conflicts with generated tools: ${name}`,
            );
    }
    for (const [name, tools] of Object.entries(target.manualTools ?? {})) {
        if (
            !Array.isArray(tools) ||
            !tools.every(
                (tool) => typeof tool === 'string' && tool.trim().length > 0,
            )
        )
            throw new Error(`Invalid manual tool selection: ${name}`);
        const existing = field(settings, [
            'subagents',
            'agentOverrides',
            name,
            'tools',
        ]);
        if (
            !Object.hasOwn(owned, name) &&
            existing.present &&
            fingerprint(existing.value) !== fingerprint(tools)
        )
            throw new Error(
                `Unowned tools conflict with manual alias selection: ${name}`,
            );
    }
    for (const name of new Set([
        ...Object.keys(owned),
        ...Object.keys(target.manualTools ?? {}),
    ])) {
        const tools = target.manualTools?.[name];
        change(
            ['subagents', 'agentOverrides', name, 'tools'],
            tools === undefined
                ? { present: false }
                : { present: true, value: tools },
        );
    }
    if (field(settings, ownershipKeys).present)
        change(ownershipKeys, { present: false });
    const overrides = field(settings, ['subagents', 'agentOverrides']).value;
    if (overrides && typeof overrides === 'object') {
        for (const [name, ownership] of Object.entries(owned)) {
            const remaining = (overrides as Record<string, unknown>)[name];
            if (
                ownership.objectCreated &&
                remaining &&
                typeof remaining === 'object' &&
                Object.keys(remaining).length === 0
            )
                delete (overrides as Record<string, unknown>)[name];
        }
    }
    const metadata = settings.piSubagentsAddons;
    if (
        metadata &&
        typeof metadata === 'object' &&
        Object.keys(metadata).length === 0
    )
        delete settings.piSubagentsAddons;
    if (target.resolver !== undefined) {
        if (!target.resolver.trim())
            throw new Error('Resolver path must be nonempty');
        const current = field(settings, ['subagents', 'toolSelectionResolver']);
        if (current.present && current.value !== target.resolver)
            throw new Error(
                'Existing tool-selection resolver conflicts with migration',
            );
        change(['subagents', 'toolSelectionResolver'], {
            present: true,
            value: target.resolver,
        });
    }
    return {
        changes,
        ...(changes.length
            ? { next: JSON.stringify(settings, null, 2) + '\n' }
            : {}),
    };
}

/** One-shot operator tool. Preview never writes. All targets are validated before atomic per-file publication. */
async function publishMigration(
    inputTargets: MigrationTarget[],
    { apply = false, journalPath }: { apply?: boolean; journalPath?: string },
    prepareChanges: typeof prepare,
): Promise<{
    changed: string[];
    preview: Array<{ path: string; fields: string[] }>;
}> {
    const targets = inputTargets.toSorted((a, b) =>
        a.path.localeCompare(b.path),
    );
    if (new Set(targets.map((target) => target.path)).size !== targets.length)
        throw new Error('Global and project settings must be distinct');
    const releases: Array<() => Promise<void>> = [];
    const changed: string[] = [];
    const failures: unknown[] = [];
    let compromised: Error | undefined;
    try {
        for (const { path } of targets) {
            if (realpathSync(dirname(path)) !== dirname(path))
                throw new Error(
                    `Settings parent must not be redirected by a symlink: ${path}`,
                );
            releases.push(
                await lockfile.lock(path, {
                    realpath: false,
                    retries: {
                        retries: 10,
                        factor: 1,
                        minTimeout: 25,
                        maxTimeout: 25,
                        randomize: false,
                    },
                    onCompromised: (error) => {
                        compromised = error;
                    },
                }),
            );
        }
        const prepared = targets.map((target) => {
            const original = readSettings(target.path);
            return {
                path: target.path,
                original,
                ...prepareChanges(target, original.bytes),
            };
        });
        const journal = prepared
            .filter((item) => item.next !== undefined)
            .map(({ path, original, changes }) => ({
                path,
                mode: original.mode,
                changes,
            }));
        if (!apply)
            return {
                changed: [],
                preview: journal.map(({ path, changes }) => ({
                    path,
                    fields: changes.map((change) => change.keys.join('.')),
                })),
            };
        if (!journal.length) return { changed: [], preview: [] };
        if (!journalPath)
            throw new Error(
                'Applying migration requires a private journalPath',
            );
        writeFileSync(
            journalPath,
            JSON.stringify({ version: 1, entries: journal }, null, 2) + '\n',
            { mode: 0o600, flag: 'wx' },
        );
        for (const { path, original, next } of prepared) {
            if (compromised) throw compromised;
            if (next === undefined) continue;
            const temporary = join(
                dirname(path),
                `.tool-selection-${randomUUID()}.tmp`,
            );
            try {
                writeFileSync(temporary, next, { mode: 0o600, flag: 'wx' });
                chmodSync(temporary, original.mode);
                if (realpathSync(dirname(path)) !== dirname(path))
                    throw new Error(`Settings parent changed: ${path}`);
                if (readSettings(path).bytes !== original.bytes)
                    throw new Error(`Concurrent settings edit: ${path}`);
                renameSync(temporary, path);
                changed.push(path);
            } finally {
                try {
                    unlinkSync(temporary);
                } catch (error) {
                    if (
                        !(
                            error instanceof Error &&
                            'code' in error &&
                            error.code === 'ENOENT'
                        )
                    )
                        failures.push(error);
                }
            }
            if (failures.length) break;
        }
    } catch (error) {
        failures.push(error);
    } finally {
        for (const release of releases.toReversed()) {
            try {
                await release();
            } catch (error) {
                failures.push(error);
            }
        }
    }
    if (failures.length)
        throw new AggregateError(
            failures,
            `Tool-selection migration failed; published files: ${changed.join(', ') || 'none'}. ${failures.map(String).join('; ')}`,
        );
    return { changed, preview: [] };
}

export async function migrateToolSelection(
    targets: MigrationTarget[],
    options: { apply?: boolean; journalPath?: string } = {},
) {
    return publishMigration(targets, options, prepare);
}

/** Restore only journaled fields that still match the migration. Preserve later model and unrelated edits. */
export async function rollbackToolSelection(
    journalPath: string,
    options: { apply?: boolean; rollbackJournalPath?: string } = {},
) {
    const raw = object(
        JSON.parse(readSettings(journalPath).bytes ?? '{}'),
        'migration journal',
    );
    if (raw.version !== 1 || !Array.isArray(raw.entries))
        throw new Error('Invalid migration journal');
    const entries = new Map<string, FieldChange[]>();
    for (const rawEntry of raw.entries) {
        const entry = object(rawEntry, 'journal entry');
        if (typeof entry.path !== 'string' || !Array.isArray(entry.changes))
            throw new Error('Invalid migration journal entry');
        const changes: FieldChange[] = entry.changes.map((value) => {
            const change = object(value, 'journal field');
            const before = object(change.before, 'journal before');
            const after = object(change.after, 'journal after');
            if (
                !Array.isArray(change.keys) ||
                !change.keys.length ||
                !change.keys.every(
                    (key): key is string => typeof key === 'string',
                ) ||
                typeof before.present !== 'boolean' ||
                typeof after.present !== 'boolean'
            )
                throw new Error('Invalid migration journal field');
            return {
                keys: change.keys,
                before: { present: before.present, value: before.value },
                after: { present: after.present, value: after.value },
            };
        });
        if (entries.has(entry.path))
            throw new Error('Duplicate migration journal target');
        entries.set(entry.path, changes);
    }
    return publishMigration(
        [...entries.keys()].map((path) => ({ path })),
        {
            apply: options.apply,
            journalPath:
                options.rollbackJournalPath ?? journalPath + '.rollback',
        },
        (target, bytes) => {
            const settings = parseSettings(bytes, target.path);
            const changes: FieldChange[] = [];
            for (const recorded of entries.get(target.path)!) {
                const current = field(settings, recorded.keys);
                if (JSON.stringify(current) === JSON.stringify(recorded.before))
                    continue;
                if (JSON.stringify(current) !== JSON.stringify(recorded.after))
                    throw new Error(
                        `Concurrent edit conflicts with rollback: ${recorded.keys.join('.')}`,
                    );
                changes.push({
                    keys: recorded.keys,
                    before: current,
                    after: recorded.before,
                });
                assign(settings, recorded.keys, recorded.before);
            }
            return {
                changes,
                ...(changes.length
                    ? { next: JSON.stringify(settings, null, 2) + '\n' }
                    : {}),
            };
        },
    );
}
