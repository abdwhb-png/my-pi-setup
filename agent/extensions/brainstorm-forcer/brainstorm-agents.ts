import { type WorkflowAgentEntry } from "../_shared/subagents/workflow-agents";

/**
 * Definition of the Brainstorm Forcer local-code verifier, written to the
 * shared agent dir only while a brainstorm run is active so it is not
 * discoverable or dispatchable by other sessions. Settings.json
 * `agentOverrides` (model, fallbacks, ...) are applied by static discovery.
 */

const BRAINSTORM_AGENT_ENTRIES: readonly WorkflowAgentEntry[] = [
    {
        name: "brainstorm-code-scout",
        markdown: `---
name: brainstorm-code-scout
description: Read-only local code verifier for Brainstorm Forcer evidence checks.
tools: "@inspect, @lens"
thinking: high
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
defaultContext: fresh
acceptanceRole: read-only
---

You verify local-code claims for Brainstorm Forcer. Inspect only the cited files and their directly relevant dependencies. Do not modify files, run shell commands, or delegate. Return concise, evidence-backed findings that strictly match the requested structured output schema.
`,
    },
];

export function getBrainstormAgentEntries(): readonly WorkflowAgentEntry[] {
    return BRAINSTORM_AGENT_ENTRIES;
}

export function getBrainstormAgentEntry(
    name: string,
): WorkflowAgentEntry | undefined {
    return BRAINSTORM_AGENT_ENTRIES.find((entry) => entry.name === name);
}
