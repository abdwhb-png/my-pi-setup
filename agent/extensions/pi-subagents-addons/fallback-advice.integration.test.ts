import { getCurrentSystemPrompt } from "@earendil-works/pi-ai/utils/transcript";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { calls, createTestSession, says, when } from "@abdwhb-png/pi-test-harness";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { registerShellContext } from "../_shared/shell-presentation/context.ts";
import { findFailedModelAdvice, registerFallbackAdvice } from "./fallback-advice.ts";

test.each(["openai-responses", "openai-completions"] as const)("%s gives parent one request-local fallback hint and leaves Pi history clean", async api => {
    const root = mkdtempSync(join(tmpdir(), "pi-fallback-provider-"));
    const parentFile = join(root, "parent.jsonl");
    const sessionFile = join(root, "parent", "run-123", "run-0", "session.jsonl");
    mkdirSync(join(root, "parent", "run-123", "run-0"), { recursive: true });
    writeFileSync(parentFile, "");
    writeFileSync(sessionFile, `${JSON.stringify({ type: "message", message: { role: "assistant", provider: "test-provider", model: "broken-model", stopReason: "error", errorMessage: "unavailable", content: [] } })}\n`);
    const registerFixture = (pi: ExtensionAPI) => {
        pi.registerTool({ name: "subagent", label: "subagent", description: "Isolated Pi tool result fixture", parameters: Type.Object({ agent: Type.String() }),
            async execute() { return { content: [{ type: "text" as const, text: "failed" }], details: { mode: "single", runId: "run-123", results: [{ index: 0, agent: "worker", exitCode: 1, error: "unavailable", model: "test-provider/broken-model", progressSummary: { toolCount: 0 }, sessionFile }] } }; } });
        registerFallbackAdvice(pi, { enabled: true, fallbackModels: { worker: ["test-provider/second", "test-provider/third"] } });
    };
    const session = await createTestSession({ cwd: root, extensionFactories: [pi => registerShellContext(pi, "execution", () => "fixture shell policy"), registerFixture] });
    try {
        session.session.sessionManager.getSessionFile = () => parentFile;
        const model = session.session.model;
        if (!model) throw new Error("Missing fixture model");
        await session.session.setModel({ ...model, api });
        const requestPrompts: string[] = [];
        const running = session.run(when("Delegate", [calls("subagent", { agent: "worker" }), says("noted")]));
        const original = session.session.agent.streamFunction;
        session.session.agent.streamFunction = async (model, context, options) => {
            const prompt = getCurrentSystemPrompt(context.messages);
            const payload = await session.session.extensionRunner!.emitBeforeProviderRequest(api === "openai-responses"
                ? { instructions: prompt, input: structuredClone(context.messages) }
                : { messages: [{ role: "system", content: prompt }, ...structuredClone(context.messages)] });
            if (!payload || typeof payload !== "object") throw new Error("Missing provider payload");
            const text = api === "openai-responses"
                ? (payload as { instructions: string }).instructions
                : (payload as { messages: Array<{ content: string }> }).messages[0]!.content;
            requestPrompts.push(text);
            return original(model, context, options);
        };
        await running;
        expect(requestPrompts).toHaveLength(2);
        expect(requestPrompts[0]).not.toContain("test-provider/second");
        expect(requestPrompts[1]).toContain("test-provider/second");
        expect(requestPrompts[1]).toContain("test-provider/third");
        expect(requestPrompts[0]).toContain("fixture shell policy");
        expect(requestPrompts[1]).toContain("fixture shell policy");
        expect(JSON.stringify(session.session.sessionManager.getBranch())).not.toContain("test-provider/second");
    } finally {
        session.dispose();
        rmSync(root, { recursive: true, force: true });
    }
});

test("async completion gives one hint only to matching parent, without a duplicate notification", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-fallback-async-"));
    const parentFile = join(root, "parent.jsonl");
    const sessionFile = join(root, "parent", "run-123", "run-0", "session.jsonl");
    mkdirSync(join(root, "parent", "run-123", "run-0"), { recursive: true });
    writeFileSync(parentFile, "");
    writeFileSync(sessionFile, `${JSON.stringify({ type: "message", message: { role: "assistant", provider: "p", model: "broken", stopReason: "error", errorMessage: "request failed", content: [] } })}\n`);
    let bus: ExtensionAPI["events"] | undefined;
    const lifecycle: string[] = [];
    const session = await createTestSession({ cwd: root, extensionFactories: [(pi: ExtensionAPI) => {
        bus = pi.events;
        pi.on("session_start", (_event, ctx) => { lifecycle.push(`start:${ctx.sessionManager.getSessionId()}:${ctx.sessionManager.getSessionFile()}`); });
        pi.on("session_shutdown", () => { lifecycle.push("shutdown"); });
        registerFallbackAdvice(pi, { enabled: true, fallbackModels: { worker: ["p/second"] } });
    }] });
    try {
        session.session.sessionManager.getSessionFile = () => parentFile;
        const model = session.session.model;
        if (!model) throw new Error("Missing fixture model");
        await session.session.setModel({ ...model, api: "openai-responses" });
        await session.run(when("Wait", [says("waiting")]));
        expect(lifecycle[0]).toStartWith(`start:${session.session.sessionManager.getSessionId()}:`);
        expect(lifecycle).not.toContain("shutdown");
        const data = { mode: "single", runId: "run-123", sessionId: session.session.sessionManager.getSessionId(),
            results: [{ index: 0, agent: "worker", success: false, error: "request failed", outputState: "absent", model: "p/broken", sessionFile }] };
        expect(findFailedModelAdvice(data, parentFile, { worker: ["p/second"] })).toHaveLength(1);
        const request = () => session.session.extensionRunner!.emitBeforeProviderRequest({ instructions: "base", input: [] });
        const bare = { input: [{ role: "user", content: "unrelated" }] };
        expect(await session.session.extensionRunner!.emitBeforeProviderRequest(bare)).toEqual(bare);
        bus!.emit("subagent:async-complete", { ...data, sessionId: "another-session" });
        expect((await request() as { instructions: string }).instructions).not.toContain("p/second");
        bus!.emit("subagent:async-complete", data);
        bus!.emit("subagent:async-complete", data);
        const first = await request() as { instructions: string };
        expect(first.instructions.match(/<pi-subagent-fallback-advice>/g)).toHaveLength(1);
        expect(first.instructions).toContain("p/second");
        expect((await request() as { instructions: string }).instructions).not.toContain("p/second");
        expect(JSON.stringify(session.session.sessionManager.getBranch())).not.toContain("p/second");
    } finally {
        session.dispose();
        rmSync(root, { recursive: true, force: true });
    }
});
