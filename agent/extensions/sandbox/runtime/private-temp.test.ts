import { describe, expect, it } from "bun:test";
import {
    chmod,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { SandboxExecutionError } from "./contracts.ts";
import {
    LEASE_MARKER_FILENAME,
    createPrivateTempLease,
    recoverStalePrivateTempLeases,
    withPrivateTempLease,
    worstCaseProxySocketPath,
} from "./private-temp.ts";

function permissions(mode: number): number {
    return mode & 0o777;
}

describe("private Zerobox temp leases", () => {
    it("creates unique bounded owner-only trees and an exact marker", async () => {
        const parent = await mkdtemp(join(tmpdir(), "z-"));
        const rootDir = join(parent, "r");
        try {
            const leases = await Promise.all(
                Array.from({ length: 8 }, () =>
                    createPrivateTempLease({ rootDir }),
                ),
            );
            expect(new Set(leases.map((lease) => lease.root)).size).toBe(8);

            for (const lease of leases) {
                const id = lease.root.slice(rootDir.length + 1);
                expect(id).toMatch(/^l-[a-f0-9]{6}$/);
                expect(id.length).toBeLessThanOrEqual(8);
                expect(Buffer.byteLength(worstCaseProxySocketPath(lease.zeroboxHome))).toBeLessThan(108);
                expect(permissions((await lstat(rootDir)).mode)).toBe(0o700);
                for (const directory of [
                    lease.root,
                    lease.homeDir,
                    lease.tmpDir,
                    lease.zeroboxHome,
                    lease.proxyRunsDir,
                    lease.profilesDir,
                ]) {
                    expect(permissions((await lstat(directory)).mode)).toBe(0o700);
                }
                expect(permissions((await lstat(lease.markerPath)).mode)).toBe(0o600);
                expect(JSON.parse(await readFile(lease.markerPath, "utf8"))).toEqual({
                    version: 1,
                    leaseId: id,
                    ownerPid: process.pid,
                });
                await lease.dispose();
                await lease.dispose();
                expect(await lstat(lease.root).catch(() => null)).toBeNull();
            }
        } finally {
            await rm(parent, { recursive: true, force: true });
        }
    });

    it("never removes an active lease when an explicit id collides", async () => {
        const parent = await mkdtemp(join(tmpdir(), "z-"));
        const rootDir = join(parent, "r");
        const first = await createPrivateTempLease({
            rootDir,
            randomId: "abcdef",
        });
        try {
            await expect(
                createPrivateTempLease({ rootDir, randomId: "abcdef" }),
            ).rejects.toMatchObject({ code: "setup-failed" });
            expect(await lstat(first.root)).toBeDefined();
            expect(await lstat(first.markerPath)).toBeDefined();
        } finally {
            await first.dispose();
            await rm(parent, { recursive: true, force: true });
        }
    });

    it("cleans after success, failure, and abort without replacing the primary error", async () => {
        const parent = await mkdtemp(join(tmpdir(), "z-"));
        const rootDir = join(parent, "r");
        try {
            const value = await withPrivateTempLease(
                async (lease) => {
                    expect(await lstat(lease.root)).toBeDefined();
                    return 42;
                },
                { rootDir },
            );
            expect(value).toBe(42);

            const primary = new SandboxExecutionError("aborted");
            await expect(
                withPrivateTempLease(
                    async () => {
                        throw primary;
                    },
                    { rootDir },
                ),
            ).rejects.toBe(primary);

            const cleanupFailure = new Error("private cleanup detail");
            await expect(
                withPrivateTempLease(async () => "done", {
                    rootDir: join(parent, "c"),
                    removeTree: async () => {
                        throw cleanupFailure;
                    },
                }),
            ).rejects.toMatchObject({ code: "cleanup-failed" });

            const primaryWithCleanup = new SandboxExecutionError("setup-failed");
            await expect(
                withPrivateTempLease(
                    async () => {
                        throw primaryWithCleanup;
                    },
                    {
                        rootDir: join(parent, "p"),
                        removeTree: async () => {
                            throw cleanupFailure;
                        },
                    },
                ),
            ).rejects.toBe(primaryWithCleanup);
            expect(primaryWithCleanup.getCleanupError()).toBe(cleanupFailure);
        } finally {
            await rm(parent, { recursive: true, force: true });
        }
    });

    it("detaches a lease before recursive removal", async () => {
        const parent = await mkdtemp(join(tmpdir(), "z-"));
        const rootDir = join(parent, "r");
        let removedPath: string | undefined;
        try {
            const lease = await createPrivateTempLease({
                rootDir,
                randomId: "abc123",
                removeTree: async (path) => {
                    removedPath = path;
                    expect(path).not.toBe(lease.root);
                    expect(await lstat(lease.root).catch(() => null)).toBeNull();
                    await rm(path, { recursive: true, force: false });
                },
            });

            await lease.dispose();

            expect(basename(removedPath ?? "")).toMatch(
                /^\.gc-l-abc123-[a-f0-9]{12}$/,
            );
            expect(await lstat(lease.root).catch(() => null)).toBeNull();
        } finally {
            await rm(parent, { recursive: true, force: true });
        }
    });

    it("retries a detached lease removal once without leaving gc data", async () => {
        const parent = await mkdtemp(join(tmpdir(), "z-"));
        const rootDir = join(parent, "r");
        let attempts = 0;
        try {
            const lease = await createPrivateTempLease({
                rootDir,
                randomId: "abc123",
                removeTree: async (path) => {
                    attempts += 1;
                    if (attempts === 1) throw new Error("transient busy");
                    await rm(path, { recursive: true, force: false });
                },
            });

            await lease.dispose();

            expect(attempts).toBe(2);
            expect(
                (await readdir(rootDir)).filter((name) =>
                    name.startsWith(".gc-"),
                ),
            ).toEqual([]);
        } finally {
            await rm(parent, { recursive: true, force: true });
        }
    });

    it("never follows a replaced lease symlink during cleanup", async () => {
        const parent = await mkdtemp(join(tmpdir(), "z-"));
        const rootDir = join(parent, "r");
        const protectedDirectory = join(parent, "p");
        await mkdir(protectedDirectory);
        await writeFile(join(protectedDirectory, "keep"), "kept");
        try {
            const lease = await createPrivateTempLease({ rootDir });
            await rm(lease.root, { recursive: true, force: true });
            await symlink(protectedDirectory, lease.root);

            await expect(lease.dispose()).rejects.toMatchObject({
                code: "cleanup-failed",
            });
            expect(await readFile(join(protectedDirectory, "keep"), "utf8")).toBe("kept");
        } finally {
            await rm(parent, { recursive: true, force: true });
        }
    });

    it("recovers only valid marked leases owned by dead processes", async () => {
        const parent = await mkdtemp(join(tmpdir(), "z-"));
        const rootDir = join(parent, "r");
        try {
            const stale = await createPrivateTempLease({
                rootDir,
                ownerPid: 101,
                randomId: "deadbe",
            });
            const live = await createPrivateTempLease({
                rootDir,
                ownerPid: 202,
                randomId: "feedfa",
            });
            const invalid = join(rootDir, "l-badbad");
            const unknown = join(rootDir, "unknown");
            const symlinkTarget = join(parent, "symlink-target");
            const linked = join(rootDir, "l-cafeba");
            await mkdir(invalid, { mode: 0o700 });
            await writeFile(join(invalid, LEASE_MARKER_FILENAME), "not json");
            await mkdir(unknown);
            await mkdir(symlinkTarget);
            await symlink(symlinkTarget, linked);

            const result = await recoverStalePrivateTempLeases({
                rootDir,
                isPidAlive: (pid) => pid === 202,
            });

            expect(result.removed).toEqual([stale.root]);
            expect(result.retained.sort()).toEqual(
                [invalid, linked, live.root, unknown].sort(),
            );
            expect(await lstat(stale.root).catch(() => null)).toBeNull();
            expect(await lstat(live.root)).toBeDefined();
        } finally {
            await rm(parent, { recursive: true, force: true });
        }
    });

    it("rejects a recovery root symlink without touching its target", async () => {
        const parent = await mkdtemp(join(tmpdir(), "z-"));
        const protectedDirectory = join(parent, "protected");
        const rootDir = join(parent, "r");
        await mkdir(protectedDirectory, { mode: 0o700 });
        await writeFile(join(protectedDirectory, "keep"), "kept");
        await symlink(protectedDirectory, rootDir);
        try {
            await expect(
                recoverStalePrivateTempLeases({ rootDir }),
            ).rejects.toMatchObject({ code: "invalid-policy" });
            expect(await readFile(join(protectedDirectory, "keep"), "utf8")).toBe(
                "kept",
            );
        } finally {
            await rm(parent, { recursive: true, force: true });
        }
    });

    it("rejects a root whose real fork socket path cannot fit AF_UNIX", async () => {
        const parent = await mkdtemp(join(tmpdir(), "z-"));
        const rootDir = join(parent, "x".repeat(90));
        try {
            await expect(createPrivateTempLease({ rootDir })).rejects.toMatchObject({
                code: "invalid-policy",
            });
        } finally {
            await rm(parent, { recursive: true, force: true });
        }
    });
});
