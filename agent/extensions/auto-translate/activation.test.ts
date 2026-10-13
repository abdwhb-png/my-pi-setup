import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestSession } from "@abdwhb-png/pi-test-harness";

test("Pi loads translation on first use and preserves send, display and off behavior", async () => {
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const root = await mkdtemp(join(tmpdir(), "translate-activation-"));
    const requests: string[] = [];
    let session: Awaited<ReturnType<typeof createTestSession>> | undefined;
    let server: ReturnType<typeof Bun.serve> | undefined;
    try {
        process.env.PI_CODING_AGENT_DIR = root;
        await mkdir(join(root, "config"));
        await writeFile(join(root, "config/translate.json"), JSON.stringify({
            model: "translate-fixture/translator",
            languages: { fr: "French" },
        }));
        // Only the external completion endpoint is replaced.
        server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(request) {
                requests.push(await request.text());
                return new Response([
                    `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "translator", choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null }] })}`,
                    `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "translator", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
                    "data: [DONE]",
                    "",
                ].join("\n\n"), { headers: { "Content-Type": "text/event-stream" } });
            },
        });
        const baseUrl = `http://127.0.0.1:${server.port}/v1`;
        session = await createTestSession({
            cwd: root,
            extensions: [join(import.meta.dir, "index.ts")],
            extensionFactories: [pi => pi.registerProvider("translate-fixture", {
                api: "openai-completions",
                baseUrl,
                apiKey: "fixture-only",
                models: [{
                    id: "translator", name: "Fixture translator", reasoning: false,
                    input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 4096, maxTokens: 512,
                }],
            })],
        });
        const runner = session.session.extensionRunner!;
        expect(runner.getCommand("translate-on")).toBeDefined();
        expect(runner.getCommand("translate-to-fr")).toBeDefined();
        expect(await runner.emitInput("bonjour", undefined, "interactive")).toEqual({ action: "continue" });
        await session.session.prompt("/translate-send");
        await session.session.prompt("/translate-off");
        expect(requests).toHaveLength(0);
        await session.session.prompt("/translate-send");
        await session.session.prompt("/translate-on");
        expect(await runner.emitInput("  ", undefined, "interactive")).toEqual({ action: "continue" });
        expect(await runner.emitInput("bonjour", undefined, "extension")).toEqual({ action: "continue" });
        expect(requests).toHaveLength(0);

        expect(await runner.emitInput("bonjour", undefined, "interactive")).toMatchObject({ action: "transform", text: "Hello" });
        expect(requests).toHaveLength(1);
        expect(requests[0]).toContain("English");
        expect(requests[0]).toContain("bonjour");
        await session.session.prompt("/translate-send");
        expect(await runner.emitInput("salut", undefined, "interactive")).toEqual({ action: "continue" });
        expect(session.events.uiCallsFor("notify").some(call => String(call.args[0]).includes("[en] Hello"))).toBe(true);
        expect(requests).toHaveLength(2);
        await session.session.prompt("/translate-off");
        expect(await runner.emitInput("bonjour", undefined, "interactive")).toEqual({ action: "continue" });
        expect(requests).toHaveLength(2);

        await session.session.prompt("/translate-to-fr");
        await runner.emitInput("hello", undefined, "interactive");
        expect(requests).toHaveLength(3);
        expect(requests[2]).toContain("French");
        await runner.emit({ type: "session_start", reason: "startup" });
        expect(await runner.emitInput("bonjour", undefined, "interactive")).toEqual({ action: "continue" });
        expect(requests).toHaveLength(3);
        expect(session.events.uiCallsFor("notify").filter(call => call.args[1] === "error")).toEqual([]);
    } finally {
        session?.dispose();
        await server?.stop(true);
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        await rm(root, { recursive: true, force: true });
    }
}, 20_000);
