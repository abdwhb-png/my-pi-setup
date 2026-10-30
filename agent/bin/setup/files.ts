import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    readFileSync,
    writeFileSync,
    mkdirSync,
    lstatSync,
    readdirSync,
    readlinkSync,
    existsSync,
    renameSync,
    chmodSync,
} from 'node:fs';
import { dirname, resolve, relative, isAbsolute, join } from 'node:path';
import { redactTextPreservingContext } from '../../extensions/_shared/secret-redaction.ts';

export function run(
    command: string,
    args: string[],
    cwd?: string,
    env = process.env,
): string {
    const result = spawnSync(command, args, {
        cwd,
        env,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
        // Redact before taking each stream's tail, so truncation cannot split a secret.
        const detail =
            [result.stdout, result.stderr, result.error?.message]
                .filter((output): output is string => Boolean(output?.trim()))
                .map((output) =>
                    redactTextPreservingContext(output.trim(), {
                        maxLength: Infinity,
                    }).slice(-2000),
                )
                .join('\n') || 'No diagnostic output';
        throw new Error(
            `Command failed: ${command} (exit ${result.status ?? 'unavailable'}). ${detail}`,
            { cause: result.error },
        );
    }
    return result.stdout.trim();
}
export function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Expected a JSON object');
    return value as Record<string, unknown>;
}
export function json(path: string): Record<string, unknown> {
    return object(JSON.parse(readFileSync(path, 'utf8')));
}
export function writeJson(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
    });
    renameSync(temporary, path);
}
export function child(root: string, path: string): string {
    if (
        !path ||
        path.includes('\0') ||
        path.includes('\\') ||
        isAbsolute(path) ||
        path.split('/').some((p) => !p || p === '.' || p === '..')
    )
        throw new Error('Unsafe relative path');
    return join(root, path);
}
export function contained(root: string, path: string): boolean {
    const rel = relative(resolve(root), resolve(path));
    return (
        rel === '' ||
        (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'))
    );
}
export function digest(bytes: Uint8Array | string): string {
    return createHash('sha256').update(bytes).digest('hex');
}
export function fingerprint(path: string): string {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return `link:${readlinkSync(path)}`;
    if (!stat.isFile()) throw new Error(`Expected a regular file: ${path}`);
    return `${stat.mode & 0o777}:${digest(readFileSync(path))}`;
}
export function inventory(root: string): Record<string, string> {
    const files: Record<string, string> = Object.create(null);
    function walk(directory: string) {
        for (const name of readdirSync(directory).toSorted()) {
            const path = join(directory, name);
            const stat = lstatSync(path);
            if (stat.isDirectory()) walk(path);
            else files[relative(root, path)] = fingerprint(path);
        }
    }
    walk(root);
    return files;
}
export function assertInventory(
    root: string,
    expected: Record<string, string>,
): void {
    for (const [path, hash] of Object.entries(expected)) {
        const file = child(root, path);
        if (
            (!existsSync(file) && !hash.startsWith('link:')) ||
            fingerprint(file) !== hash
        )
            throw new Error(`Local change or damaged file: ${path}`);
    }
}
export function archive(
    mode: 'pack' | 'extract',
    source: string,
    destination: string,
): void {
    run('python3', [
        join(import.meta.dir, 'archive.py'),
        mode,
        source,
        destination,
    ]);
}

export function writableDirectories(root: string): void {
    if (!existsSync(root) || !lstatSync(root).isDirectory()) return;
    chmodSync(root, 0o700);
    for (const entry of readdirSync(root, { withFileTypes: true }))
        if (entry.isDirectory()) writableDirectories(join(root, entry.name));
}
