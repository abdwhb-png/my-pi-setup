import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as boundary from "./index.ts";
import { SUBAGENT_ASYNC_COMPLETE_EVENT, SUBAGENT_RPC_REPLY_EVENT_PREFIX, SUBAGENT_RPC_REQUEST_EVENT } from "./rpc-client.ts";

test.each([
    { state: "paused", flag: "interrupted", expected: "interrupted" },
    { state: "stopped", flag: "stopped", expected: "cancelled" },
])("child outcome parity for $state across live events, raw payload and native slim replay", async ({ state, flag, expected }) => {
    const nativeRoot = import.meta.resolve("pi-subagents");
    const { toWaitCompletion } = await import(new URL("./src/runs/background/wait-completions.js", nativeRoot).href);
    const { writeCompletionReplay } = await import(new URL("./src/runs/background/completion-replay.js", nativeRoot).href);
    const root = mkdtempSync(join(tmpdir(), "subagent-outcome-parity-"));
    const runDir = join(root, "async-subagent-runs", "child-1"), resultsDir = join(root, "async-subagent-results");
    mkdirSync(runDir, { recursive: true }); mkdirSync(resultsDir);
    const raw = { runId: "child-1", sessionId: "session-1", state, success: false, results: [{ agent: "reader", runId: "step-1", success: false, [flag]: true }] };
    const clients: boundary.SubagentIntegration[] = [];
    try {
        writeFileSync(join(runDir, "status.json"), JSON.stringify({ runId: "child-1", sessionId: "session-1", state, steps: [{ runId: "step-1", agent: "reader", status: state }] }));
        const liveBus = fixture(false).bus;
        const live = new boundary.SubagentIntegration(liveBus, { artifactRoot: root }); clients.push(live);
        const ref = await live.start({ agent: "reader", task: "Inspect" });
        liveBus.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { ...raw, id: ref.runId, results: [{ ...raw.results[0], status: state }] });
        const event = await live.wait(ref);
        expect(event).toMatchObject({ status: expected, steps: [{ status: expected }] });
        const payloadPath = join(resultsDir, "child-1.json");
        writeFileSync(payloadPath, JSON.stringify(raw));
        const payload = new boundary.SubagentIntegration(fixture(false).bus, { artifactRoot: root }); clients.push(payload);
        expect(await payload.wait(ref)).toEqual(event);
        rmSync(payloadPath);
        writeCompletionReplay({ resultsDir, runId: ref.runId, sessionId: ref.sessionId, data: raw, completion: toWaitCompletion(raw, ref.runId), now: Date.now(), ttlMs: 10000 });
        const replay = new boundary.SubagentIntegration(fixture(false).bus, { artifactRoot: root }); clients.push(replay);
        expect(await replay.wait(ref)).toEqual(event);
    } finally { for (const client of clients) client.dispose(); rmSync(root, { recursive: true, force: true }); }
});

function fixture(autoComplete = true, statusResult?: object) {
    const handlers = new Map<string, Set<(data: unknown) => void>>();
    const methods: string[] = [];
    const requests: unknown[] = [];
    const bus = {
        on(event: string, handler: (data: unknown) => void) {
            const listeners = handlers.get(event) ?? new Set();
            handlers.set(event, listeners);
            listeners.add(handler);
            return () => listeners.delete(handler);
        },
        emit(event: string, data: unknown) {
            for (const handler of handlers.get(event) ?? []) handler(data);
        },
    };
    bus.on(SUBAGENT_RPC_REQUEST_EVENT, (value) => {
        const request = value as { requestId: string; method: string };
        methods.push(request.method);
        requests.push(value);
        if (autoComplete && request.method === "spawn") bus.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
            id: "child-1", sessionId: "session-1", success: true, summary: "Inspection completed",
            results: [{ agent: "reader", status: "completed", structuredOutput: { proof: true } }],
        });
        bus.emit(`${SUBAGENT_RPC_REPLY_EVENT_PREFIX}${request.requestId}`, {
            version: 1, ...request, success: true,
            data: request.method === "ping" ? { session: { sessionId: "session-1" } } : request.method === "status" ? statusResult ?? { asyncSnapshot: { version: 1, kind: "pi-subagents.async-status-snapshot", runs: [{ id: "child-1", state: "running" }] } } : { details: { asyncId: request.method === "resume" ? "child-2" : "child-1" } },
        });
    });
    return { bus, methods, requests, handlers };
}

test("foreground and status-only consumers do not observe or replay unrelated async results", async () => {
    const { bus, handlers } = fixture(false, { asyncSnapshot: { version: 1, kind: "pi-subagents.async-status-snapshot", runs: [], omitted: { runs: 0, children: 0, byteLimitExceeded: false } } });
    const consumers = Array.from({ length: 3 }, () => new boundary.SubagentIntegration(bus));
    try {
        await consumers[1]!.activeRuns();
        expect(handlers.get(SUBAGENT_ASYNC_COMPLETE_EVENT)?.size ?? 0).toBe(0);
        bus.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { id: "foreign", sessionId: "session-1", success: true, results: [{ success: true, output: "large".repeat(40000) }] });
        const replay: unknown[] = [];
        consumers[0]!.subscribe(event => replay.push(event), { runId: "foreign", sessionId: "session-1" });
        expect(replay).toEqual([]);
    } finally { for (const consumer of consumers) consumer.dispose(); }
});

test("unrelated completions cannot evict an owned early terminal from bounded replay", async () => {
    const { bus, methods } = fixture();
    const integration = new boundary.SubagentIntegration(bus);
    try {
        const ref = await integration.start({ agent: "reader", task: "Inspect" });
        for (let index = 0; index < 129; index++) bus.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { id: `foreign-${index}`, sessionId: ref.sessionId, success: true, results: [] });
        expect(await integration.wait(ref, { timeoutMs: 20 })).toMatchObject({ status: "completed" });
        expect(methods).not.toContain("status");
    } finally { integration.dispose(); }
});

test("concurrent waits share recovery and preserve independent abort and timeout", async () => {
    const { bus, methods } = fixture(false);
    const integration = new boundary.SubagentIntegration(bus);
    const ref = { runId: "child-1", sessionId: "session-1" };
    const aborted = new AbortController();
    const pending: Promise<unknown>[] = [];
    try {
        const first = integration.wait(ref, { signal: aborted.signal }).catch(error => error.code);
        const timed = integration.wait(ref, { timeoutMs: 20 }).catch(error => error.code);
        const remaining = [integration.wait(ref), integration.wait(ref)];
        pending.push(first, timed, ...remaining);
        await Bun.sleep(0);
        expect(methods.filter(method => method === "status")).toHaveLength(1);
        aborted.abort();
        expect(await first).toBe("aborted");
        expect(await timed).toBe("timeout");
        bus.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { id: ref.runId, sessionId: ref.sessionId, success: true, results: [] });
        expect(await Promise.all(remaining)).toMatchObject([{ status: "completed" }, { status: "completed" }]);
        await Bun.sleep(280);
        expect(methods.filter(method => method === "status")).toHaveLength(1);
        expect(methods).not.toContain("stop");
    } finally { integration.dispose(); await Promise.allSettled(pending); }
});

test("common boundary retains an early terminal, deduplicates it and rejects foreign control", async () => {
    expect(boundary).toHaveProperty("SubagentIntegration");
    const { bus, methods } = fixture();
    const integration = new boundary.SubagentIntegration(bus, { sourceExtension: "fixture" });
    const events: unknown[] = [];
    integration.subscribe((event) => events.push(event));
    const ref = await integration.start({ agent: "reader", task: "Inspect", cwd: "/fixture", context: "fresh", result: { kind: "structured", schema: { type: "object" } } });
    expect(ref).toMatchObject({ runId: "child-1", sessionId: "session-1" });
    expect(await integration.wait(ref)).toMatchObject({ runId: "child-1", status: "completed", steps: [{ value: { kind: "structured", value: { proof: true } } }] });
    expect(await integration.wait(ref)).not.toHaveProperty("error");
    bus.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { id: "child-1", sessionId: "session-1", success: true, results: [] });
    expect(events.filter((event: any) => event.kind === "terminal")).toHaveLength(1);
    await expect(integration.control({ ...ref, sessionId: "foreign" }, { kind: "stop" })).rejects.toThrow("session");
    expect(methods).not.toContain("stop");
    integration.dispose();
});

test("resume delegates the persisted contract to the engine and retains lineage", async () => {
    const { bus, requests } = fixture();
    const integration = new boundary.SubagentIntegration(bus);
    const original = await integration.start({ agent: "reader", task: "Inspect", model: "fixture/original" });
    const resumed = await integration.resume(original, "Continue");
    expect(resumed).toEqual({ runId: "child-2", sessionId: original.sessionId, resumedFrom: original.runId });
    expect(requests.find((value: any) => value.method === "resume")).toMatchObject({ params: { id: "child-1", message: "Continue" } });
    expect((requests.find((value: any) => value.method === "resume") as any).params).not.toHaveProperty("model");
    const controller = new AbortController();
    controller.abort();
    await expect(integration.wait(resumed, { signal: controller.signal })).rejects.toMatchObject({ code: "aborted" });
    integration.dispose();
});

test("a native paused attempt remains interrupted at both run and child boundaries", async () => {
    const { bus } = fixture(false);
    const integration = new boundary.SubagentIntegration(bus);
    const ref = await integration.start({ agent: "reader", task: "Inspect" });
    bus.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { id: ref.runId, sessionId: ref.sessionId, state: "paused", success: false, results: [{ status: "paused", success: false }] });
    expect(await integration.wait(ref)).toMatchObject({ status: "interrupted", steps: [{ status: "interrupted" }] });
    integration.dispose();
});

test("inspection and waiting recover an owned terminal after reload without replaying execution", async () => {
    const root = mkdtempSync(join(tmpdir(), "subagent-terminal-"));
    const runDir = join(root, "async-subagent-runs", "child-1");
    const replayDir = join(root, "async-subagent-results", "completion-replay");
    mkdirSync(runDir, { recursive: true }); mkdirSync(replayDir, { recursive: true });
    const snapshot = { version: 1, kind: "pi-subagents.async-status-snapshot", runs: [] };
    const { bus, methods } = fixture(false, { asyncSnapshot: snapshot });
    const integration = new boundary.SubagentIntegration(bus, { artifactRoot: root });
    const ref = await integration.reference("child-1");
    try {
        writeFileSync(join(runDir, "status.json"), JSON.stringify({ runId: ref.runId, sessionId: ref.sessionId, state: "complete" }));
        writeFileSync(join(runDir, "workflow-receipt.json"), JSON.stringify({ version: 1, workflowRunId: ref.runId, entries: { first: { latestRunId: "step-1" } } }));
        const replay = { version: 1, runId: ref.runId, sessionId: ref.sessionId, completedAt: Date.now(), expiresAt: Date.now() + 10000, completion: { runId: ref.runId, success: true, results: [{ runId: "step-1", success: true, structuredOutput: { proof: true } }] } };
        const replayPath = join(replayDir, "child-1.json");
        writeFileSync(replayPath, JSON.stringify(replay));
        expect(await integration.inspect(ref)).toMatchObject({ state: "completed", terminal: { steps: [{ key: "first", value: { kind: "structured", value: { proof: true } } }] } });
        expect(await integration.wait(ref, { timeoutMs: 50 })).toMatchObject({ status: "completed" });
        expect(methods).not.toContain("spawn");
        integration.dispose();
        const foreign = new boundary.SubagentIntegration(bus, { artifactRoot: root });
        writeFileSync(replayPath, JSON.stringify({ ...replay, sessionId: "foreign" }));
        await expect(foreign.inspect(ref)).rejects.toThrow("session");
        foreign.dispose();
        rmSync(replayPath);
        const outside = join(root, "outside.json"); writeFileSync(outside, JSON.stringify(replay)); symlinkSync(outside, replayPath);
        const symlink = new boundary.SubagentIntegration(bus, { artifactRoot: root });
        await expect(symlink.inspect(ref)).rejects.toThrow("symbolic");
        symlink.dispose();
    } finally { integration.dispose(); rmSync(root, { recursive: true, force: true }); }
});

test("wait timeout releases observation without stopping the child and control acknowledgements are not terminals", async () => {
    const { bus, methods } = fixture(false);
    const integration = new boundary.SubagentIntegration(bus);
    const ref = await integration.start({ agent: "reader", task: "Inspect" });
    await expect(integration.wait(ref, { timeoutMs: 5 })).rejects.toMatchObject({ code: "timeout" });
    expect(methods).not.toContain("stop");
    expect(await integration.control(ref, { kind: "stop" })).toEqual({ acknowledged: true });
    await expect(integration.wait(ref, { timeoutMs: 5 })).rejects.toMatchObject({ code: "timeout" });
    const pending = integration.wait(ref);
    await Bun.sleep(0);
    integration.dispose();
    await expect(pending).rejects.toMatchObject({ code: "disposed" });
});

test("foreground progress preserves known usage and child identity without inventing unknown usage", async () => {
    const { bus } = fixture(false);
    const integration = new boundary.SubagentIntegration(bus);
    const updates: unknown[] = [];
    const request = { requestId: "request", ownerRunId: "owner", nodeId: "node", agent: "reader", task: "Inspect", cwd: "/fixture", context: "fresh" as const, result: { kind: "text" as const } };
    const pending = integration.run(request, { onUpdate: event => updates.push(event) });
    const identity = { requestId: "request", ownerRunId: "owner", nodeId: "node" };
    bus.emit("prompt-template:subagent:update", { ...identity, runId: "child", usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, turns: 1 } });
    bus.emit("prompt-template:subagent:update", { ...identity, runId: "child" });
    bus.emit("prompt-template:subagent:response", { ...identity, status: "completed", result: { kind: "text", text: "done" } });
    await pending;
    expect(updates).toEqual([
        { ...identity, runId: "child", usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, turns: 1 } },
        { ...identity, runId: "child" },
    ]);
    integration.dispose();
});

test("declarative stages pass structured outputs and stop after a failed stage", async () => {
    expect(boundary).toHaveProperty("compileWorkflow");
    const script = boundary.compileWorkflow({ stages: [
        [{ key: "first", agent: "reader", task: "Inspect" }, { key: "second", agent: "reader", task: "Inspect" }],
        [{ key: "advisory", agent: "advisor", task: "Assess {outputs.first}" }],
    ] });
    const launched: unknown[] = [];
    const runs = { async all(items: any[]) {
        launched.push(items);
        return items.map((item) => ({ ok: true, structuredOutput: { from: item.key } }));
    } };
    const execute = new Function("runs", `return (async () => {${script}})()`);
    await execute(runs);
    expect(launched).toHaveLength(2);
    expect((launched[1] as any[])[0].task).toBe('Assess {"from":"first"}');
    launched.length = 0;
    await execute({ all: async (items: any[]) => { launched.push(items); return [{ ok: false }, { ok: true }]; } });
    expect(launched).toHaveLength(1);
    expect(() => boundary.compileWorkflow({ stages: [[{ key: "x", agent: "reader", task: "{outputs.missing}" }]] })).toThrow("missing");
});

test("child failures override a successful workflow envelope and unknown accounting stays absent", async () => {
    const { bus } = fixture(false);
    const integration = new boundary.SubagentIntegration(bus);
    const ref = await integration.start({ agent: "reader", task: "Inspect" });
    bus.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { id: ref.runId, sessionId: ref.sessionId, success: true, results: [
        { runId: "step-1", workflowKey: "first", success: false, status: "structured_output_failed", error: "Missing structured output" },
        { runId: "step-2", workflowKey: "second", success: true, usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 }, structuredOutput: { proof: true } },
    ] });
    const completion = await integration.wait(ref);
    expect(completion.status).toBe("failed");
    expect(completion.steps[0]).toMatchObject({ runId: "step-1", status: "structured_output_failed" });
    expect(completion.steps[0]).not.toHaveProperty("usage");
    expect(completion.steps[1]?.usage).toMatchObject({ input: 2, output: 3, cost: 0 });
    integration.dispose();
});

test("a missing structured output is an explicit dependency error", async () => {
    const script = boundary.compileWorkflow({ stages: [[{ key: "first", agent: "reader", task: "Inspect" }], [{ key: "next", agent: "advisor", task: "Assess {outputs.first}" }]] });
    let calls = 0;
    const execute = new Function("runs", `return (async () => {${script}})()`);
    await expect(execute({ all: async () => { calls++; return [{ ok: true }]; } })).rejects.toThrow("structured output");
    expect(calls).toBe(1);
});

test("a malformed correlated completion is diagnostic evidence and rejects waiting", async () => {
    const { bus } = fixture(false);
    const integration = new boundary.SubagentIntegration(bus);
    const events: unknown[] = [];
    integration.subscribe(event => events.push(event));
    const ref = await integration.start({ agent: "reader", task: "Inspect" });
    bus.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { id: ref.runId, sessionId: ref.sessionId, success: true, results: "broken" });
    await expect(integration.wait(ref, { timeoutMs: 20 })).rejects.toMatchObject({ code: "invalid_completion" });
    expect(events).toMatchObject([{ kind: "diagnostic", runId: ref.runId, sessionId: ref.sessionId }]);
    const replayed: unknown[] = [];
    integration.subscribe(event => replayed.push(event), ref);
    expect(replayed).toMatchObject([{ kind: "diagnostic", runId: ref.runId, sessionId: ref.sessionId }]);
    integration.dispose();
});

test("recovered results hydrate only the bounded output references published by the owned engine", async () => {
    const root = mkdtempSync(join(tmpdir(), "subagent-output-references-"));
    const artifactRoot = join(root, "runs"), outputDir = join(root, "outputs");
    const replayDir = join(artifactRoot, "async-subagent-results", "completion-replay");
    mkdirSync(replayDir, { recursive: true }); mkdirSync(outputDir);
    const { bus } = fixture(false, { asyncSnapshot: { version: 1, kind: "pi-subagents.async-status-snapshot", runs: [] } });
    const integration = new boundary.SubagentIntegration(bus, { artifactRoot });
    const ref = await integration.reference("child-1");
    try {
        const structured = join(outputDir, "structured.json");
        writeFileSync(structured, JSON.stringify({ proof: "large retained value" }));
        const output = join(outputDir, "output.txt"); writeFileSync(output, "retained text");
        const archiveDir = join(artifactRoot, "async-subagent-results", "output-archives"); mkdirSync(archiveDir);
        writeFileSync(join(archiveDir, "child-1.json"), JSON.stringify({ version: 1, runId: ref.runId, entries: [{ resultIndex: 1, source: "output-artifact", path: output }] }));
        writeFileSync(join(replayDir, "child-1.json"), JSON.stringify({ version: 1, runId: ref.runId, sessionId: ref.sessionId, expiresAt: Date.now() + 10000, completion: { runId: ref.runId, success: true, results: [{ success: true, structuredOutputPath: structured }, { success: true }] } }));
        expect((await integration.wait(ref, { timeoutMs: 100 })).steps).toMatchObject([{ value: { kind: "structured", value: { proof: "large retained value" } } }, { value: { kind: "text", text: "retained text" } }]);
    } finally { integration.dispose(); rmSync(root, { recursive: true, force: true }); }
});


test("workflow launches use the native RPC script contract", async () => {
    const { bus, requests } = fixture();
    const integration = new boundary.SubagentIntegration(bus);
    try {
        const request = { cwd: process.cwd(), stages: [[{ key: "inspect", agent: "reader", task: "Inspect" }]] };
        await integration.start(request);
        const spawn = requests.find((value: any) => value.method === "spawn") as { params: Record<string, unknown> };
        expect(spawn.params.script).toBe(boundary.compileWorkflow(request));
        expect(spawn.params).not.toHaveProperty("workflowScript");
    } finally { integration.dispose(); }
});

test('public preflight forwards the live native MCP host', async () => {
    const root = mkdtempSync(join(tmpdir(), 'subagent-host-preflight-'));
    const previous = process.env.PI_CODING_AGENT_DIR;
    const client = new boundary.SubagentIntegration(fixture().bus);
    try {
        const agentDir = join(root,'agent'), pkg = join(root,'package');
        mkdirSync(agentDir); mkdirSync(pkg);
        process.env.PI_CODING_AGENT_DIR = agentDir;
        writeFileSync(join(agentDir,'settings.json'), JSON.stringify({packages:[pkg]}));
        writeFileSync(join(pkg,'package.json'), JSON.stringify({name:'pi-subagents',exports:{'./preflight':'./preflight.ts'}}));
        writeFileSync(join(pkg,'preflight.ts'), 'export function resolveSubagentLaunchContract(input) { return {ok:true, tools:input.runtimeSnapshotHost?.getAllTools().map(t=>t.name)}; }');
        const runtimeSnapshotHost = {events:fixture().bus, getAllTools: () => [{name:'mcp__docs__search'}],getCommands: () => []};
        expect(await client.preflight({agent:'reader',task:'inspect',cwd:root}, {runtimeSnapshotHost})).toMatchObject({tools:['mcp__docs__search']});
    } finally {
        client.dispose();
        if(previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
        rmSync(root,{recursive:true,force:true});
    }
});
