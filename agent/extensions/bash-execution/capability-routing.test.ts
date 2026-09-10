import { afterEach, expect, test } from "bun:test";
import { claimSandboxRuntime, publishSandboxRuntime, releaseSandboxRuntime } from "../_shared/sandbox-runtime/index.ts";
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
import { emptyGrants } from "../sandbox/capabilities/authority.ts";
import {
    activeShellOperations,
    publishShellRuntime,
    releaseShellRuntime,
} from "../sandbox/capabilities/runtime.ts";
import { createBashProcessSupervisor } from "../_shared/command-execution/exec.ts";
import type { ExecutionProvenance } from "../_shared/execution-provenance/types.ts";
import type { ShellCapabilityResolution } from "../sandbox/capabilities/policy.ts";

const owner = Symbol("capability-routing");
afterEach(() => { releaseSandboxRuntime(owner); releaseShellRuntime(owner); });

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
        createOperations: () => ({ exec: async () => { spawned = true; return { exitCode: 0 }; } }),
        shutdown: () => {},
    });
    await expect(operations.exec("true", process.cwd(), { onData: () => {} })).rejects.toThrow();
    expect(spawned).toBe(false);
});

test("an externally revoked sandbox opening blocks new commands against the old runtime", async () => {
    const policy: ShellCapabilityResolution = {
        state: "ready", projectRoot: process.cwd(), requestedProfile: "integrated", profile: "integrated",
        grants: emptyGrants(), requestedGrants: emptyGrants(), authorityPath: "/unused", sandboxFingerprint: "after-revocation",
    };
    publishShellRuntime(owner, () => policy);
    claimSandboxRuntime(owner);
    let spawned = false;
    publishSandboxRuntime(owner, {
        state: "enabled", sandboxFingerprint: "before-revocation",
        createBashOperations: () => ({ exec: async () => { spawned = true; return { exitCode: 0 }; } }),
        createThinkBashOperations: () => { throw new Error("unused"); }, analysis: { state: "retrying" },
    });
    const supervisor = createBashProcessSupervisor();
    try {
        await expect(resolveBashOperations(supervisor).exec("true", process.cwd(), { onData() {} })).rejects.toThrow("policy changed");
        expect(spawned).toBe(false);
    } finally { supervisor.shutdown(); }
});

test("an explicit integration runs its approved executable under host supervision", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-host-routing-"));
    const cwd = join(root, "project");
    mkdirSync(cwd);
    const executable = join(root, "dev-services");
    writeFileSync(executable, '#!/bin/sh\nprintf "host-ok"\n', { mode: 0o700 });
    const policy: ShellCapabilityResolution = {
        state: "ready", projectRoot: cwd, requestedProfile: "integrated", profile: "integrated",
        grants: { ...emptyGrants(), integrations: { "dev-services": { "dev-services": executable } } },
        requestedGrants: emptyGrants(), authorityPath: join(root, "authority"),
    };
    publishShellRuntime(owner, () => policy);
    claimSandboxRuntime(owner);
    publishSandboxRuntime(owner, { state: "error" });
    const supervisor = createBashProcessSupervisor();
    try {
        const operations = resolveBashOperations(supervisor, { hostCapability: "dev-services" });
        let output = "";
        const result = await operations.exec("npm test", cwd, { onData: chunk => { output += chunk.toString(); } });
        expect(result.exitCode).toBe(0);
        expect(output).toBe("host-ok");
        await expect(operations.exec("npm test; true", cwd, { onData: () => {} })).rejects.toThrow("unsupported-command");
        delete policy.grants.integrations["dev-services"];
        await expect(operations.exec("npm test", cwd, { onData: () => {} })).rejects.toThrow("authorization-required");
    } finally { supervisor.shutdown(); rmSync(root, { recursive: true, force: true }); }
});

test("revocation blocks the next host integration while the admitted operation finishes", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-host-revocation-"));
    const cwd = join(root, "project");
    mkdirSync(cwd);
    const executable = join(root, "dev-services");
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
        requestedProfile: "integrated",
        profile: "integrated",
        grants: {
            ...emptyGrants(),
            integrations: {
                "dev-services": { "dev-services": executable },
            },
        },
        requestedGrants: emptyGrants(),
        authorityPath: join(root, "authority"),
    };
    publishShellRuntime(owner, () => policy);
    const supervisor = createBashProcessSupervisor();
    let first: Promise<{ exitCode: number | null }> | undefined;
    try {
        const operations = resolveBashOperations(supervisor, {
            hostCapability: "dev-services",
        });
        let output = "";
        first = operations.exec("npm test", cwd, {
            onData: (chunk) => {
                output += chunk.toString();
            },
        });
        await waitForPath(started);
        expect(activeShellOperations()).toHaveLength(1);

        delete policy.grants.integrations["dev-services"];
        await expect(
            operations.exec("npm test", cwd, { onData() {} }),
        ).rejects.toThrow("authorization-required");
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

test.each(["timeout", "abort"] as const)(
    "host integration preserves explicit %s control",
    async (control) => {
        const root = mkdtempSync(join(tmpdir(), `pi-host-${control}-`));
        const cwd = join(root, "project");
        mkdirSync(cwd);
        const executable = join(root, "dev-services");
        const started = join(root, "started");
        writeFileSync(
            executable,
            `#!/bin/sh\ntrap 'exit 0' TERM INT\nprintf started > '${started}'\nwhile :; do sleep 0.01; done\n`,
            { mode: 0o700 },
        );
        const policy: ShellCapabilityResolution = {
            state: "ready",
            projectRoot: cwd,
            requestedProfile: "integrated",
            profile: "integrated",
            grants: {
                ...emptyGrants(),
                integrations: {
                    "dev-services": { "dev-services": executable },
                },
            },
            requestedGrants: emptyGrants(),
            authorityPath: join(root, "authority"),
        };
        publishShellRuntime(owner, () => policy);
        const supervisor = createBashProcessSupervisor();
        const controller = new AbortController();
        let execution: ExecutionProvenance | undefined;
        try {
            const operations = resolveBashOperations(supervisor, {
                hostCapability: "dev-services",
                onExecution: (value) => {
                    execution = value;
                },
            });
            const running = operations.exec("npm test", cwd, {
                onData() {},
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
                status: "unsandboxed",
                backend: "host",
                shellProfile: "integrated",
                hostCapability: "dev-services",
                tmpNamespace: "host",
                outcome: control === "timeout" ? "timed-out" : "aborted",
            });
        } finally {
            supervisor.shutdown();
            rmSync(root, { recursive: true, force: true });
        }
    },
    10_000,
);
