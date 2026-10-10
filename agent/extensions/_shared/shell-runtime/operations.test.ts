import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { publishShellRuntime, releaseShellRuntime, emptyGrants, resolveForcedSandboxPolicyForExecution } from "./index.ts";
import { resolveBashOperations, resolveForcedSandboxOperations } from "./operations.ts";
import { claimSandboxRuntime, publishSandboxRuntime, releaseSandboxRuntime } from "../sandbox-runtime/index.ts";
import { createBashOperations, createBashProcessSupervisor } from "../command-execution/exec.ts";

test("authority is checked after asynchronous spawn preparation", async () => {
    const shellKey = Symbol.for("pi.shell-capabilities.v1");
    const sandboxKey = Symbol.for("pi.sandbox-runtime.v2");
    const previousShell = Reflect.get(globalThis, shellKey);
    const previousSandbox = Reflect.get(globalThis, sandboxKey);
    const owner = Symbol("final authority");
    const cwd = realpathSync(tmpdir());
    let dispatched = 0;
    let policy = { state: "ready" as const, projectRoot: cwd, mode: "sandbox" as const, profile: "default" as const, requestedProfile: "default" as const, grants: emptyGrants(), requestedGrants: emptyGrants(), authorityPath: "fixture", sandboxFingerprint: "initial" };
    try {
        publishShellRuntime(owner, () => policy, async () => policy);
        claimSandboxRuntime(owner);
        publishSandboxRuntime(owner, {
            state: "enabled", sandboxFingerprint: "initial", analysis: { state: "retrying" },
            createThinkBashOperations: () => { throw new Error("unused"); },
            createBashOperations: options => createBashOperations({
                ...options,
                prepareSpawn: async context => {
                    await Bun.sleep(5);
                    policy = { ...policy, sandboxFingerprint: "revoked" };
                    return { ...context, file: "/bin/true", args: [], extraStdio: [], supervise: () => ({ ready: Promise.resolve(), settled: Promise.resolve() }) };
                },
                spawn: () => { dispatched++; throw new Error("unexpected dispatch"); },
            }),
        });
        await expect(resolveBashOperations(createBashProcessSupervisor()).exec("true", cwd, { onData() {}, timeout: 1 })).rejects.toThrow("Shell policy changed");
        expect(dispatched).toBe(0);
    } finally {
        releaseShellRuntime(owner); releaseSandboxRuntime(owner);
        for (const [key, previous] of [[shellKey, previousShell], [sandboxKey, previousSandbox]] as const) {
            if (previous === undefined) Reflect.deleteProperty(globalThis, key);
            else Reflect.set(globalThis, key, previous);
        }
    }
});

test("the command timeout includes shell policy preparation", async () => {
    const key = Symbol.for("pi.shell-capabilities.v1");
    const previous = Reflect.get(globalThis, key);
    const owner = Symbol("preparation deadline");
    const cwd = realpathSync(tmpdir());
    let dispatched = 0;
    let observed: import("../execution-provenance/types.ts").ExecutionProvenance | undefined;
    try {
        publishShellRuntime(owner, () => ({
            state: "ready", projectRoot: cwd, mode: "host", profile: "host",
            requestedProfile: "host", grants: emptyGrants(), requestedGrants: emptyGrants(), authorityPath: "fixture",
        }), async () => { await Bun.sleep(80); });
        const operations = resolveBashOperations({
            shutdown() {},
            createOperations: () => ({ exec: async () => { dispatched++; return { exitCode: 0 }; } }),
        }, { onExecution: value => { observed = value; } });
        const result = await operations.exec("true", cwd, { onData() {}, timeout: 0.01 }).catch(error => error);
        expect(result).toBeInstanceOf(Error);
        expect(result.message).toContain("timeout:");
        expect(observed?.outcome).toBe("timed-out");
        expect(observed?.timingsMs?.preparation).toBeGreaterThan(0);
        expect(dispatched).toBe(0);
    } finally {
        releaseShellRuntime(owner);
        if (previous === undefined) Reflect.deleteProperty(globalThis, key);
        else Reflect.set(globalThis, key, previous);
    }
});

test("host dispatch rechecks authority after asynchronous command preparation", async () => {
    const key = Symbol.for("pi.shell-capabilities.v1");
    const previous = Reflect.get(globalThis, key);
    const owner = Symbol("host final authority");
    const cwd = realpathSync(tmpdir());
    let dispatched = 0;
    let policy = { state: "ready" as const, projectRoot: cwd, mode: "host" as "host" | "sandbox", profile: "host" as "host" | "default", requestedProfile: "host" as const, grants: emptyGrants(), requestedGrants: emptyGrants(), authorityPath: "fixture" };
    try {
        publishShellRuntime(owner, () => policy, async () => policy);
        const operations = resolveBashOperations({
            shutdown() {},
            createOperations: options => createBashOperations({
                ...options,
                prepareCommand: async context => { await Bun.sleep(5); policy = { ...policy, mode: "sandbox", profile: "default" }; return context; },
                spawn: () => { dispatched++; throw new Error("unexpected dispatch"); },
            }),
        });
        await expect(operations.exec("true", cwd, { onData() {}, timeout: 1 })).rejects.toThrow("Shell policy changed");
        expect(dispatched).toBe(0);
    } finally {
        releaseShellRuntime(owner);
        if (previous === undefined) Reflect.deleteProperty(globalThis, key); else Reflect.set(globalThis, key, previous);
    }
});

test("prepared policy is reused until the final authority read before dispatch", async () => {
    const keys = [Symbol.for("pi.shell-capabilities.v1"), Symbol.for("pi.sandbox-runtime.v2")];
    const previous = keys.map(key => Reflect.get(globalThis, key));
    const owner = Symbol("policy reads");
    const cwd = realpathSync(tmpdir());
    const policy = { state: "ready" as const, projectRoot: cwd, mode: "sandbox" as const, profile: "default" as const, requestedProfile: "default" as const, grants: emptyGrants(), requestedGrants: emptyGrants(), authorityPath: "fixture", sandboxFingerprint: "initial" };
    let reads = 0;
    const read = () => { reads++; return policy; };
    try {
        publishShellRuntime(owner, read, async () => read());
        claimSandboxRuntime(owner);
        publishSandboxRuntime(owner, {
            state: "enabled", sandboxFingerprint: "initial", analysis: { state: "retrying" },
            beforeAdmission: async (_deadline, prepared) => { expect(prepared).toBe(policy); },
            createThinkBashOperations: () => { throw new Error("unused"); },
            createBashOperations: options => createBashOperations({ ...options,
                prepareSpawn: context => ({ ...context, file: "/bin/true", args: [], extraStdio: [], supervise: () => ({ ready: Promise.resolve(), settled: Promise.resolve() }) }),
            }),
        });
        const operations = resolveBashOperations(createBashProcessSupervisor(), { beforeSpawn: () => { throw new Error("fixture dispatch barrier"); } });
        await expect(operations.exec("true", cwd, { onData() {}, timeout: 1 })).rejects.toThrow("fixture dispatch barrier");
        expect(reads).toBe(2);
    } finally {
        releaseShellRuntime(owner); releaseSandboxRuntime(owner);
        for (let i = 0; i < keys.length; i++) {
            if (previous[i] === undefined) Reflect.deleteProperty(globalThis, keys[i]); else Reflect.set(globalThis, keys[i], previous[i]);
        }
    }
});

test("forced sandbox preparation reports a timeout before admission", async () => {
    const key = Symbol.for("pi.shell-capabilities.v1");
    const previous = Reflect.get(globalThis, key);
    const owner = Symbol("forced deadline");
    const cwd = realpathSync(tmpdir());
    const policy = { state: "ready" as const, projectRoot: cwd, mode: "sandbox" as const, profile: "default" as const, requestedProfile: "default" as const, grants: emptyGrants(), requestedGrants: emptyGrants(), authorityPath: "fixture" };
    let observed: import("../execution-provenance/types.ts").ExecutionProvenance | undefined;
    try {
        publishShellRuntime(owner, () => policy, undefined, () => policy, async () => { await Bun.sleep(80); });
        await expect(resolveForcedSandboxOperations({ onExecution: value => { observed = value; } }).exec("true", cwd, { onData() {}, timeout: 0.01 })).rejects.toThrow("timeout:");
        expect(observed?.outcome).toBe("timed-out");
        expect(observed?.phase).toBe("policy");
    } finally {
        releaseShellRuntime(owner);
        if (previous === undefined) Reflect.deleteProperty(globalThis, key); else Reflect.set(globalThis, key, previous);
    }
});

test.each([false, true])("forced preparation preserves its receiver (dedicated callback: %s)", async dedicated => {
    const key = Symbol.for("pi.shell-capabilities.v1");
    const previous = Reflect.get(globalThis, key);
    const owner = Symbol("bound preparation");
    const cwd = realpathSync(tmpdir());
    const policy = { state: "ready" as const, projectRoot: cwd, mode: "sandbox" as const, profile: "default" as const, requestedProfile: "default" as const, grants: emptyGrants(), requestedGrants: emptyGrants(), authorityPath: "fixture" };
    const prepare = async function(this: { owner: symbol }) { expect(this.owner).toBe(owner); return policy; };
    try {
        publishShellRuntime(owner, () => policy, dedicated ? undefined : prepare, () => policy, dedicated ? prepare : undefined);
        expect(await resolveForcedSandboxPolicyForExecution(cwd)).toBe(policy);
    } finally {
        releaseShellRuntime(owner);
        if (previous === undefined) Reflect.deleteProperty(globalThis, key); else Reflect.set(globalThis, key, previous);
    }
});
