import { expect, test } from "bun:test";
import { calls, createTestSession, says, when } from "@abdwhb-png/pi-test-harness";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { hostExecution, registerExecutionProvenance } from "./index.ts";

for (const observed of [false, true]) {
    test.each(["before", "after"] as const)(`final tool errors stay distinct from process evidence (observed=${observed}, hook=%s)`, async order => {
        const fixture = (pi: ExtensionAPI) => {
            pi.registerTool({
                name: "fixture_probe", label: "Fixture", description: "Return fixture evidence",
                parameters: Type.Object({}),
                async execute() {
                    return { content: [{ type: "text", text: "raw fixture" }], details: observed ? { execution: { ...hostExecution("process"), exitCode: 0 } } : {} };
                },
            });
        };
        const validation = (pi: ExtensionAPI) => { pi.on("tool_result", event => {
            if (event.toolName === "fixture_probe") return { isError: true };
        }); };
        const session = await createTestSession({ extensionFactories: [fixture, ...(order === "before" ? [validation, registerExecutionProvenance] : [registerExecutionProvenance, validation])] });
        try {
            const contexts: string[] = [];
            const running = session.run(when("Probe", [calls("fixture_probe", {}), says("done")]));
            const original = session.session.agent.streamFunction;
            session.session.agent.streamFunction = (model, context, options) => {
                contexts.push(JSON.stringify(context.messages));
                return original(model, context, options);
            };
            await running;
            const result = session.events.toolResultsFor("fixture_probe").at(-1)!;
            expect(result.isError).toBe(true);
            expect(result.details).toMatchObject({ execution: { outcome: observed ? "succeeded" : "unknown" } });
            expect(result.text).toBe("raw fixture");
            expect(contexts.at(-1)).toContain("Tool result: failed");
            expect(contexts.at(-1)).toContain("Execution provenance:");
        } finally { session.dispose(); }
    }, 30_000);
}
