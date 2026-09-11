import { afterEach, expect, test } from "bun:test";

import {
    claimSandboxRuntime,
    publishSandboxRuntime,
    releaseSandboxRuntime,
} from "../_shared/sandbox-runtime/index.ts";
import { resolveBashOperations } from "./builtin-bash.ts";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionProvenance } from "../_shared/execution-provenance/types.ts";
import {
    activeShellOperations,
    publishShellRuntime,
    releaseShellRuntime,
} from "../sandbox/capabilities/runtime.ts";
import { emptyGrants } from "../sandbox/capabilities/authority.ts";
import { createBashProcessSupervisor } from "../_shared/command-execution/exec.ts";
import type { ShellCapabilityResolution } from "../sandbox/capabilities/policy.ts";

const owner = Symbol("capability-routing");
afterEach(() => {
    releaseSandboxRuntime(owner);
    releaseShellRuntime(owner);
});

async function waitForPath(path: string): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt++) {
        if (existsSync(path)) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Timed out waiting for fixture path: ${path}`);
}

test("a disabled engine does not grant host execution", async () => {
    claimSandboxRuntime(owner);
    publishSandboxRuntime(owner, { state: "disabled" });
    let spawned = false;
    const operations = resolveBashOperations({
        createOperations: () => ({
            exec: async () => {
                spawned = true;
                return { exitCode: 0 };
            },
        }),
        shutdown: () => {},
    });
    await expect(
        operations.exec("true", process.cwd(), { onData: () => {} }),
    ).rejects.toThrow();
    expect(spawned).toBe(false);
});

test.each(["replacement", "release"] as const)(
    "does not admit an operation when the shell runtime is %s during preparation",
    async (change) => {
        let releasePreparation!: () => void;
        const preparation = new Promise<void>((resolve) => {
            releasePreparation = resolve;
        });
        const preparingOwner = Symbol("preparing-shell-runtime");
        const replacementOwner = Symbol("replacement-shell-runtime");
        const policy: ShellCapabilityResolution = {
            state: "ready",
            mode: "host",
            projectRoot: process.cwd(),
            requestedProfile: "host",
            profile: "host",
            grants: emptyGrants(),
            requestedGrants: emptyGrants(),
            authorityPath: "/unused",
        };
        publishShellRuntime(
            preparingOwner,
            () => policy,
            async () => preparation,
        );
        let spawned = false;
        const operations = resolveBashOperations({
            createOperations: () => ({
                exec: async () => {
                    spawned = true;
                    return { exitCode: 0 };
                },
            }),
            shutdown: () => {},
        });
        const pending = operations.exec("true", process.cwd(), {
            onData: () => {},
        });
        await Promise.resolve();

        if (change === "replacement") {
            publishShellRuntime(replacementOwner, () => policy);
        } else {
            releaseShellRuntime(preparingOwner);
        }
        releasePreparation();

        await expect(pending).rejects.toThrow("runtime changed during policy preparation");
        expect(spawned).toBe(false);
        releaseShellRuntime(preparingOwner);
        releaseShellRuntime(replacementOwner);
    },
);

test("rejects stale preparation after a same-owner publication and admits the current request", async () => {
    let releasePreparation!: () => void;
    const preparation = new Promise<void>((resolve) => {
        releasePreparation = resolve;
    });
    const sessionOwner = Symbol("session-owner");
    const policy: ShellCapabilityResolution = {
        state: "ready",
        mode: "host",
        projectRoot: process.cwd(),
        requestedProfile: "host",
        profile: "host",
        grants: emptyGrants(),
        requestedGrants: emptyGrants(),
        authorityPath: "/unused",
    };
    publishShellRuntime(
        sessionOwner,
        () => policy,
        async () => preparation,
    );
    let spawned = 0;
    const operations = resolveBashOperations({
        createOperations: () => ({
            exec: async () => {
                spawned += 1;
                return { exitCode: 0 };
            },
        }),
        shutdown: () => {},
    });
    const stale = operations.exec("true", process.cwd(), { onData: () => {} });
    await Promise.resolve();
    publishShellRuntime(sessionOwner, () => policy);
    releasePreparation();

    await expect(stale).rejects.toThrow("runtime changed during policy preparation");
    await expect(
        operations.exec("true", process.cwd(), { onData: () => {} }),
    ).resolves.toEqual({ exitCode: 0 });
    expect(spawned).toBe(1);
    releaseShellRuntime(sessionOwner);
});

test.each([
    ["string", "dev-services"],
    ["null", null],
    ["undefined", undefined],
] as const)(
    "legacy hostCapability (%s) is migration-required before launch",
    async (_label, legacyValue) => {
        const options = {
            hostCapability: legacyValue as unknown as "editor",
        } as unknown as Parameters<typeof resolveBashOperations>[1];
        const policy: ShellCapabilityResolution = {
            state: "ready",
            projectRoot: process.cwd(),
            requestedProfile: "custom",
            profile: "custom",
            grants: emptyGrants(),
            requestedGrants: emptyGrants(),
            authorityPath: "/unused",
            sandboxFingerprint: "legacy",
        };
        claimSandboxRuntime(owner);
        publishShellRuntime(owner, () => policy);
        let spawned = false;
        const operations = resolveBashOperations(
            {
                createOperations: () => ({
                    exec: async () => {
                        spawned = true;
                        return { exitCode: 0 };
                    },
                }),
                shutdown: () => {},
            },
            options,
        );

        await expect(
            operations.exec("true", process.cwd(), { onData: () => {} }),
        ).rejects.toThrow(/migration-required/);
        expect(spawned).toBe(false);
    },
);

test("sandbox execution follows the ordinary backend and keeps the same command", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sandbox-ordinary-"));
    const cwd = join(root, "project");
    mkdirSync(cwd);
    const policy: ShellCapabilityResolution = {
        state: "ready",
        projectRoot: cwd,
        requestedProfile: "custom",
        profile: "custom",
        grants: emptyGrants(),
        requestedGrants: emptyGrants(),
        authorityPath: join(root, "authority"),
    };
    claimSandboxRuntime(owner);
    publishShellRuntime(owner, () => policy);
    let runtimeCommand: string | undefined;
    let runtimeCalled = false;
    publishSandboxRuntime(owner, {
        state: "enabled",
        createBashOperations: (runtimeOptions) => {
            runtimeCalled = true;
            return {
                exec: async (command, _executionCwd, _executionOptions) => {
                    runtimeCommand = command;
                    runtimeOptions.onExecution?.({
                        status: "sandboxed",
                        profile: "bash-general",
                        backend: "zerobox",
                        tmpNamespace: "lease-private",
                        phase: "source",
                        outcome: "succeeded",
                    });
                    return { exitCode: 0 };
                },
            };
        },
        createThinkBashOperations: () => ({
            exec: async () => {
                throw new Error("unused");
            },
        }),
        analysis: { state: "retrying" },
    });

    let hostBackendCalled = false;
    const operations = resolveBashOperations({
        createOperations: () => {
            hostBackendCalled = true;
            return {
                exec: async () => {
                    throw new Error("unexpected host backend call");
                },
            };
        },
        shutdown: () => {},
    });

    const inputCommand = "printf sandbox-ok";
    const result = await operations.exec(inputCommand, cwd, { onData: () => {} });

    expect(result.exitCode).toBe(0);
    expect(runtimeCalled).toBe(true);
    expect(hostBackendCalled).toBe(false);
    expect(runtimeCommand).toBe(inputCommand);

    rmSync(root, { recursive: true, force: true });
});

test("a descriptive profile never selects the host backend", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-profile-routing-"));
    const cwd = join(root, "project");
    mkdirSync(cwd);
    const policy: ShellCapabilityResolution = {
        state: "ready",
        projectRoot: cwd,
        mode: "sandbox",
        requestedMode: "sandbox",
        requestedProfile: "host",
        profile: "host",
        grants: emptyGrants(),
        requestedGrants: emptyGrants(),
        authorityPath: join(root, "authority"),
    };
    claimSandboxRuntime(owner);
    publishShellRuntime(owner, () => policy);
    let sandboxCalled = false;
    let hostCalled = false;
    publishSandboxRuntime(owner, {
        state: "enabled",
        createBashOperations: () => ({
            exec: async () => {
                sandboxCalled = true;
                return { exitCode: 0 };
            },
        }),
        createThinkBashOperations: () => ({
            exec: async () => {
                throw new Error("unused");
            },
        }),
        analysis: { state: "retrying" },
    });
    const operations = resolveBashOperations({
        createOperations: () => {
            hostCalled = true;
            return {
                exec: async () => ({ exitCode: 0 }),
            };
        },
        shutdown: () => {},
    });

    await expect(
        operations.exec("true", cwd, { onData: () => {} }),
    ).resolves.toEqual({ exitCode: 0 });
    expect(sandboxCalled).toBe(true);
    expect(hostCalled).toBe(false);
    rmSync(root, { recursive: true, force: true });
});

test("backend failures do not fallback between backends", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-backend-fallback-"));
    const cwd = join(root, "project");
    mkdirSync(cwd);

    try {
        const policy: ShellCapabilityResolution = {
            state: "ready",
            projectRoot: cwd,
            mode: "host",
            requestedMode: "host",
            requestedProfile: "host",
            profile: "host",
            grants: emptyGrants(),
            requestedGrants: emptyGrants(),
            authorityPath: join(root, "authority"),
        };
        publishShellRuntime(owner, () => policy);
        claimSandboxRuntime(owner);
        let sandboxUsedForHost = false;
        publishSandboxRuntime(owner, {
            state: "enabled",
            createBashOperations: () => {
                sandboxUsedForHost = true;
                return {
                    exec: async () => {
                        throw new Error("unexpected sandbox fallback");
                    },
                };
            },
            createThinkBashOperations: () => ({
                exec: async () => {
                    throw new Error("unused");
                },
            }),
            analysis: { state: "retrying" },
        });

        let hostBackendCalled = false;
        const hostOperations = resolveBashOperations({
            createOperations: () => {
                hostBackendCalled = true;
                return {
                    exec: async () => {
                        throw new Error("backend unavailable");
                    },
                };
            },
            shutdown: () => {},
        });

        await expect(
            hostOperations.exec("true", cwd, { onData: () => {} }),
        ).rejects.toThrow("backend unavailable");
        expect(hostBackendCalled).toBe(true);
        expect(sandboxUsedForHost).toBe(false);

        const sandboxPolicy: ShellCapabilityResolution = {
            state: "ready",
            projectRoot: cwd,
            requestedProfile: "custom",
            profile: "custom",
            grants: emptyGrants(),
            requestedGrants: emptyGrants(),
            authorityPath: join(root, "authority"),
        };
        publishShellRuntime(owner, () => sandboxPolicy);
        let sandboxBackendCalled = false;
        publishSandboxRuntime(owner, {
            state: "enabled",
            createBashOperations: () => {
                sandboxBackendCalled = true;
                return {
                    exec: async () => {
                        throw new Error("sandbox backend unavailable");
                    },
                };
            },
            createThinkBashOperations: () => ({
                exec: async () => {
                    throw new Error("unused");
                },
            }),
            analysis: { state: "retrying" },
        });

        let localBackendCalled = false;
        const sandboxOperations = resolveBashOperations({
            createOperations: () => {
                localBackendCalled = true;
                return {
                    exec: async () => ({ exitCode: 0 }),
                };
            },
            shutdown: () => {},
        });
        await expect(
            sandboxOperations.exec("true", cwd, { onData: () => {} }),
        ).rejects.toThrow("sandbox backend unavailable");
        expect(sandboxBackendCalled).toBe(true);
        expect(localBackendCalled).toBe(false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test.each(["timeout", "abort"] as const)(
    "an explicitly authorized host execution keeps %s control",
    async (control) => {
        const root = mkdtempSync(join(tmpdir(), `pi-host-${control}-`));
        const cwd = join(root, "project");
        mkdirSync(cwd);
        const executable = join(root, "host-loop");
        const started = join(root, "started");
        writeFileSync(
            executable,
            `#!/bin/sh\ntrap 'exit 0' TERM INT\nprintf started >> '${started}'\nwhile :; do sleep 0.01; done\n`,
            { mode: 0o700 },
        );
        const policy: ShellCapabilityResolution = {
            state: "ready",
            projectRoot: cwd,
            mode: "host",
            requestedMode: "host",
            requestedProfile: "host",
            profile: "host",
            grants: emptyGrants(),
            requestedGrants: emptyGrants(),
            authorityPath: join(root, "authority"),
        };
        publishShellRuntime(owner, () => policy);
        const controller = new AbortController();
        const supervisor = createBashProcessSupervisor();
        let execution: ExecutionProvenance | undefined;
        try {
            const operations = resolveBashOperations(supervisor, {
                onExecution: (value) => {
                    execution = value;
                },
            });
            const running = operations.exec(executable, cwd, {
                onData: () => {},
                ...(control === "timeout"
                    ? { timeout: 0.05 }
                    : { signal: controller.signal }),
            });
            await waitForPath(started);
            if (control === "abort") controller.abort();

            await expect(running).rejects.toThrow(
                control === "timeout" ? "timeout:0.05" : "aborted",
            );
            expect(execution).toMatchObject({
                shellProfile: "host",
                status: "unsandboxed",
                backend: "local",
                tmpNamespace: "host",
                outcome: control === "timeout" ? "timed-out" : "aborted",
            });
        } finally {
            supervisor.shutdown();
            rmSync(root, { recursive: true, force: true });
        }
    },
);

test("revocation blocks the next host call while the admitted operation finishes", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-host-revocation-"));
    const cwd = join(root, "project");
    mkdirSync(cwd);
    const executable = join(root, "host-op");
    const started = join(root, "started");
    const release = join(root, "release");
    writeFileSync(
        executable,
        `#!/bin/sh\nprintf 'started\\n' >> '${started}'\nwhile [ ! -e '${release}' ]; do sleep 0.01; done\nprintf 'host-finished'\n`,
        { mode: 0o700 },
    );
    const policy: ShellCapabilityResolution = {
        state: "ready",
        projectRoot: cwd,
        mode: "host",
        requestedMode: "host",
        requestedProfile: "host",
        profile: "host",
        grants: emptyGrants(),
        requestedGrants: emptyGrants(),
        authorityPath: join(root, "authority"),
    };
    publishShellRuntime(owner, () => policy);
    const supervisor = createBashProcessSupervisor();
    let first: Promise<{ exitCode: number | null }> | undefined;

    try {
        const operations = resolveBashOperations(supervisor);
        let output = "";
        first = operations.exec(executable, cwd, {
            onData: (chunk) => {
                output += chunk.toString();
            },
        });
        await waitForPath(started);
        expect(activeShellOperations()).toHaveLength(1);
        expect(readFileSync(started, "utf8")).toBe("started\n");

        publishShellRuntime(owner, () => ({ ...policy, state: "authorization-required" }));
        await expect(
            operations.exec("false", cwd, { onData: () => {} }),
        ).rejects.toThrow("Shell execution is blocked");
        expect(activeShellOperations()).toHaveLength(1);
        expect(readFileSync(started, "utf8")).toBe("started\n");

        writeFileSync(release, "release\n");
        await expect(first).resolves.toEqual({ exitCode: 0 });
        expect(output).toBe("host-finished");
        expect(activeShellOperations()).toHaveLength(0);
    } finally {
        if (!existsSync(release)) writeFileSync(release, "release\n");
        await first?.catch(() => undefined);
        supervisor.shutdown();
        rmSync(root, { recursive: true, force: true });
    }
});

test("revocation blocks the next sandboxed call while the admitted operation finishes", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-sandbox-revocation-"));
    const cwd = join(root, "project");
    mkdirSync(cwd);
    const executable = join(root, "sandbox-op");
    const started = join(root, "started");
    const release = join(root, "release");
    writeFileSync(
        executable,
        `#!/bin/sh\nprintf 'started\n' >> '${started}'\nwhile [ ! -e '${release}' ]; do sleep 0.01; done\nprintf 'sandbox-finished'\n`,
        { mode: 0o700 },
    );
    const policy: ShellCapabilityResolution = {
        state: "ready",
        projectRoot: cwd,
        requestedProfile: "custom",
        profile: "custom",
        grants: emptyGrants(),
        requestedGrants: emptyGrants(),
        authorityPath: join(root, "authority"),
        sandboxFingerprint: "before-revocation",
    };
    claimSandboxRuntime(owner);
    publishShellRuntime(owner, () => policy);

    const sandboxSupervisor = createBashProcessSupervisor();
    publishSandboxRuntime(owner, {
        state: "enabled",
        sandboxFingerprint: "before-revocation",
        createBashOperations: (runtimeOptions) => ({
            exec: async (command, commandCwd, executionOptions) =>
                sandboxSupervisor.createOperations(runtimeOptions).exec(
                    command,
                    commandCwd,
                    executionOptions,
                ),
        }),
        createThinkBashOperations: () => ({
            exec: async () => {
                throw new Error("unused");
            },
        }),
        analysis: { state: "retrying" },
    });

    let first: Promise<{ exitCode: number | null }> | undefined;
    try {
        const operations = resolveBashOperations({
            createOperations: () => ({
                exec: async () => {
                    throw new Error("unexpected host path");
                },
            }),
            shutdown: () => {},
        });

        let output = "";
        first = operations.exec(executable, cwd, {
            onData: (chunk) => {
                output += chunk.toString();
            },
        });
        await waitForPath(started);
        expect(activeShellOperations()).toHaveLength(1);

        publishShellRuntime(owner, () => ({
            ...policy,
            sandboxFingerprint: "after-revocation",
        }));
        await expect(
            operations.exec("false", cwd, { onData: () => {} }),
        ).rejects.toThrow("policy changed");
        expect(activeShellOperations()).toHaveLength(1);
        expect(readFileSync(started, "utf8")).toBe("started\n");

        writeFileSync(release, "release\n");
        await expect(first).resolves.toEqual({ exitCode: 0 });
        expect(output).toBe("sandbox-finished");
        expect(activeShellOperations()).toHaveLength(0);
    } finally {
        if (!existsSync(release)) writeFileSync(release, "release\n");
        await first?.catch(() => undefined);
        sandboxSupervisor.shutdown();
        rmSync(root, { recursive: true, force: true });
    }
});
