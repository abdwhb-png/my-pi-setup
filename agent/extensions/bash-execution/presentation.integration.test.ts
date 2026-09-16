import { expect, test } from "bun:test";
import { createTestSession, says, when } from "@abdwhb-png/pi-test-harness";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bashExecution from "./index.ts";
import { registerToolPolicyContribution } from "../_shared/tool-policy/index.ts";
import { createToolGroupsExtension } from "../tool-groups/index.ts";

test.each([
    { active: "bash", prompt: "standard" },
    { active: "safe_bash", prompt: "standard" },
    { active: "bash", prompt: "custom" },
    { active: "safe_bash", prompt: "custom" },
] as const)("exposes only active $active guidance with a $prompt prompt", async ({ active, prompt }) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-shell-visible-"));
    await mkdir(join(cwd, ".pi"));
    await writeFile(join(cwd, ".pi/settings.json"), JSON.stringify({ safeBash: { mode: "coexist", telemetry: { enabled: false } } }));
    const session = await createTestSession({
        cwd,
        ...(prompt === "custom" ? { systemPrompt: "Use the available tools." } : {}),
        extensionFactories: [bashExecution,
            pi => { registerToolPolicyContribution(pi, "fixture-shell-visibility", () => ({ deny: [active === "bash" ? "safe_bash" : "bash"] })); },
            createToolGroupsExtension(() => ({ groups: {} }), () => undefined, () => undefined)],
    });
    try {
        let modelContext = "";
        let modelSystem = "";
        const running = session.run(when("Observe tools", [says("done")]));
        const original = session.session.agent.streamFunction;
        session.session.agent.streamFunction = (model, context, options) => { modelContext = JSON.stringify(context.messages); modelSystem = context.systemPrompt ?? ""; return original(model, context, options); };
        await running;
        expect(session.session.getActiveToolNames()).toContain(active);
        expect(session.session.getActiveToolNames()).not.toContain(active === "bash" ? "safe_bash" : "bash");
        expect(modelContext).not.toContain("Current shell execution context");
        const tool = session.session.getToolDefinition(active)!;
        const payload = await session.session.extensionRunner!.emitBeforeProviderRequest({ instructions: modelSystem, input: [], tool_choice: "auto", tools: [{ type: "function", name: active, description: tool.description, parameters: tool.parameters }] });
        const wire = JSON.stringify(payload);
        expect(wire.includes("safe_bash: Tool availability=")).toBe(active === "safe_bash");
        expect(wire).toContain("Shell policy context is unavailable");
        expect(wire).toContain("When a command targets another execution environment");
        expect(wire.includes("Follow the current safe_bash command checks")).toBe(active === "safe_bash");
        const disabled = await session.session.extensionRunner!.emitBeforeProviderRequest({ instructions: "Use the available tools.", input: [], tool_choice: "none", tools: [{ type: "function", name: active, description: tool.description, parameters: tool.parameters }] });
        expect(JSON.stringify(disabled)).not.toContain("When a command targets another execution environment");
    } finally { session.dispose(); await rm(cwd, { recursive: true, force: true }); }
});

test("both registered shell tools share stable execution guidance", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-shell-presentation-"));
    const session = await createTestSession({ cwd, extensionFactories: [bashExecution] });
    try {
        for (const name of ["bash", "safe_bash"] as const) {
            const tool = session.session.getToolDefinition(name)!;
            expect(tool.description).toStartWith(name === "bash"
                ? "Execute a shell command using the current sandbox or host execution mode."
                : "Execute a shell command using the current sandbox or host execution mode, with additional command checks.");
            expect(tool.description).toContain("stdin");
            expect(tool.description).toContain("stdout and stderr");
            expect(tool.description).toContain("truncated");
            expect(tool.promptSnippet).toContain("current sandbox or host execution mode");
            expect(tool.description).not.toMatch(/Mode=|allow=|deny\(default\)|replace|coexist/);
            expect(tool.promptGuidelines).toContain("When a command targets another execution environment, resolve its executable paths and variables in that environment.");
            expect(tool.promptGuidelines?.join("\n")).not.toMatch(/PI_\*|SFW|dev-services|hostCapability/);
        }
    } finally {
        session.dispose();
        await rm(cwd, { recursive: true, force: true });
    }
});
