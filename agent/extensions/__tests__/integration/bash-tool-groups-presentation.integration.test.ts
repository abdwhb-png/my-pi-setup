import { expect, test } from "bun:test";
import { createTestSession, says, when } from "@abdwhb-png/pi-test-harness";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerToolPolicyContribution } from "../../_shared/tool-policy/index.ts";
import { publicExtensionEntrypoints } from "./public-extension-session.ts";

test.each([
    { active: "bash", prompt: "standard" },
    { active: "safe_bash", prompt: "standard" },
    { active: "bash", prompt: "custom" },
    { active: "safe_bash", prompt: "custom" },
] as const)(
    "exposes only active $active guidance with a $prompt prompt",
    async ({ active, prompt }) => {
        const cwd = await mkdtemp(join(tmpdir(), "pi-shell-visible-"));
        await mkdir(join(cwd, ".pi"));
        await writeFile(
            join(cwd, ".pi/settings.json"),
            JSON.stringify({
                safeBash: { mode: "coexist", telemetry: { enabled: false } },
            }),
        );
        const session = await createTestSession({
            cwd,
            ...(prompt === "custom"
                ? { systemPrompt: "Use the available tools." }
                : {}),
            extensions: publicExtensionEntrypoints(
                "bash-execution",
                "tool-groups",
            ),
            extensionFactories: [
                (pi) => {
                    registerToolPolicyContribution(
                        pi,
                        "fixture-shell-visibility",
                        () => ({
                            deny: [active === "bash" ? "safe_bash" : "bash"],
                        }),
                    );
                },
            ],
        });
        try {
            let modelContext = "";
            let modelSystem = "";
            const running = session.run(
                when("Observe tools", [says("done")]),
            );
            const original = session.session.agent.streamFunction;
            session.session.agent.streamFunction = (model, context, options) => {
                modelContext = JSON.stringify(context.messages);
                modelSystem = context.systemPrompt ?? "";
                return original(model, context, options);
            };
            await running;
            expect(session.session.getActiveToolNames()).toContain(active);
            expect(session.session.getActiveToolNames()).not.toContain(
                active === "bash" ? "safe_bash" : "bash",
            );
            expect(modelContext).not.toContain(
                "Current shell execution context",
            );
            const tool = session.session.getToolDefinition(active)!;
            const payload = await session.session.extensionRunner!.emitBeforeProviderRequest(
                {
                    instructions: modelSystem,
                    input: [],
                    tool_choice: "auto",
                    tools: [
                        {
                            type: "function",
                            name: active,
                            description: tool.description,
                            parameters: tool.parameters,
                        },
                    ],
                },
            );
            const wire = JSON.stringify(payload);
            expect(wire.includes("safe_bash: Tool availability=")).toBe(
                active === "safe_bash",
            );
            expect(wire).toContain("Shell policy context is unavailable");
            expect(wire).toContain(
                "When a command targets another execution environment",
            );
            expect(
                wire.includes("Follow the current safe_bash command checks"),
            ).toBe(active === "safe_bash");
            const disabled = await session.session.extensionRunner!.emitBeforeProviderRequest(
                {
                    instructions: "Use the available tools.",
                    input: [],
                    tool_choice: "none",
                    tools: [
                        {
                            type: "function",
                            name: active,
                            description: tool.description,
                            parameters: tool.parameters,
                        },
                    ],
                },
            );
            expect(JSON.stringify(disabled)).not.toContain(
                "When a command targets another execution environment",
            );
        } finally {
            session.dispose();
            await rm(cwd, { recursive: true, force: true });
        }
    },
);
