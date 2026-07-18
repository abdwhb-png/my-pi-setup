/**
 * Shared fd (find) utility — reusable wrapper around the fd binary
 * for file and directory search.
 *
 * The fd binary is bundled by pi at <agentDir>/bin/fd.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

/** Lazily-computed path to the fd binary. */
let _fdPath: string | null = null;
function getFdPath(): string {
    if (_fdPath === null) {
        _fdPath = join(getAgentDir(), 'bin', 'fd');
    }
    return _fdPath;
}

export interface FdSearchOptions {
    /** Search root directory (required). */
    baseDir: string;
    /** Glob pattern to match (default: match all). */
    pattern?: string;
    /** Maximum results to return (default: 50). Sets fd --max-results. */
    maxResults?: number;
    /** File types to include — 'f' for files, 'd' for directories (default: ['f']). */
    types?: Array<'f' | 'd'>;
    /** Include hidden/dot files (default: true). Adds --hidden flag. */
    includeHidden?: boolean;
    /** Follow symlinks (default: true). Adds --follow flag. */
    followSymlinks?: boolean;
    /** AbortSignal to cancel the search early. */
    signal?: AbortSignal;
}

/**
 * Search for files or directories using fd.
 *
 * Returns absolute paths. Throws on fd process failure.
 * .git entries are always filtered from results.
 */
export async function fdSearch(options: FdSearchOptions): Promise<string[]> {
    const {
        baseDir,
        pattern,
        maxResults = 50,
        types = ['f'],
        includeHidden = true,
        followSymlinks = true,
        signal,
    } = options;

    const args: string[] = [
        '--base-directory',
        baseDir,
        '--max-results',
        String(maxResults),
    ];

    for (const t of types) {
        args.push('--type', t);
    }

    if (followSymlinks) args.push('--follow');
    if (includeHidden) args.push('--hidden');
    args.push('--no-require-git');
    args.push('--color=never');

    if (pattern) {
        args.push(pattern);
    }

    return new Promise<string[]>((resolve, reject) => {
        const child = spawn(getFdPath(), args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            signal,
        });

        if (signal?.aborted) {
            resolve([]);
            return;
        }

        let stdout = '';
        let stderr = '';

        child.stdout?.on('data', (chunk: Buffer) => {
            stdout += chunk.toString();
        });

        child.stderr?.on('data', (chunk: Buffer) => {
            stderr += chunk.toString();
        });

        child.on('error', (err: Error) => {
            reject(new Error(`Failed to run fd: ${err.message}`));
        });

        child.on('close', (code: number | null) => {
            if (signal?.aborted) {
                resolve([]);
                return;
            }
            if (code !== 0) {
                reject(
                    new Error(stderr.trim() || `fd exited with code ${code}`),
                );
                return;
            }
            const lines = stdout.trim().split('\n').filter(Boolean);
            const results: string[] = [];
            for (const line of lines) {
                const normalized = line.replace(/\/$/, '');
                if (
                    normalized === '.git' ||
                    normalized.startsWith('.git/') ||
                    normalized.includes('/.git/')
                ) {
                    continue;
                }
                results.push(join(baseDir, normalized));
            }
            resolve(results);
        });
    });
}
