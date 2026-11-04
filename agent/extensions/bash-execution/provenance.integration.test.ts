import { tmpdir } from "node:os";
import { emptyGrants, publishShellRuntime, releaseShellRuntime } from '../_shared/shell-runtime/index.ts';
import { afterEach, beforeEach, expect, test } from "bun:test";
import { calls, createTestSession, says, when } from "@abdwhb-png/pi-test-harness";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { claimSandboxRuntime, publishSandboxRuntime, releaseSandboxRuntime } from "../_shared/sandbox-runtime/index.ts";
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let isolatedAgentDir: string;
beforeEach(async () => {
    isolatedAgentDir = await mkdtemp(resolve(tmpdir(), "bash-provenance-agent-"));
    process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;
});
afterEach(async () => {
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    await rm(isolatedAgentDir, { recursive: true, force: true });
});
test("real Pi persists host execution provenance and exposes it to the model on success and failure", async () => {
    const cwd = await mkdtemp(resolve(import.meta.dir, ".provenance-"));
    await mkdir(resolve(isolatedAgentDir, "config"));
    await writeFile(resolve(isolatedAgentDir, "config/bash-execution.json"), JSON.stringify({ safeBash: { mode: "coexist" } }));
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

test("real Pi keeps native manual execution separate from agent Sandbox tools", async () => {
    const cwd = await mkdtemp(resolve(tmpdir(), "manual-shell-contract-"));
    const owner = Symbol("manual-shell-contract");
    claimSandboxRuntime(owner);
    let sandboxDispatches = 0;
    publishSandboxRuntime(owner, {
        state: "enabled",
        createBashOperations: options => ({ exec: async (command, _cwd, executionOptions) => {
            sandboxDispatches++;
            options.onExecution?.({ status: "sandboxed", mode: "sandbox", profile: "bash-general", backend: "zerobox", tmpNamespace: "host", phase: "process", outcome: "succeeded", exitCode: 0 });
            executionOptions.onData(Buffer.from(`sandbox:${command}`));
            return { exitCode: 0 };
        } }),
        createThinkBashOperations: () => ({ exec: async () => ({ exitCode: 0 }) }),
        analysis: { state: "retrying" },
    });
    publishShellRuntime(owner, () => ({ state: "ready", projectRoot: cwd, mode: "sandbox", requestedMode: "sandbox", profile: "default", requestedProfile: "default", grants: emptyGrants(), requestedGrants: emptyGrants(), authorityPath: "/unused" }));
    const session = await createTestSession({ cwd, extensions: [resolve(import.meta.dir, "index.ts")] });
    session.session.settingsManager.setShellPath("/bin/bash");
    session.session.settingsManager.setShellCommandPrefix("s() { printf '%s' \"$*\"; }; export MANUAL_PREFIX=prefix");
    try {
        for (const [command, excludeFromContext, output] of [
            ["printf visible-manual", false, "visible-manual"],
            ["printf excluded-manual", true, "excluded-manual"],
            ["s literal-prefix", false, "literal-prefix"],
            ["printf '%s' \"$MANUAL_PREFIX\"", false, "prefix"],
        ] as const) {
            const event = await session.session.extensionRunner.emitUserBash({ type: "user_bash", command, cwd, excludeFromContext });
            const result = await session.session.executeBash(command, undefined, { operations: event?.operations, excludeFromContext });
            expect(result.output).toBe(output);
        }
        expect(sandboxDispatches).toBe(0);
        const running = session.run(when("Run agent commands", [calls("bash", { command: "printf agent" }), calls("safe_bash", { command: "printf agent-safe" }), says("done")]));
        const inputs: string[] = [];
        const original = session.session.agent.streamFunction;
        session.session.agent.streamFunction = (model, context, options) => { inputs.push(JSON.stringify(context.messages)); return original(model, context, options); };
        await running;
        expect(sandboxDispatches).toBe(2);
        expect(inputs.join("")).toContain("visible-manual");
        expect(inputs.join("")).not.toContain("excluded-manual");
        for (const result of session.events.toolResults) expect(result.details).toMatchObject({ execution: { status: "sandboxed", backend: "zerobox" } });
        const receipts = session.session.sessionManager.getBranch().filter(entry => entry.type === "custom" && entry.customType === "pi.execution.user-bash.v1");
        expect(receipts).toHaveLength(4);
        for (const receipt of receipts) expect(receipt).toMatchObject({ data: { execution: { mode: "host", status: "unsandboxed", exitCode: 0 } } });
    } finally {
        await session.close();
        releaseSandboxRuntime(owner);
        releaseShellRuntime(owner);
        await rm(cwd, { recursive: true, force: true });
    }
}, 30_000);
