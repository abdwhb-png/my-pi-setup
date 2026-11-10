import { expect, test } from "bun:test";
import { zstdDecompressSync } from "node:zlib";
import { createTestSession } from "@abdwhb-png/pi-test-harness";
import type { Model } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { useIsolatedAgentDir } from "../_shared/testing/config-fixture.ts";

useIsolatedAgentDir();

test("Codex compaction alone preserves checkpoint and tool declarations through the transport after a role change", async () => {
    const t = await createTestSession({
        extensions: [import.meta.dir + "/index.ts"],
    });
    try {
        const model: Model<"openai-codex-responses"> = {
            ...t.session.agent.state.model,
            provider: "openai-codex",
            api: "openai-codex-responses",
            id: "fixture",
            compat: {
                supportsAdditionalTools: true,
                supportsToolSearch: true,
                supportsMidConvoSystemMessages: true,
                supportsOpenAIGrammarTools: true,
            },
        };
        t.session.agent.state.model = model;
        const manager = t.session.sessionManager;
        manager.appendMessage({
            role: "system",
            content: "fixture",
            timestamp: 1,
            toolsAdded: [
                {
                    name: "@inspect",
                    description: "Historical group placeholder",
                    parameters: Type.Object({}),
                },
                {
                    name: "read",
                    description: "Read",
                    parameters: Type.Object({}),
                },
                {
                    name: "codemode",
                    description: "Run",
                    parameters: Type.Object({ code: Type.String() }),
                    constrainedSampling: {
                        type: "grammar",
                        variants: { openai_lark: "start: /.+/" },
                    },
                },
            ],
        });
        manager.appendCompaction(
            "local marker",
            null,
            100,
            {
                kind: "openai-codex-native-compaction",
                version: 1,
                modelKey: "openai-codex:openai-codex-responses:fixture",
                replacementHistory: [
                    { type: "compaction", encrypted_content: "fixture" },
                ],
            },
            true,
        );
        const jwt = `fixture.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } }))}.fixture`;
        for (const changed of [false, true]) {
            if (changed)
                manager.appendMessage({
                    role: "system",
                    content: "Role changed",
                    timestamp: 2,
                    toolsRemoved: [{ name: "read" }],
                    toolsAdded: [
                        {
                            name: "edit",
                            description: "Edit",
                            parameters: Type.Object({}),
                        },
                    ],
                });
            let transported: Record<string, unknown> | undefined;
            const fetch: typeof globalThis.fetch = Object.assign(
                async (_url: unknown, init?: RequestInit) => {
                    const body =
                        new Headers(init?.headers).get("content-encoding") ===
                        "zstd"
                            ? zstdDecompressSync(
                                  init!.body as Uint8Array,
                              ).toString("utf8")
                            : String(init?.body);
                    transported = JSON.parse(body);
                    return new Response("offline fixture stop", {
                        status: 400,
                    });
                },
                { preconnect() {} },
            );
            await stream(
                model,
                normalizeContext({
                    messages: convertToLlm(
                        manager.buildSessionContext().messages,
                    ),
                }),
                {
                    apiKey: jwt,
                    transport: "sse",
                    maxRetries: 0,
                    fetch,
                    onPayload: (payload) =>
                        t.session.extensionRunner!.emitBeforeProviderRequest(
                            payload,
                        ),
                },
            ).result();
            expect(transported).toBeDefined();
            const serialized = JSON.stringify(transported);
            expect(serialized).toContain('"type":"compaction"');
            expect(serialized).toContain('"type":"custom","name":"codemode"');
            expect(serialized).toContain('"name":"read"');
            expect(serialized).not.toContain('"name":"@inspect"');
            const payload = transported as {
                input: Array<{ tools?: Array<{ name: string }> }>;
            };
            for (const item of payload.input) {
                for (const tool of item.tools ?? [])
                    expect(tool.name).toMatch(/^[a-zA-Z0-9_-]+$/);
            }

            if (changed) {
                expect(serialized).toContain('"name":"edit"');
                expect(serialized).toContain("no longer available");
            }
        }
    } finally {
        await t.close();
    }
}, 20000);
