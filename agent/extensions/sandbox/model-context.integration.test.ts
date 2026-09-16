import type { Context } from "@earendil-works/pi-ai";
import { expect, test } from "bun:test";
import { calls, createTestSession, says, when } from "@abdwhb-png/pi-test-harness";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolPresentation } from "../_shared/tool-policy/presentation.ts";
import bashExecution from "../bash-execution/index.ts";
import { registerProviderCatalogFinalizer } from "../pi-overrides/provider-catalog-finalizer.ts";
import { claimSandboxRuntime, publishSandboxRuntime, releaseSandboxRuntime } from "../_shared/sandbox-runtime/index.ts";
import { createSandboxExecutionContext } from "../_shared/sandbox-runtime/execution-context.ts";
import { SHELL_CONTEXT_TYPE } from "../_shared/shell-presentation/context.ts";
import { publishShellRuntime, releaseShellRuntime } from "./capabilities/runtime.ts";
import { loadSandboxConfig } from "./index.ts";
import { registerSandboxModelContext } from "./model-context.ts";
import { createBashPolicy, createThinkPolicy, createAnalysisPolicy } from "./runtime/policies.ts";

function fixture() {
    const root = mkdtempSync(join(tmpdir(), "pi-model-context-"));
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    mkdirSync(agentDir);
    writeFileSync(join(cwd, ".pi/settings.json"), JSON.stringify({ safeBash: { mode: "coexist", telemetry: { enabled: false } } }));
    const globalPath = join(agentDir, "sandbox.json");
    const writeGlobal = (allowedDomains: string[] = []) => writeFileSync(globalPath, JSON.stringify({ version: 2, machineId: "fixture", host: { allowed: true }, network: { allowedDomains } }), { mode: 0o600 });
    writeGlobal();
    const sessionPolicy: { mode: "sandbox" | "host" } = { mode: "sandbox" };
    const load = () => loadSandboxConfig(cwd, { agentDir, machineId: "fixture", session: sessionPolicy });
    const owner = Symbol("context-backend");
    let preparations = 0;
    const lease = { root: join(root, "runtime", "lease"), homeDir: join(root, "home"), tmpDir: join(root, "tmp"), zeroboxHome: join(root, "zerobox"), proxyRunsDir: join(root, "proxy"), profilesDir: join(root, "profiles") };
    const admit = () => {
        const resolved = load();
        const input = { cwd, lease, config: resolved.config, hostEnv: {} };
        const contextOptions = { homeDir: root };
        const contexts = {
            "bash-general": createSandboxExecutionContext(createBashPolicy(input), lease, contextOptions),
            "think-strict": createSandboxExecutionContext(createThinkPolicy(input), lease, contextOptions),
            "analysis-strict": createSandboxExecutionContext(createAnalysisPolicy({ cwd, lease, readablePaths: [] }), lease, contextOptions),
        };
        // Substitute only the process backend. Keep policy resolution, admission and Pi's tool pipeline real.
        publishSandboxRuntime(owner, { state: "enabled", sandboxFingerprint: resolved.shell.sandboxFingerprint, contexts,
            createBashOperations: () => ({ exec: async (_command, _cwd, options) => { options.onData(Buffer.from("fixture process\n")); return { exitCode: 0 }; } }),
            createThinkBashOperations: () => ({ exec: async () => { throw new Error("Unexpected Think execution"); } }),
            analysis: { state: "retrying" },
        });
    };
    claimSandboxRuntime(owner);
    admit();
    publishShellRuntime(owner, () => load().shell, async () => { preparations++; admit(); });
    return { cwd, globalPath, writeGlobal, owner, sessionPolicy, admit, preparations: () => preparations,
        dispose: () => { releaseShellRuntime(owner); releaseSandboxRuntime(owner); rmSync(root, { recursive: true, force: true }); },
    };
}

async function requestSystem(session: Awaited<ReturnType<typeof createTestSession>>, context: Context): Promise<string> {
    const input = structuredClone(context.messages);
    const payload = await session.session.extensionRunner!.emitBeforeProviderRequest({ instructions: context.systemPrompt, input });
    expect(payload).toMatchObject({ input });
    if (!payload || typeof payload !== "object" || !("instructions" in payload) || typeof payload.instructions !== "string")
        throw new Error("Missing system instructions in fixture provider request");
    return payload.instructions;
}

test.each(["openai-responses", "openai-completions"] as const)("%s sends sandbox facts only in the temporary system prompt, never as a user message", async api => {
    const f = fixture();
    const session = await createTestSession({ cwd: f.cwd, extensionFactories: [bashExecution, registerSandboxModelContext] });
    try {
        const model = session.session.model;
        if (!model) throw new Error("Missing fixture model");
        await session.session.setModel({ ...model, api });
        const requests: Array<{ payload: unknown; input: Context["messages"]; messages: string; system: string }> = [];
        const running = session.run(when("Continue the requested work", [says("done")]));
        const original = session.session.agent.streamFunction;
        session.session.agent.streamFunction = async (model, context, options) => {
            const input = structuredClone(context.messages);
            const payload = await session.session.extensionRunner!.emitBeforeProviderRequest(api === "openai-responses"
                ? { instructions: context.systemPrompt, input }
                : { messages: [{ role: "system", content: context.systemPrompt }, ...input] });
            requests.push({ payload, input, messages: JSON.stringify(context.messages), system: context.systemPrompt ?? "" });
            return original(model, context, options);
        };
        await running;
        expect(requests).toHaveLength(1);
        expect(requests[0]!.messages).not.toContain("Current shell execution context");
        if (api === "openai-responses") {
            expect(requests[0]!.payload).toMatchObject({ input: requests[0]!.input });
            expect(requests[0]!.payload).toHaveProperty("instructions", expect.stringContaining("Current shell execution context"));
        } else {
            expect(requests[0]!.payload).toHaveProperty("messages", [
                { role: "system", content: expect.stringContaining("Current shell execution context") },
                ...requests[0]!.input,
            ]);
        }
        expect(requests[0]!.system).not.toContain("Current shell execution context");
        expect(JSON.stringify(session.session.sessionManager.getBranch())).not.toContain("Current shell execution context");
        expect(f.preparations()).toBe(0);
    } finally { session.dispose(); f.dispose(); }
});

test.each(["standard", "custom"] as const)("refreshes one ephemeral context within a %s-prompt turn without preparing early", async prompt => {
    const f = fixture();
    const session = await createTestSession({ cwd: f.cwd,
        ...(prompt === "custom" ? { systemPrompt: "Fixture custom prompt." } : {}),
        extensionFactories: [bashExecution, registerSandboxModelContext, registerProviderCatalogFinalizer],
        mockTools: { read: () => { f.writeGlobal(["example.test"]); return "configuration changed"; } },
    });
    try {
        const contexts: string[] = [];
        const systems: string[] = [];
        const preparations: number[] = [];
        const running = session.run(when("Inspect and run", [calls("read", { path: "fixture" }), calls("bash", { command: "printf test" }), says("done")]));
        const original = session.session.agent.streamFunction;
        session.session.agent.streamFunction = async (model, context, options) => {
            contexts.push(await requestSystem(session, context));
            systems.push(context.systemPrompt ?? "");
            preparations.push(f.preparations());
            return original(model, context, options);
        };
        await running;
        expect(contexts).toHaveLength(3);
        expect(contexts[0]).toContain('"availability":"ready"');
        expect(contexts[0]).toContain('"admission":"pending"');
        expect(contexts[0]).not.toContain('"effective":');
        expect(contexts[1]).toContain('"availability":"pending"');
        expect(contexts[1]).not.toContain("example.test");
        expect(contexts[2]).toContain('"availability":"ready"');
        expect(contexts[2]).toContain("example.test");
        expect(preparations).toEqual([0, 0, 1]);
        for (const context of contexts) expect(context.match(/Current shell execution context/g)).toHaveLength(1);
        for (const system of systems) expect(system).not.toContain("Sandbox execution context v1");
        expect(contexts[0]).toContain("Tool availability=coexist");
        expect(session.session.sessionManager.getBranch().some(entry => entry.type === "message" && entry.message.role === "custom" && entry.message.customType === SHELL_CONTEXT_TYPE)).toBe(false);
        expect(session.session.sessionManager.getBranch().some(entry => entry.type === "custom_message" && entry.customType === SHELL_CONTEXT_TYPE)).toBe(false);

        // Exercise the real provider hook; the playbook itself never sends an HTTP request.
        const tools = session.session.getAllTools().filter(tool => tool.name === "bash" || tool.name === "safe_bash").map(tool => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.parameters }));
        expect(toolPresentation([{ name: "bash" }])).toContain("When a command targets another execution environment, resolve its executable paths and variables in that environment.");
        const payload = await session.session.extensionRunner!.emitBeforeProviderRequest({ instructions: systems.at(-1), input: [], tools, tool_choice: "auto" });
        const wire = JSON.stringify(payload);
        expect(wire).toContain("When a command targets another execution environment");
        expect(wire.match(/When a command targets another execution environment/g)).toHaveLength(1);
        expect(wire).not.toContain("PI_*");
    } finally { session.dispose(); f.dispose(); }
});

test("refreshes an explicit mode selection between model calls in the same request", async () => {
    const f = fixture();
    const session = await createTestSession({
        cwd: f.cwd,
        extensionFactories: [bashExecution, registerSandboxModelContext],
        mockTools: { read: () => { f.sessionPolicy.mode = "host"; return "fixture user selected host"; } },
    });
    try {
        const inputs: string[] = [];
        const running = session.run(when("Observe a user mode selection", [calls("read", { path: "fixture" }), says("done")]));
        const original = session.session.agent.streamFunction;
        session.session.agent.streamFunction = async (model, context, options) => { inputs.push(await requestSystem(session, context)); return original(model, context, options); };
        await running;
        expect(inputs).toHaveLength(2);
        expect(inputs[0]).toContain('"mode":"sandbox"');
        expect(inputs[1]).toContain('"mode":"host"');
        expect(inputs[1]).not.toContain('"effective"');
        expect(inputs[1]).toContain("think-strict");
        expect(inputs[1].match(/Current shell execution context/g)).toHaveLength(1);
        expect(f.preparations()).toBe(0);
    } finally { session.dispose(); f.dispose(); }
});

test("reports host, invalid config and runtime transitions without activating anything", async () => {
    const f = fixture();
    const session = await createTestSession({ cwd: f.cwd, extensionFactories: [registerSandboxModelContext, bashExecution] });
    try {
        const contexts: string[] = [];
        const observe = async (prompt: string) => {
            const running = session.run(when(prompt, [says("done")]));
            const original = session.session.agent.streamFunction;
            session.session.agent.streamFunction = async (model, context, options) => { contexts.push(await requestSystem(session, context)); return original(model, context, options); };
            await running;
        };
        await observe("Observe");
        f.sessionPolicy.mode = "host";
        await observe("Observe host");
        expect(contexts.at(-1)).toContain("without shell OS isolation");
        expect(contexts.at(-1)).not.toContain('"effective"');
        expect(contexts.at(-1)).toContain("think-strict");
        f.sessionPolicy.mode = "sandbox";
        publishSandboxRuntime(f.owner, { state: "reconfiguring" });
        await observe("Observe replacement");
        expect(contexts.at(-1)).toContain('"availability":"reconfiguring"');
        publishSandboxRuntime(f.owner, { state: "error" });
        await observe("Observe failure");
        expect(contexts.at(-1)).toContain('"availability":"unavailable"');
        writeFileSync(f.globalPath, "{");
        await observe("Observe invalid config");
        expect(contexts.at(-1)).toContain("Invalid shell configuration");
        expect(f.preparations()).toBe(0);
        f.writeGlobal();
        f.admit();
        await session.session.reload();
        await observe("Observe after reload");
        expect(contexts.at(-1)).toContain('"availability":"ready"');
        expect(contexts.at(-1)?.match(/Current shell execution context/g)).toHaveLength(1);
        expect(contexts.at(-1)).not.toContain("Invalid shell configuration");
        expect(f.preparations()).toBe(0);
    } finally { session.dispose(); f.dispose(); }
});
