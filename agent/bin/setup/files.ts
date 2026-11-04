import { spawn, spawnSync } from 'node:child_process';
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
import { StringDecoder } from 'node:string_decoder';
import { runtimeChildStdio } from '../../extensions/_shared/runtime-storage.ts';
import { redactTextPreservingContext } from '../../extensions/_shared/secret-redaction.ts';
import { readSetupProgress, type SetupProgress } from './progress.ts';
export {
    asJsonObject as object,
    readJsonObject as json,
} from '../../extensions/_shared/json-object.ts';

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
        stdio: runtimeChildStdio('pipe'),
    });
    if (result.error || result.status !== 0) {
        throw commandFailure(
            command,
            result.status,
            result.stdout,
            result.stderr,
            result.error,
        );
    }
    return result.stdout.trim();
}

function commandFailure(
    command: string,
    status: number | null,
    stdout: string | null,
    stderr: string | null,
    error?: Error,
): Error {
    // Redact before taking each stream's tail, so truncation cannot split a secret.
    const detail =
        [stdout, stderr, error?.message]
            .filter((output): output is string => Boolean(output?.trim()))
            .map((output) =>
                redactTextPreservingContext(output.trim(), {
                    maxLength: Infinity,
                }).slice(-2000),
            )
            .join('\n') || 'No diagnostic output';
    return new Error(
        `Command failed: ${command} (exit ${status ?? 'unavailable'}). ${detail}`,
        { cause: error },
    );
}

export function runAsync(
    command: string,
    args: string[],
    cwd?: string,
    env = process.env,
    progress?: SetupProgress,
): Promise<string> {
    return new Promise((resolvePromise, reject) => {
        const child = spawn(command, args, {
            cwd,
            env,
            stdio: runtimeChildStdio('pipe'),
        });
        const decoder = new StringDecoder('utf8');
        const stdout: Buffer[] = [],
            stderr: Buffer[] = [];
        let size = 0,
            pending = '',
            failure: Error | undefined;
        child.stdin?.end();
        const capture = (target: Buffer[], chunk: Buffer) => {
            size += chunk.length;
            if (size > 64 * 1024 * 1024) {
                failure ??= new Error(
                    'Command output exceeded the 64 MiB limit',
                );
                child.kill();
                return false;
            }
            target.push(chunk);
            return true;
        };
        child.stdout?.on('data', (chunk: Buffer) => {
            capture(stdout, chunk);
        });
        child.stderr?.on('data', (chunk: Buffer) => {
            if (!capture(stderr, chunk) || !progress) return;
            pending += decoder.write(chunk);
            const lines = pending.split('\n');
            pending = lines.pop() ?? '';
            if (pending.length > 1024) pending = '';
            try {
                for (const line of lines) readSetupProgress(line, progress);
            } catch (error) {
                failure =
                    error instanceof Error ? error : new Error(String(error));
                child.kill();
            }
        });
        child.on('error', (error) => {
            failure = error;
        });
        child.on('close', (status, signal) => {
            const out = Buffer.concat(stdout).toString('utf8');
            if (failure || status !== 0) {
                reject(
                    commandFailure(
                        command,
                        status,
                        out,
                        Buffer.concat(stderr).toString('utf8'),
                        failure ??
                            (signal
                                ? new Error(`Command interrupted by ${signal}`)
                                : undefined),
                    ),
                );
            } else resolvePromise(out.trim());
        });
    });
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
const ARCHIVE_SCRIPT = join(import.meta.dir, 'archive.py');

export function archive(
    mode: 'pack' | 'extract',
    source: string,
    destination: string,
): void {
    run('python3', [ARCHIVE_SCRIPT, mode, source, destination]);
}

export async function archiveAsync(
    mode: 'pack' | 'extract',
    source: string,
    destination: string,
): Promise<void> {
    await runAsync('python3', [ARCHIVE_SCRIPT, mode, source, destination]);
}

export function writableDirectories(root: string): void {
    if (!existsSync(root) || !lstatSync(root).isDirectory()) return;
    chmodSync(root, 0o700);
    for (const entry of readdirSync(root, { withFileTypes: true }))
        if (entry.isDirectory()) writableDirectories(join(root, entry.name));
}
