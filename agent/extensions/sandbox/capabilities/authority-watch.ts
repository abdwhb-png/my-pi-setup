import { watch, type FSWatcher } from "node:fs";
import { dirname, resolve } from "node:path";

export interface AuthoritySnapshot {
    key: string;
    grants: string[];
}

export interface CreateAuthorityWatchOptions {
    paths: string[];
    read: () => Promise<AuthoritySnapshot>;
    compare?: (previous: AuthoritySnapshot, next: AuthoritySnapshot) => boolean;
    onRevoked: (reason: Error | undefined) => Promise<void>;
    hasActiveProcesses: () => boolean;
    onError?: (error: Error) => void;
}

type WatchHandle = {
    check: () => Promise<void>;
    close: () => void;
};

const REFRESH_MS = 1_000;
const DEBOUNCE_MS = 50;

function normalizeSnapshot(snapshot: AuthoritySnapshot): AuthoritySnapshot {
    return {
        key: snapshot.key,
        grants: [...new Set(snapshot.grants)],
    };
}

function defaultCompare(
    previous: AuthoritySnapshot,
    next: AuthoritySnapshot,
): boolean {
    if (previous.key !== next.key) return false;
    const nextTokens = new Set(next.grants);
    return previous.grants.every((token) => nextTokens.has(token));
}

function asError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}

export function createAuthorityWatch(
    options: CreateAuthorityWatchOptions,
): WatchHandle {
    const compare = options.compare ?? defaultCompare;
    const watched = new Map<string, FSWatcher>();
    let snapshot: AuthoritySnapshot | undefined;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let checkChain = Promise.resolve();
    let interval: ReturnType<typeof setInterval> | undefined;
    let closed = false;

    function queueCheck(): Promise<void> {
        if (closed) return Promise.resolve();

        const next = checkChain.then(() => runCheck());
        checkChain = next.catch(() => undefined);
        return next;
    }

    function scheduleCheck(): void {
        if (closed) return;
        if (debounce !== undefined) clearTimeout(debounce);
        debounce = setTimeout(() => {
            debounce = undefined;
            void queueCheck().catch((error: unknown) => {
                options.onError?.(asError(error));
            });
        }, DEBOUNCE_MS);
    }

    function watchTarget(target: string): void {
        let current = resolve(target);
        while (true) {
            if (watched.has(current)) return;
            try {
                const watcher = watch(current, () => {
                    scheduleCheck();
                });
                watcher.unref();
                watcher.on("error", (error) => {
                    watched.delete(current);
                    watcher.close();
                    options.onError?.(error);
                    scheduleCheck();
                });
                watched.set(current, watcher);
                return;
            } catch (_error) {
                const parent = dirname(current);
                if (parent === current) return;
                current = parent;
            }
        }
    }

    function startWatchers(): void {
        for (const path of options.paths) {
            watchTarget(path);
            watchTarget(dirname(path));
        }
    }

    function withRevocationReason(
        reason: Error | undefined,
    ): Error | undefined {
        if (reason) return reason;
        if (!options.hasActiveProcesses()) return undefined;
        return new Error(
            "Authority was revoked while active processes are running",
        );
    }

    async function triggerRevocation(reason: Error | undefined): Promise<void> {
        await options.onRevoked(withRevocationReason(reason));
    }

    async function runCheck(): Promise<void> {
        if (closed) return;

        let next: AuthoritySnapshot;
        try {
            next = normalizeSnapshot(await options.read());
        } catch (error) {
            await triggerRevocation(asError(error));
            return;
        }

        if (snapshot === undefined) {
            snapshot = next;
            return;
        }

        const acceptable = compare(snapshot, next);
        if (acceptable) {
            snapshot = next;
            return;
        }

        await triggerRevocation(undefined);
        // Commit the narrowed authority only after every affected runtime has stopped.
        snapshot = next;
    }

    function close(): void {
        closed = true;
        if (interval !== undefined) {
            clearInterval(interval);
            interval = undefined;
        }
        if (debounce !== undefined) {
            clearTimeout(debounce);
            debounce = undefined;
        }
        for (const watcher of watched.values()) {
            watcher.close();
        }
        watched.clear();
    }

    async function check(): Promise<void> {
        return queueCheck();
    }

    startWatchers();
    interval = setInterval(() => {
        if (!options.hasActiveProcesses()) return;
        void queueCheck().catch((error: unknown) => {
            options.onError?.(asError(error));
        });
    }, REFRESH_MS);
    interval.unref?.();
    void queueCheck().catch((error: unknown) => {
        options.onError?.(asError(error));
    });

    return { check, close };
}
