import { randomBytes } from "node:crypto";
import {
    chmod,
    lstat,
    mkdir,
    readFile,
    readdir,
    rename,
    rm,
    writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { SandboxExecutionError, type PrivateTempLease } from "./contracts.ts";

export const LEASE_MARKER_FILENAME = ".pi-sandbox-lease.json";
export const LEASE_MARKER_VERSION = 1;
export const MAX_LEASE_ID_BYTES = 8;
const LEASE_PREFIX = "l-";
const GC_PREFIX = ".gc-";
const MAX_CREATE_ATTEMPTS = 8;
const CLEANUP_QUIESCENCE_MS = 50;

interface LeaseMarker {
    version: 1;
    leaseId: string;
    ownerPid: number;
}

type RemoveTree = (path: string) => Promise<void>;

interface DisposalState {
    detachedRoot?: string;
}

export interface PrivateTempOptions {
    rootDir?: string;
    ownerPid?: number;
    randomId?: string;
    removeTree?: RemoveTree;
}

export interface RecoveryOptions {
    rootDir?: string;
    isPidAlive?: (pid: number) => boolean;
}

export interface RecoveryResult {
    removed: string[];
    retained: string[];
}

function defaultRootDir(): string {
    return join(homedir(), ".pi", "zbx");
}

function cleanupError(cause: unknown): SandboxExecutionError {
    return new SandboxExecutionError("cleanup-failed", { cause });
}

function validateOwnerPid(pid: number): void {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
        throw new SandboxExecutionError("invalid-policy", {
            cause: new Error("Invalid lease owner PID"),
        });
    }
}

function validateRandomId(randomId: string): void {
    if (!/^[a-f0-9]{6}$/.test(randomId)) {
        throw new SandboxExecutionError("invalid-policy", {
            cause: new Error("Invalid lease random identifier"),
        });
    }
}

function leaseId(_ownerPid: number, randomId: string): string {
    const value = `${LEASE_PREFIX}${randomId}`;
    if (Buffer.byteLength(value) > MAX_LEASE_ID_BYTES) {
        throw new SandboxExecutionError("invalid-policy", {
            cause: new Error("Lease identifier exceeds its byte budget"),
        });
    }
    return value;
}

export function worstCaseProxySocketPath(zeroboxHome: string): string {
    return join(
        zeroboxHome,
        "tmp",
        "runs",
        "p-ffffffff",
        "p-4294967295-127",
        "r-18446744073709551615.sock",
    );
}

function assertSocketBudget(zeroboxHome: string): void {
    if (Buffer.byteLength(worstCaseProxySocketPath(zeroboxHome)) >= 108) {
        throw new SandboxExecutionError("invalid-policy", {
            cause: new Error(
                "Private Zerobox root exceeds Linux AF_UNIX budget",
            ),
        });
    }
}

export async function assertPrivateRootDirectory(path: string): Promise<void> {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new SandboxExecutionError("invalid-policy", {
            cause: new Error("Private lease root is not an owned directory"),
        });
    }
    await chmod(path, 0o700);
}

function validMarker(value: unknown, expectedId: string): value is LeaseMarker {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const marker = value as Record<string, unknown>;
    return (
        marker.version === LEASE_MARKER_VERSION &&
        marker.leaseId === expectedId &&
        typeof marker.ownerPid === "number" &&
        Number.isSafeInteger(marker.ownerPid) &&
        marker.ownerPid > 0 &&
        Object.keys(marker).length === 3
    );
}

async function readValidMarker(
    markerPath: string,
    expectedId: string,
): Promise<LeaseMarker | null> {
    try {
        const value: unknown = JSON.parse(await readFile(markerPath, "utf8"));
        return validMarker(value, expectedId) ? value : null;
    } catch {
        return null;
    }
}

async function defaultRemoveTree(path: string): Promise<void> {
    await rm(path, { recursive: true, force: false });
}

async function safeDisposeRoot(
    root: string,
    markerPath: string,
    id: string,
    removeTree: RemoveTree,
    state: DisposalState,
): Promise<void> {
    if (state.detachedRoot) {
        try {
            await removeTree(state.detachedRoot);
            state.detachedRoot = undefined;
            return;
        } catch (error) {
            throw cleanupError(error);
        }
    }
    let stat;
    try {
        stat = await lstat(root);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw cleanupError(error);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw cleanupError(new Error("Lease root was replaced"));
    }
    if ((await readValidMarker(markerPath, id)) === null) {
        throw cleanupError(new Error("Lease ownership marker is invalid"));
    }
    // Zerobox's bwrap helper can finish a synthetic mount cleanup just after
    // the supervised target exits. Keep the owned path in place until that
    // bounded activity settles so it cannot resurrect an unmarked lease.
    await delay(CLEANUP_QUIESCENCE_MS);
    try {
        stat = await lstat(root);
    } catch (error) {
        throw cleanupError(error);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw cleanupError(new Error("Lease root was replaced"));
    }
    if ((await readValidMarker(markerPath, id)) === null) {
        throw cleanupError(new Error("Lease ownership marker is invalid"));
    }
    const detachedRoot = join(
        dirname(root),
        `${GC_PREFIX}${id}-${randomBytes(6).toString("hex")}`,
    );
    try {
        await rename(root, detachedRoot);
    } catch (error) {
        throw cleanupError(error);
    }
    state.detachedRoot = detachedRoot;
    let firstFailure: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            await removeTree(detachedRoot);
            state.detachedRoot = undefined;
            return;
        } catch (error) {
            firstFailure ??= error;
        }
    }
    throw cleanupError(firstFailure);
}

export async function createPrivateTempLease(
    options: PrivateTempOptions = {},
): Promise<PrivateTempLease> {
    const rootDir = resolve(options.rootDir ?? defaultRootDir());
    if (!isAbsolute(rootDir)) {
        throw new SandboxExecutionError("invalid-policy", {
            cause: new Error("Lease root must be absolute"),
        });
    }
    const ownerPid = options.ownerPid ?? process.pid;
    validateOwnerPid(ownerPid);
    await mkdir(rootDir, { recursive: true, mode: 0o700 });
    await assertPrivateRootDirectory(rootDir);

    for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
        const randomId = options.randomId ?? randomBytes(3).toString("hex");
        validateRandomId(randomId);
        const id = leaseId(ownerPid, randomId);
        const root = join(rootDir, id);
        const homeDir = join(root, "home");
        const tmpDir = join(root, "tmp");
        const zeroboxHome = join(root, "zerobox-home");
        const proxyRunsDir = join(zeroboxHome, "tmp", "runs");
        const profilesDir = join(zeroboxHome, "profiles");
        const markerPath = join(root, LEASE_MARKER_FILENAME);
        assertSocketBudget(zeroboxHome);
        let rootCreated = false;

        try {
            await mkdir(root, { mode: 0o700 });
            rootCreated = true;
            await Promise.all(
                [homeDir, tmpDir, proxyRunsDir, profilesDir].map(
                    async (path) => {
                        await mkdir(path, { recursive: true, mode: 0o700 });
                        await chmod(path, 0o700);
                    },
                ),
            );
            await chmod(zeroboxHome, 0o700);
            const marker: LeaseMarker = {
                version: LEASE_MARKER_VERSION,
                leaseId: id,
                ownerPid,
            };
            await writeFile(markerPath, JSON.stringify(marker), {
                encoding: "utf8",
                flag: "wx",
                mode: 0o600,
            });
            await chmod(markerPath, 0o600);

            let disposed = false;
            const disposalState: DisposalState = {};
            return {
                root,
                homeDir,
                tmpDir,
                zeroboxHome,
                proxyRunsDir,
                profilesDir,
                markerPath,
                async dispose() {
                    if (disposed) return;
                    await safeDisposeRoot(
                        root,
                        markerPath,
                        id,
                        options.removeTree ?? defaultRemoveTree,
                        disposalState,
                    );
                    disposed = true;
                },
            };
        } catch (error) {
            if (
                (error as NodeJS.ErrnoException).code === "EEXIST" &&
                !rootCreated
            ) {
                if (options.randomId === undefined) continue;
                throw new SandboxExecutionError("setup-failed", {
                    cause: error,
                });
            }
            if (error instanceof SandboxExecutionError) throw error;
            if (rootCreated) {
                try {
                    const stat = await lstat(root);
                    if (stat.isDirectory() && !stat.isSymbolicLink()) {
                        await rm(root, { recursive: true, force: true });
                    }
                } catch {
                    // Best effort for a partial directory created by this call.
                }
            }
            throw new SandboxExecutionError("setup-failed", { cause: error });
        }
    }
    throw new SandboxExecutionError("setup-failed", {
        cause: new Error("Could not allocate a unique lease"),
    });
}

function defaultIsPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
}

export async function recoverStalePrivateTempLeases(
    options: RecoveryOptions = {},
): Promise<RecoveryResult> {
    const rootDir = resolve(options.rootDir ?? defaultRootDir());
    const removed: string[] = [];
    const retained: string[] = [];
    let entries;
    try {
        await assertPrivateRootDirectory(rootDir);
        entries = await readdir(rootDir, { withFileTypes: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return { removed, retained };
        }
        if (error instanceof SandboxExecutionError) throw error;
        throw cleanupError(error);
    }
    const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;

    for (const entry of entries) {
        const root = join(rootDir, entry.name);
        const detachedMatch = /^\.gc-(l-[a-f0-9]{6})-[a-f0-9]{12}$/.exec(
            entry.name,
        );
        if (
            !entry.isDirectory() ||
            entry.isSymbolicLink() ||
            (!entry.name.startsWith(LEASE_PREFIX) && detachedMatch === null)
        ) {
            retained.push(root);
            continue;
        }
        const markerPath = join(root, LEASE_MARKER_FILENAME);
        const expectedId = detachedMatch?.[1] ?? entry.name;
        const marker = await readValidMarker(markerPath, expectedId);
        if (marker === null || isPidAlive(marker.ownerPid)) {
            retained.push(root);
            continue;
        }
        try {
            if (detachedMatch) await defaultRemoveTree(root);
            else
                await safeDisposeRoot(
                    root,
                    markerPath,
                    entry.name,
                    defaultRemoveTree,
                    {},
                );
            removed.push(root);
        } catch {
            retained.push(root);
        }
    }
    return { removed, retained };
}

function attachCleanup(primary: unknown, cleanup: SandboxExecutionError): void {
    const detail = cleanup.getCause() ?? cleanup;
    if (primary instanceof SandboxExecutionError) {
        primary.attachCleanupError(detail);
    } else if (primary instanceof Error) {
        Object.defineProperty(primary, "cleanupError", {
            configurable: true,
            enumerable: false,
            value: detail,
            writable: true,
        });
    }
}

export async function withPrivateTempLease<T>(
    action: (lease: PrivateTempLease) => Promise<T>,
    options: PrivateTempOptions = {},
): Promise<T> {
    const lease = await createPrivateTempLease(options);
    let result: T | undefined;
    let primary: unknown;
    try {
        result = await action(lease);
    } catch (error) {
        primary = error;
    }

    let cleanup: SandboxExecutionError | undefined;
    try {
        await lease.dispose();
    } catch (error) {
        cleanup =
            error instanceof SandboxExecutionError
                ? error
                : cleanupError(error);
    }
    if (primary !== undefined) {
        if (cleanup) attachCleanup(primary, cleanup);
        throw primary;
    }
    if (cleanup) throw cleanup;
    return result as T;
}
