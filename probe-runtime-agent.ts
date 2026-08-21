import { registerAgent } from "pi-subagents/agents";

const pi = { on: () => () => {}, registerTool: () => {} } as any;

const reg = registerAgent({
  pi,
  name: "brainstorm-code-scout",
  definition: {
    description: "test",
    systemPrompt: "you are scout",
    tools: ["@inspect", "@lens"],
    thinking: "high",
    systemPromptMode: "replace",
    inheritProjectContext: true,
    inheritSkills: false,
    defaultContext: "fresh",
    acceptanceRole: "read-only",
  },
});
console.log("registered:", typeof reg.dispose);

try {
  const { listRuntimeAgentConfigs } = await import(
    "pi-subagents/src/agents/runtime-agent-registry.ts"
  );
  const list = listRuntimeAgentConfigs(pi);
  console.log(
    "listRuntimeAgentConfigs:",
    list.length,
    list.map((a: any) => a.name),
  );
} catch (e: any) {
  console.log("internal import failed:", e.message);
}
