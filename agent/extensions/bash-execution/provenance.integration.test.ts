import { emptyGrants, publishShellRuntime, releaseShellRuntime } from '../_shared/shell-runtime/index.ts';
import { expect, test } from "bun:test";
import { calls, createTestSession, says, when } from "@abdwhb-png/pi-test-harness";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { claimSandboxRuntime, publishSandboxRuntime, releaseSandboxRuntime } from "../_shared/sandbox-runtime/index.ts";
test("real Pi persists host execution provenance and exposes it to the model on success and failure", async () => {
    const cwd = await mkdtemp(resolve(import.meta.dir, ".provenance-"));
    await mkdir(resolve(cwd, ".pi"));
    await writeFile(resolve(cwd, ".pi/settings.json"), JSON.stringify({ safeBash: { mode: "coexist" } }));
    const owner = Symbol("provenance-test");
    claimSandboxRuntime(owner);
    publishSandboxRuntime(owner, { state: "disabled" });
    publishShellRuntime(owner, () => ({ state: "ready", projectRoot: cwd, mode: "host", requestedMode: "host", requestedProfile: "host", profile: "host", grants: emptyGrants(), requestedGrants: emptyGrants(), authorityPath: "/unused" }));
    const session = await createTestSession({
        cwd, extensions: [resolve(import.meta.dir, "index.ts")],
    });
    try {
        const running = session.run(when("Run both commands", [
            calls("bash", { command: "printf first" }),
            calls("safe_bash", { command: "printf second >&2; exit 37" }),
            says("Finished"),
        ]));
        const modelInputs: string[] = [];
        const original = session.session.agent.streamFunction;
        session.session.agent.streamFunction = (model, context, options) => {
            modelInputs.push(JSON.stringify(context.messages));
            return original(model, context, options);
        };
        await running;
        const results = session.events.messages.filter(m => m.role === "toolResult");
        expect(results).toHaveLength(2);
        expect(results[0]?.content).toEqual([{ type: "text", text: "first" }]);
        for (const result of results) expect(result.details, result.toolName).toMatchObject({
            execution: { status: "unsandboxed", backend: "local", tmpNamespace: "host" },
        });
        expect(results[1]?.isError).toBe(true);
        expect(results[1]?.details).toMatchObject({ execution: { exitCode: 37, outcome: "failed" } });
        expect(modelInputs.at(-1)).toContain("Execution provenance:");
        expect(modelInputs.at(-1)).toContain("unsandboxed");
    } finally {
        session.dispose();
        releaseSandboxRuntime(owner);
        releaseShellRuntime(owner);
        await rm(cwd, { recursive: true, force: true });
    }
}, 30_000);

test("user bash persists process provenance without modifying its output", async () => {
    const cwd = await mkdtemp(resolve(import.meta.dir, '.user-provenance-'));
    const previousCwd = process.cwd();
    // Pi's user Bash executor uses the process cwd, as in the interactive CLI.
    process.chdir(cwd);
    const owner = Symbol('user-bash-test');
    claimSandboxRuntime(owner);
    publishSandboxRuntime(owner, { state: 'disabled' });
    publishShellRuntime(owner, () => ({ state: 'ready', projectRoot: cwd, mode: 'host', requestedMode: 'host', requestedProfile: 'host', profile: 'host', grants: emptyGrants(), requestedGrants: emptyGrants(), authorityPath: '/unused' }));
    const session = await createTestSession({ cwd, extensions: [resolve(import.meta.dir, 'index.ts')] });
    try {
        const command = "printf 'manager scripts/project' | sed 's/manager/handler/'";
        const event = await session.session.extensionRunner.emitUserBash({ type: 'user_bash', command, cwd, excludeFromContext: false });
        const result = await session.session.executeBash(command, undefined, { operations: event?.operations });
        expect(result.output).toBe('handler scripts/project');
        const receipts = session.session.sessionManager.getBranch().filter(entry => entry.type === 'custom' && entry.customType === 'pi.execution.user-bash.v1');
        expect(receipts).toHaveLength(1);
        expect(receipts[0]).toMatchObject({ data: { execution: { status: 'unsandboxed', exitCode: 0 } } });
        const running = session.run(when('Continue', [says('done')]));
        const inputs: string[] = [];
        const original = session.session.agent.streamFunction;
        session.session.agent.streamFunction = (model, context, options) => { inputs.push(JSON.stringify(context.messages)); return original(model, context, options); };
        await running;
        expect(inputs.join('')).toContain('Execution provenance:');
        expect(inputs.join('')).toContain('unsandboxed');
    } finally {
        session.dispose();
        releaseSandboxRuntime(owner);
        releaseShellRuntime(owner);
        process.chdir(previousCwd);
        await rm(cwd, { recursive: true, force: true });
    }
}, 30_000);

test("real Pi keeps !s sandboxed with a descriptive sandbox profile during host mode", async () => {
    const cwd = await mkdtemp(resolve(import.meta.dir, ".forced-sandbox-host-"));
    const previousCwd = process.cwd();
    process.chdir(cwd);
    const owner = Symbol("forced-sandbox-host");
    let sandboxDispatches = 0;
    claimSandboxRuntime(owner);
    publishSandboxRuntime(owner, {
        state: "enabled",
        createBashOperations: (options) => ({
            exec: async () => {
                sandboxDispatches += 1;
                options.onExecution?.({
                    status: "sandboxed",
                    profile: "bash-general",
                    backend: "zerobox",
                    tmpNamespace: "lease-private",
                    phase: "process",
                    outcome: "succeeded",
                    exitCode: 0,
                });
                return { exitCode: 0 };
            },
        }),
        createThinkBashOperations: () => ({ exec: async () => ({ exitCode: 0 }) }),
        analysis: { state: "retrying" },
    });
    const host = {
        state: "ready" as const,
        projectRoot: cwd,
        mode: "host" as const,
        requestedMode: "host" as const,
        profile: "host" as const,
        requestedProfile: "host" as const,
        grants: emptyGrants(), requestedGrants: emptyGrants(), authorityPath: "/unused",
    };
    const sandbox = {
        ...host,
        mode: "sandbox" as const,
        requestedMode: "sandbox" as const,
        profile: "default" as const,
        requestedProfile: "default" as const,
    };
    publishShellRuntime(owner, () => host, undefined, () => sandbox);
    const session = await createTestSession({ cwd, extensions: [resolve(import.meta.dir, "index.ts")] });
    try {
        const forced = "s printf forced";
        const forcedEvent = await session.session.extensionRunner.emitUserBash({ type: "user_bash", command: forced, cwd, excludeFromContext: false });
        await session.session.executeBash(forced, undefined, { operations: forcedEvent?.operations });
        expect(sandboxDispatches).toBe(1);
        const forcedReceipt = session.session.sessionManager
            .getBranch()
            .filter(
                (entry) =>
                    entry.type === "custom" &&
                    entry.customType === "pi.execution.user-bash.v1",
            )
            .at(-1);
        expect(forcedReceipt).toMatchObject({
            data: {
                execution: {
                    mode: "sandbox",
                    shellProfile: "default",
                    status: "sandboxed",
                    backend: "zerobox",
                },
            },
        });
        const ordinary = "printf host";
        const ordinaryEvent = await session.session.extensionRunner.emitUserBash({ type: "user_bash", command: ordinary, cwd, excludeFromContext: false });
        const ordinaryResult = await session.session.executeBash(ordinary, undefined, { operations: ordinaryEvent?.operations });
        expect(ordinaryResult.output).toBe("host");
        expect(sandboxDispatches).toBe(1);
    } finally {
        session.dispose(); releaseSandboxRuntime(owner); releaseShellRuntime(owner);
        process.chdir(previousCwd); await rm(cwd, { recursive: true, force: true });
    }
}, 30_000);

test("real Pi refreshes authority before admitting an explicit Sandbox user command", async () => {
    const cwd = await mkdtemp(resolve(import.meta.dir, ".user-sandbox-refresh-"));
    const owner = Symbol("user-bash-sandbox-refresh");
    claimSandboxRuntime(owner);
    let sandboxDispatches = 0;
    publishSandboxRuntime(owner, {
        state: "enabled",
        createBashOperations: () => {
            sandboxDispatches += 1;
            return { exec: async () => ({ exitCode: 0 }) };
        },
        createThinkBashOperations: () => ({
            exec: async () => ({ exitCode: 0 }),
        }),
        analysis: { state: "retrying" },
    });
    publishShellRuntime(
        owner,
        () => ({
            state: "ready" as const,
            projectRoot: cwd,
            mode: "sandbox" as const,
            requestedMode: "sandbox" as const,
            profile: "default" as const,
            requestedProfile: "default" as const,
            grants: emptyGrants(),
            requestedGrants: emptyGrants(),
            authorityPath: resolve(cwd, "sandbox.json"),
        }),
        async () => {
            throw new Error("invalid active sandbox config");
        },
    );
    const session = await createTestSession({
        cwd,
        extensions: [resolve(import.meta.dir, "index.ts")],
    });
    try {
        const command = "s printf should-not-run";
        const event = await session.session.extensionRunner.emitUserBash({
            type: "user_bash",
            command,
            cwd,
            excludeFromContext: false,
        });
        await expect(
            session.session.executeBash(command, undefined, {
                operations: event?.operations,
            }),
        ).rejects.toThrow("invalid active sandbox config");
        expect(sandboxDispatches).toBe(0);
    } finally {
        session.dispose();
        releaseSandboxRuntime(owner);
        releaseShellRuntime(owner);
        await rm(cwd, { recursive: true, force: true });
    }
}, 30_000);

test("real Pi blocks !s when preparation revokes its sandbox policy", async () => {
    const cwd = await mkdtemp(resolve(import.meta.dir, ".user-sandbox-revocation-"));
    const previousCwd = process.cwd();
    process.chdir(cwd);
    const owner = Symbol("user-bash-sandbox-revocation");
    claimSandboxRuntime(owner);
    let sandboxDispatches = 0;
    let revoked = false;
    publishSandboxRuntime(owner, {
        state: "enabled",
        createBashOperations: () => {
            sandboxDispatches += 1;
            return { exec: async () => ({ exitCode: 0 }) };
        },
        createThinkBashOperations: () => ({ exec: async () => ({ exitCode: 0 }) }),
        analysis: { state: "retrying" },
    });
    publishShellRuntime(
        owner,
        () => ({
            state: revoked ? "authorization-required" as const : "ready" as const,
            diagnostic: revoked ? "Sandbox policy was revoked" : undefined,
            projectRoot: cwd,
            mode: "sandbox" as const,
            requestedMode: "sandbox" as const,
            profile: "default" as const,
            requestedProfile: "default" as const,
            grants: emptyGrants(),
            requestedGrants: emptyGrants(),
            authorityPath: resolve(cwd, "sandbox.json"),
        }),
        async () => { revoked = true; },
    );
    const session = await createTestSession({
        cwd,
        extensions: [resolve(import.meta.dir, "index.ts")],
    });
    try {
        const command = "s printf revoked";
        const event = await session.session.extensionRunner.emitUserBash({
            type: "user_bash",
            command,
            cwd,
            excludeFromContext: false,
        });
        await expect(
            session.session.executeBash(command, undefined, {
                operations: event?.operations,
            }),
        ).rejects.toThrow("Sandbox policy was revoked");
        expect(sandboxDispatches).toBe(0);
    } finally {
        session.dispose();
        releaseSandboxRuntime(owner);
        releaseShellRuntime(owner);
        process.chdir(previousCwd);
        await rm(cwd, { recursive: true, force: true });
    }
}, 30_000);
