import { afterEach, expect, test } from "bun:test";
import { claimSandboxRuntime, publishSandboxRuntime, releaseSandboxRuntime } from "../_shared/sandbox-runtime/index.ts";
import { resolveBashOperations } from "./builtin-bash.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyGrants } from "../sandbox/capabilities/authority.ts";
import { publishShellRuntime, releaseShellRuntime } from "../sandbox/capabilities/runtime.ts";
import { createBashProcessSupervisor } from "../_shared/command-execution/exec.ts";
import type { ShellCapabilityResolution } from "../sandbox/capabilities/policy.ts";

const owner = Symbol("capability-routing");
afterEach(() => { releaseSandboxRuntime(owner); releaseShellRuntime(owner); });
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
