import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { toPortableHomePath } from '../../extensions/_shared/home-path.ts';
import { normalizeAiProvidersConfig } from '../../extensions/ai-providers/schema.ts';
import { PORTABLE_PROFILE_FILES } from './distribution.ts';
import { child, json, object } from './files.ts';

export type ProfileDefaults = Record<string, Record<string, unknown>>;
type ProfilePreference = { location: string[] } & (
    | { value: unknown; removed?: never; object?: never }
    | { removed: true; valueType: string; object?: never }
    | { object: true; removed?: never; value?: never }
);
export type ProfilePreferences = Record<string, ProfilePreference[]>;

export function readProfilePreferences(
    value: unknown,
    defaults: ProfileDefaults,
): ProfilePreferences {
    return Object.fromEntries(
        Object.entries(object(value)).map(([path, entries]) => {
            if (!Object.hasOwn(defaults, path) || !Array.isArray(entries))
                throw new Error(`Invalid profile preferences: ${path}`);
            const locations = new Set<string>();
            const parsed: ProfilePreference[] = [];
            for (const entry of entries) {
                if (
                    !record(entry) ||
                    !Array.isArray(entry.location) ||
                    entry.location.length === 0 ||
                    !entry.location.every(
                        (key: unknown) => typeof key === 'string',
                    )
                )
                    throw new Error(`Invalid profile preference: ${path}`);
                const key = JSON.stringify(entry.location);
                if (locations.has(key))
                    throw new Error(`Duplicate profile preference: ${path}`);
                locations.add(key);
                if (entry.object === true) {
                    if (
                        Object.hasOwn(entry, 'value') ||
                        Object.hasOwn(entry, 'removed')
                    )
                        throw new Error(
                            `Invalid profile object preference: ${path}`,
                        );
                    parsed.push({ location: entry.location, object: true });
                } else if (entry.removed === true) {
                    if (
                        typeof entry.valueType !== 'string' ||
                        ![
                            'null',
                            'array',
                            'object',
                            'string',
                            'number',
                            'boolean',
                        ].includes(entry.valueType) ||
                        Object.hasOwn(entry, 'object') ||
                        Object.hasOwn(entry, 'value')
                    )
                        throw new Error(`Invalid profile deletion: ${path}`);
                    parsed.push({
                        location: entry.location,
                        removed: true,
                        valueType: entry.valueType,
                    });
                } else {
                    if (
                        Object.hasOwn(entry, 'removed') ||
                        Object.hasOwn(entry, 'object') ||
                        !Object.hasOwn(entry, 'value')
                    )
                        throw new Error(`Invalid profile preference: ${path}`);
                    parsed.push({
                        location: entry.location,
                        value: entry.value,
                    });
                }
            }
            return [path, parsed];
        }),
    );
}
const absent = Symbol('absent');
const protectedSettings = new Set([
    'packages',
    'extensions',
    'skills',
    'prompts',
    'themes',
    'npmCommand',
]);
function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function valueAt(value: Record<string, unknown>, key: string): unknown {
    return Object.hasOwn(value, key) ? value[key] : absent;
}
function kind(value: unknown): string {
    return value === absent
        ? 'absent'
        : value === null
          ? 'null'
          : Array.isArray(value)
            ? 'array'
            : typeof value;
}
function conflict(path: string, location: string[]): never {
    const pointer = location
        .map((key) => key.replaceAll('~', '~0').replaceAll('/', '~1'))
        .join('/');
    throw new Error(
        `Incompatible local preference: ${path}#/${pointer}. Reconcile this property before retrying; no local value was overwritten.`,
    );
}

/** Paths use the final installation root, including when preparing a sibling candidate. */
export function materializeProfile(
    value: unknown,
    root: string,
    runtimeVersion?: string,
): Record<string, unknown> {
    function relocate(item: unknown): unknown {
        if (
            typeof item === 'string' &&
            (item === '~/.pi' || item.startsWith('~/.pi/'))
        )
            return toPortableHomePath(root + item.slice(5));
        if (Array.isArray(item)) return item.map(relocate);
        if (record(item))
            return Object.fromEntries(
                Object.entries(item).map(([key, entry]) => [
                    key,
                    relocate(entry),
                ]),
            );
        return item;
    }
    const prepared = object(relocate(value));
    if (runtimeVersion) prepared.lastChangelogVersion = runtimeVersion;
    return prepared;
}

export function bundledProfileDefaults(
    bundle: string,
    root: string,
    files: Record<string, string>,
): ProfileDefaults {
    const runtime = json(join(bundle, 'pi/release-manifest.json'));
    const core = Array.isArray(runtime.packages)
        ? runtime.packages.find(
              (pkg: unknown) =>
                  record(pkg) && pkg.name === '@earendil-works/pi-coding-agent',
          )
        : undefined;
    const version =
        record(core) && typeof core.version === 'string'
            ? core.version
            : undefined;
    return Object.fromEntries(
        [...PORTABLE_PROFILE_FILES.keys()]
            .filter((path) => Object.hasOwn(files, `setup/${path}`))
            .map((path) => {
                const source = child(join(bundle, 'setup'), path);
                if (!lstatSync(source).isFile())
                    throw new Error(`Profile must be a regular file: ${path}`);
                return [
                    path,
                    materializeProfile(
                        json(source),
                        root,
                        path === 'agent/settings.json' ? version : undefined,
                    ),
                ];
            }),
    );
}

export function readProfile(
    root: string,
    path: string,
): Record<string, unknown> {
    const file = child(root, path);
    if (!existsSync(file) || !lstatSync(file).isFile())
        throw new Error(
            `Local preference must be a regular JSON object: ${path}`,
        );
    try {
        return object(JSON.parse(readFileSync(file, 'utf8')));
    } catch {
        throw new Error(`Invalid local preference JSON: ${path}`);
    }
}

/** Keep only the machine's differences from the previous delivered profile. */
export function reconcileProfiles(
    root: string,
    base: ProfileDefaults,
    incoming: ProfileDefaults,
    restoredMachinePreferences: ProfileDefaults = {},
    previousPreferences: ProfilePreferences = {},
): {
    profiles: ProfileDefaults;
    preferences: ProfilePreferences;
    preserved: string[];
} {
    const preserved: string[] = [];
    const preferences: ProfilePreferences = {};
    function merge(
        path: string,
        before: unknown,
        current: unknown,
        next: unknown,
        location: string[],
        priorValue: unknown,
    ): unknown {
        if (
            path === 'agent/settings.json' &&
            location.length === 1 &&
            location[0] === 'lastChangelogVersion'
        )
            return next;
        const knownPreferences = previousPreferences[path] ?? [];
        const matchesLocation = (entry: ProfilePreference) =>
            entry.location.length === location.length &&
            entry.location.every((key, i) => key === location[i]);
        const preference = knownPreferences.find(matchesLocation);
        const retained =
            preference !== undefined &&
            (preference.object
                ? record(current)
                : isDeepStrictEqual(
                      current,
                      preference.removed ? absent : preference.value,
                  ));
        const createdObject =
            record(current) &&
            (before === absent || (retained && preference?.object === true));
        const children = knownPreferences.filter(
            (entry) =>
                entry.location.length > location.length &&
                location.every((key, i) => key === entry.location[i]),
        );
        if (
            isDeepStrictEqual(before, current) &&
            !retained &&
            children.length === 0
        )
            return next;
        const preserve = () => {
            preserved.push(`${path}#/${location.join('/')}`);
            (preferences[path] ??= []).push(
                current === absent
                    ? {
                          location,
                          removed: true,
                          valueType: preference?.removed
                              ? preference.valueType
                              : kind(before),
                      }
                    : createdObject
                      ? { location, object: true }
                      : { location, value: current },
            );
        };
        if (
            path === 'agent/settings.json' &&
            location.length === 1 &&
            protectedSettings.has(location[0]!) &&
            !isDeepStrictEqual(current, next)
        )
            conflict(path, location);
        if (current === absent) {
            if (
                next !== absent &&
                (retained && preference?.removed
                    ? preference.valueType
                    : kind(before)) !== kind(next)
            )
                conflict(path, location);
            preserve();
            return absent;
        }
        // Rollback may restore a version predating a delivered default for an existing machine preference.
        if (
            before !== absent &&
            next === absent &&
            !retained &&
            (priorValue === absent || kind(priorValue) !== kind(current))
        )
            conflict(path, location);
        if (next !== absent && kind(current) !== kind(next))
            conflict(path, location);
        if (
            record(current) &&
            (record(next) || (createdObject && next === absent)) &&
            !(
                retained &&
                preference &&
                !preference.removed &&
                record(preference.value)
            ) &&
            (record(before) || before === absent)
        ) {
            if (createdObject) preserve();
            const previous = record(before) ? before : {};
            const nextObject = record(next) ? next : {};
            return Object.fromEntries(
                [
                    ...new Set([
                        ...Object.keys(previous),
                        ...Object.keys(current),
                        ...Object.keys(nextObject),
                        ...children.map(
                            (entry) => entry.location[location.length]!,
                        ),
                    ]),
                ].flatMap((key) => {
                    const value = merge(
                        path,
                        valueAt(previous, key),
                        valueAt(current, key),
                        valueAt(nextObject, key),
                        [...location, key],
                        record(priorValue) ? valueAt(priorValue, key) : absent,
                    );
                    return value === absent ? [] : [[key, value]];
                }),
            );
        }
        preserve();
        return current;
    }
    const profiles: ProfileDefaults = {};
    for (const [path, before] of Object.entries(base)) {
        const current = readProfile(root, path);
        const next = Object.hasOwn(incoming, path) ? incoming[path]! : absent;
        const priorValue = Object.hasOwn(restoredMachinePreferences, path)
            ? restoredMachinePreferences[path]
            : absent;
        const result = merge(path, before, current, next, [], priorValue);
        if (result !== absent) profiles[path] = object(result);
    }
    for (const [path, value] of Object.entries(incoming))
        if (!Object.hasOwn(profiles, path)) profiles[path] = value;
    for (const [path, value] of Object.entries(profiles)) {
        if (path === 'agent/config/ai-providers.json')
            normalizeAiProvidersConfig(value);
    }
    return { profiles, preferences, preserved };
}
