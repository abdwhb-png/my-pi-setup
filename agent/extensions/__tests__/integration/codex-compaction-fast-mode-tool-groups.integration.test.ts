import { expect, test } from "bun:test";
import { createTestSession } from "@abdwhb-png/pi-test-harness";
import { useIsolatedAgentDir } from "../../_shared/testing/config-fixture.ts";
import { publicExtensionEntrypoint } from "./public-extension-session.ts";

useIsolatedAgentDir();

for (const order of [
    ["pi-codex-compaction", "fast-mode"],
    ["fast-mode", "pi-codex-compaction"],
]) {
    test(`${order.join(" then ")}: request hooks preserve checkpoint, service tier, and tool-policy observation`, async () => {
        const t = await createTestSession({
            extensions: [...order, "tool-groups"].map(
                publicExtensionEntrypoint,
            ),
        });
        try {
            t.session.agent.state.model = {
                ...t.session.agent.state.model,
                provider: "openai-codex",
                api: "openai-codex-responses",
                id: "fixture",
            };
            const manager = t.session.sessionManager;
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
            const request = {
                model: "fixture",
                input: [],
                service_tier: "auto",
                tool_choice: "auto",
                tools: [
                    { type: "function", name: "safe_bash", parameters: {} },
                ],
            };
            const runner = t.session.extensionRunner;
            if (!runner) throw new Error("Missing real Pi extension runner");

            for (const enabled of [true, false]) {
                await t.session.prompt(`/fast-mode ${enabled ? "on" : "off"}`);
                const result = await runner.emitBeforeProviderRequest(request);
                expect(result).toMatchObject({
                    model: request.model,
                    service_tier: enabled ? "priority" : "auto",
                    tool_choice: request.tool_choice,
                    tools: request.tools,
                    input: expect.arrayContaining([
                        { type: "compaction", encrypted_content: "fixture" },
                    ]),
                });
                expect(manager.getEntries().at(-1)).toMatchObject({
                    customType: "tool-policy:provider-request",
                    data: {
                        observation: {
                            supported: true,
                            callableToolNames: expect.arrayContaining([
                                "safe_bash",
                            ]),
                        },
                    },
                });
            }
        } finally {
            await t.close();
        }
    });
}
