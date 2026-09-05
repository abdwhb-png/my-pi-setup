import { describe, expect, it, mock } from "bun:test";

import type {
    PrivateTempLease,
    SandboxBackend,
    SandboxCommand,
    SandboxPolicy,
} from "./contracts.ts";
import { SANDBOX_CAPABILITIES, SandboxExecutionError } from "./contracts.ts";
import { validatePiSandboxConfig } from "./policies.ts";
import { createSandboxService } from "./service.ts";

function fakeLease(id: number): PrivateTempLease {
    const root = `/lease/${id}`;
    return {
        root,
        homeDir: `${root}/home`,
        tmpDir: `${root}/tmp`,
        zeroboxHome: `${root}/zerobox-home`,
        proxyRunsDir: `${root}/zerobox-home/tmp/runs`,
        profilesDir: `${root}/zerobox-home/profiles`,
        markerPath: `${root}/marker`,
        dispose: mock(async () => undefined),
    };
}

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

describe("sandbox service", () => {
    it("reuses one Bash lease and gives every analysis request a fresh lease", async () => {
        const leases: PrivateTempLease[] = [];
        const createLease = mock(async () => {
            const lease = fakeLease(leases.length + 1);
            leases.push(lease);
            return lease;
        });
        const prepare = mock(
            async (command: SandboxCommand, policy: SandboxPolicy, lease: PrivateTempLease) => ({
                file: "/managed/zerobox",
                args: [policy.name, command.file],
                cwd: command.cwd,
                env: {},
                statusProtocol: { fd: 3 as const, version: 1 as const },
                extraStdio: ["pipe" as const],
                supervise: () => ({ ready: Promise.resolve(), settled: Promise.resolve() }),
                leaseRoot: lease.root,
            }),
        );
        const backend = {
            probe: mock(async () => SANDBOX_CAPABILITIES),
            prepare,
        } as SandboxBackend;
        const recoverStaleLeases = mock(async () => undefined);
        const service = createSandboxService({
            backend,
            config: validatePiSandboxConfig({
                filesystem: { allowWrite: ["."] },
            }),
            createLease,
            recoverStaleLeases,
        });

        await service.startBashSession("/workspace");
        const firstBash = await service.prepareBash({
            file: "/bin/bash",
            args: ["-c", "one"],
            cwd: "/workspace",
        });
        const secondBash = await service.prepareBash({
            file: "/bin/bash",
            args: ["-c", "two"],
            cwd: "/workspace",
        });
        expect((firstBash as unknown as { leaseRoot: string }).leaseRoot).toBe("/lease/1");
        expect((secondBash as unknown as { leaseRoot: string }).leaseRoot).toBe("/lease/1");

        const firstAnalysis = await service.prepareAnalysis(
            { file: "/usr/bin/prlimit", args: [], cwd: "/runtime" },
            ["/runtime"],
        );
        const secondAnalysis = await service.prepareAnalysis(
            { file: "/usr/bin/prlimit", args: [], cwd: "/runtime" },
            ["/runtime"],
        );
        expect((firstAnalysis.spawn as unknown as { leaseRoot: string }).leaseRoot).toBe("/lease/2");
        expect((secondAnalysis.spawn as unknown as { leaseRoot: string }).leaseRoot).toBe("/lease/3");
        await firstAnalysis.dispose();
        await secondAnalysis.dispose();
        expect(leases[1]?.dispose).toHaveBeenCalledTimes(1);
        expect(leases[2]?.dispose).toHaveBeenCalledTimes(1);

        await service.shutdown();
        await service.shutdown();
        expect(leases[0]?.dispose).toHaveBeenCalledTimes(1);
        expect(recoverStaleLeases).toHaveBeenCalledTimes(1);
    });

    it("cleans a fresh analysis lease when preparation fails", async () => {
        const lease = fakeLease(1);
        const primary = new SandboxExecutionError("setup-failed");
        const backend = {
            probe: async () => SANDBOX_CAPABILITIES,
            prepare: async () => {
                throw primary;
            },
        } as SandboxBackend;
        const service = createSandboxService({
            backend,
            config: validatePiSandboxConfig({}),
            createLease: async () => lease,
        });

        await expect(
            service.prepareAnalysis(
                { file: "/usr/bin/prlimit", args: [], cwd: "/runtime" },
                ["/runtime"],
            ),
        ).rejects.toBe(primary);
        expect(lease.dispose).toHaveBeenCalledTimes(1);
    });

    it("fails closed before lease creation when stale recovery fails", async () => {
        const createLease = mock(async () => fakeLease(1));
        const recoveryFailure = new SandboxExecutionError("cleanup-failed");
        const service = createSandboxService({
            backend: {
                probe: async () => SANDBOX_CAPABILITIES,
                prepare: async () => {
                    throw new Error("prepare must not run");
                },
            },
            config: validatePiSandboxConfig({}),
            createLease,
            recoverStaleLeases: async () => {
                throw recoveryFailure;
            },
        });

        await expect(service.startBashSession("/workspace")).rejects.toBe(
            recoveryFailure,
        );
        expect(createLease).not.toHaveBeenCalled();
    });

    it("retains and retries a Bash lease whose cleanup failed", async () => {
        const lease = fakeLease(1);
        const cleanupFailure = new Error("cleanup failed");
        lease.dispose = mock()
            .mockRejectedValueOnce(cleanupFailure)
            .mockResolvedValueOnce(undefined);
        const service = createSandboxService({
            backend: {
                probe: async () => SANDBOX_CAPABILITIES,
                prepare: async () => {
                    throw new Error("not exercised");
                },
            },
            config: validatePiSandboxConfig({}),
            createLease: async () => lease,
        });
        await service.startBashSession("/workspace");

        await expect(service.shutdown()).rejects.toBe(cleanupFailure);
        await expect(service.shutdown()).resolves.toBeUndefined();
        expect(lease.dispose).toHaveBeenCalledTimes(2);
    });

    it("rejects an invalid Bash policy before the session can be published", async () => {
        const lease = fakeLease(1);
        const service = createSandboxService({
            backend: {
                probe: async () => SANDBOX_CAPABILITIES,
                prepare: async () => {
                    throw new Error("not exercised");
                },
            },
            config: validatePiSandboxConfig({
                filesystem: { allowWrite: ["/tmp"] },
            }),
            createLease: async () => lease,
        });

        await expect(service.startBashSession("/workspace")).rejects.toMatchObject({
            code: "invalid-policy",
        });
        expect(lease.dispose).toHaveBeenCalledTimes(1);
    });

    it("retains an unpublished lease when invalid-policy cleanup fails", async () => {
        const lease = fakeLease(1);
        const cleanupFailure = new Error("cleanup failed");
        lease.dispose = mock()
            .mockRejectedValueOnce(cleanupFailure)
            .mockResolvedValueOnce(undefined);
        const service = createSandboxService({
            backend: {
                probe: async () => SANDBOX_CAPABILITIES,
                prepare: async () => {
                    throw new Error("not exercised");
                },
            },
            config: validatePiSandboxConfig({
                filesystem: { allowWrite: ["/tmp"] },
            }),
            createLease: async () => lease,
        });

        await expect(service.startBashSession("/workspace")).rejects.toMatchObject({
            code: "invalid-policy",
        });
        await expect(service.shutdown()).resolves.toBeUndefined();
        expect(lease.dispose).toHaveBeenCalledTimes(2);
    });

    it("joins concurrent Bash session starts instead of leaking a losing lease", async () => {
        const lease = fakeLease(1);
        const createStarted = deferred();
        const releaseCreate = deferred();
        const createLease = mock(async () => {
            createStarted.resolve();
            await releaseCreate.promise;
            return lease;
        });
        const service = createSandboxService({
            backend: {
                probe: async () => SANDBOX_CAPABILITIES,
                prepare: async () => {
                    throw new Error("not exercised");
                },
            },
            config: validatePiSandboxConfig({}),
            createLease,
        });

        const first = service.startBashSession("/workspace");
        await createStarted.promise;
        const second = service.startBashSession("/workspace");
        await Promise.resolve();
        expect(createLease).toHaveBeenCalledTimes(1);

        releaseCreate.resolve();
        await Promise.all([first, second]);
        expect(createLease).toHaveBeenCalledTimes(1);
        await service.shutdown();
        expect(lease.dispose).toHaveBeenCalledTimes(1);
    });

    it("waits for an in-flight analysis prepare before closing and disposing it", async () => {
        const lease = fakeLease(1);
        const prepareStarted = deferred();
        const releasePrepare = deferred();
        const backend = {
            probe: async () => SANDBOX_CAPABILITIES,
            prepare: async (command: SandboxCommand) => {
                prepareStarted.resolve();
                await releasePrepare.promise;
                return {
                    file: "/managed/zerobox",
                    args: [command.file],
                    cwd: command.cwd,
                    env: {},
                    statusProtocol: { fd: 3 as const, version: 1 as const },
                    extraStdio: ["pipe" as const],
                    supervise: () => ({
                        ready: Promise.resolve(),
                        settled: Promise.resolve(),
                    }),
                };
            },
        } as SandboxBackend;
        const service = createSandboxService({
            backend,
            config: validatePiSandboxConfig({}),
            createLease: async () => lease,
        });

        const preparation = service.prepareAnalysis(
            { file: "/usr/bin/prlimit", args: [], cwd: "/runtime" },
            ["/runtime"],
        );
        await prepareStarted.promise;
        const shutdown = service.shutdown();
        releasePrepare.resolve();
        const [handle] = await Promise.all([preparation, shutdown]);

        expect(lease.dispose).toHaveBeenCalledTimes(1);
        await handle.dispose();
        expect(lease.dispose).toHaveBeenCalledTimes(1);
        await expect(
            service.prepareAnalysis(
                { file: "/usr/bin/prlimit", args: [], cwd: "/runtime" },
                ["/runtime"],
            ),
        ).rejects.toMatchObject({ code: "setup-failed" });
    });

    it("invalidates a delayed Bash spawn when shutdown begins during preparation", async () => {
        const lease = fakeLease(1);
        const prepareStarted = deferred();
        const releasePrepare = deferred();
        const service = createSandboxService({
            backend: {
                probe: async () => SANDBOX_CAPABILITIES,
                prepare: async (command: SandboxCommand) => {
                    prepareStarted.resolve();
                    await releasePrepare.promise;
                    return {
                        file: "/managed/zerobox",
                        args: [command.file],
                        cwd: command.cwd,
                        env: {},
                        statusProtocol: { fd: 3 as const, version: 1 as const },
                        extraStdio: ["pipe" as const],
                        supervise: () => ({
                            ready: Promise.resolve(),
                            settled: Promise.resolve(),
                        }),
                    };
                },
            },
            config: validatePiSandboxConfig({}),
            createLease: async () => lease,
        });
        await service.startBashSession("/workspace");

        const preparation = service.prepareBash({
            file: "/bin/bash",
            args: ["-c", "true"],
            cwd: "/workspace",
        });
        await prepareStarted.promise;
        const shutdown = service.shutdown();
        releasePrepare.resolve();
        const prepared = await preparation;
        const beforeSpawn = prepared.beforeSpawn;

        expect(beforeSpawn).toBeFunction();
        if (!beforeSpawn) {
            throw new Error("Expected the prepared spawn to expose beforeSpawn");
        }
        expect(() => beforeSpawn()).toThrow("Sandbox setup failed");
        await shutdown;
        expect(lease.dispose).toHaveBeenCalledTimes(1);
    });
});
