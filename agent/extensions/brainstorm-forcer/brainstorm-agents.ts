import { type WorkflowAgentEntry } from "../_shared/subagents/workflow-agents";

/**
 * Definition of the Brainstorm Forcer local-code verifier, registered at
 * runtime only while a brainstorm run is active so it is not discoverable or
 * dispatcheable by other sessions.
 *
 * The static `agent/agents/brainstorm-code-scout.md` was removed; the agent is
 * now supplied by the runtime registry while a run is active. Because runtime-
 * merged agents do not receive settings.json `agentOverrides` at discovery,
 * `registerWorkflowAgents` reads `subagents.agentOverrides` from settings.json
 * itself and merges any entry for `brainstorm-code-scout` (model, fallbacks,
 * etc.) onto this definition before registering.
 */

const BRAINSTORM_AGENT_ENTRIES: readonly WorkflowAgentEntry[] = [
    {
        name: "brainstorm-code-scout",
        definition: {
            description:
                "Read-only local code verifier for Brainstorm Forcer evidence checks.",
            tools: ["@inspect", "@lens"],
            thinking: "high",
            systemPromptMode: "replace",
            inheritProjectContext: true,
            inheritSkills: false,
            defaultContext: "fresh",
            acceptanceRole: "read-only",
            systemPrompt:
                "You verify local-code claims for Brainstorm Forcer. Inspect only the cited files and their directly relevant dependencies. Do not modify files, run shell commands, or delegate. Return concise, evidence-backed findings that strictly match the requested structured output schema.",
        },
    },
];

/** Runtime definition, exposed so tests verify the migrated agent contract
 * against the source of truth (the static .md file was removed). */
export function getBrainstormAgentEntries(): readonly WorkflowAgentEntry[] {
    return BRAINSTORM_AGENT_ENTRIES;
}

export function getBrainstormAgentEntry(
    name: string,
): WorkflowAgentEntry | undefined {
    return BRAINSTORM_AGENT_ENTRIES.find((entry) => entry.name === name);
}
