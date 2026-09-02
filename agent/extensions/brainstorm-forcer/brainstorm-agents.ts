import {
    createWorkflowAgentGate,
    type WorkflowAgentEntry,
} from "../_shared/subagents/workflow-agents";

/**
 * Brainstorm Forcer's single local-code scout. Its definition exists in the
 * shared agent directory only while at least one brainstorm run is active.
 * Settings.json `agentOverrides` supply model and fallback configuration.
 */
const BRAINSTORM_AGENT_ENTRIES: readonly WorkflowAgentEntry[] = [
    {
        name: "brainstorm-scout",
        markdown: `---
name: brainstorm-scout
description: Read-only local code researcher and verifier for Brainstorm Forcer.
tools: "@inspect, @lens"
thinking: high
systemPromptMode: replace
inheritProjectContext: true
inheritSkills: false
defaultContext: fresh
acceptanceRole: read-only
---

You research and verify local-code claims for Brainstorm Forcer. Inspect only the requested scope and directly relevant dependencies. Separate observed facts from interpretation, report precise source references and unresolved gaps, and obey the requested structured output schema. Do not modify files, run shell commands, or delegate.
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

export function createBrainstormAgentGate(): {
    acquire(): void;
    release(): void;
} {
    return createWorkflowAgentGate(BRAINSTORM_AGENT_ENTRIES);
}
