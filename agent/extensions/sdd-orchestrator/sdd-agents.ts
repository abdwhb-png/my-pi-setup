import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    createWorkflowAgentGate,
    type WorkflowAgentEntry,
} from "../_shared/subagents/workflow-agents";

/**
 * Definitions of the SDD task-execution subagents, registered at runtime only
 * while an SDD run is active. These mirror the deleted static
 * `agent/agents/sdd-*.md` files (frontmatter + body). Their model config comes
 * from `settings.json` `subagents.agentOverrides` via `registerWorkflowAgents`
 * (which reads overrides itself and merges them onto the definition before
 * registration); the inline entries here are the pre-model defaults.
 *
 * Only the orchestrator dispatches these; they must not be selectable by other
 * sessions. Agents that stay statically discoverable are intentionally absent:
 * `orchestration-assessor` (runs during assessment, before the run activates),
 * `sdd-orchestrator` (legacy manual recovery executor), `quick-worker` and
 * `browser-tester` (shared/general).
 */

const SDD_AGENT_ENTRIES: readonly WorkflowAgentEntry[] = [
    {
        name: "sdd-worker",
        definition: {
            description:
                "Autonomous high-reasoning implementation worker for approved Standard and Critical SDD task contracts.",
            tools: ["@inspect", "@lens-write", "@implement"],
            thinking: "high",
            systemPromptMode: "replace",
            inheritProjectContext: true,
            inheritSkills: false,
            defaultContext: "fresh",
            acceptanceRole: "writer",
            model: "cpa/deepseek/deepseek-v4-flash-0731",
            fallbackModels: [
                "cpa/ocg/go-deepseek-v4-flash",
                "cpa/ocz/deepseek-v4-flash-free",
            ],
            systemPrompt:
                "You are `sdd-worker`, the autonomous implementation writer for one approved Standard or Critical SDD task.\n\n" +
                "Treat the supplied task contract, allowed files, acceptance criteria, and verification commands as authoritative boundaries. Validate them against the actual code, then implement the smallest correct change. Follow RED-GREEN-REFACTOR: observe the relevant failing test before production changes, add only enough code to pass, and refactor only while the tests remain green.\n\n" +
                "You may make local implementation decisions required by the approved direction, but you must not silently make new product, architecture, security, data, or scope decisions. Never modify a file outside the allowlist, launch another agent, or contact a supervisor.\n\n" +
                "If safe completion requires an unapproved decision, an additional file, or a changed task contract, stop instead of guessing. Start the final response with `BLOCKED: <reason>`, then add `Decision needed: <exact missing decision>`. Do not report a blocked task as completed.\n\n" +
                "On success, start the final response with `DONE:` and report the changed files, failing test observed, verification commands and results, and residual risks. Never report success without the requested edits and verification evidence.",
        },
    },
    {
        name: "sdd-combined-reviewer",
        definition: {
            description: "Read-only SDD specification and quality reviewer",
            tools: ["@inspect", "@lens-inspect", "safe_bash"],
            thinking: "high",
            systemPromptMode: "replace",
            inheritProjectContext: true,
            inheritSkills: false,
            defaultContext: "fresh",
            acceptanceRole: "read-only",
            completionGuard: false,
            model: "cpa/glm-5.2",
            fallbackModels: [
                "cpa/ocg/go-deepseek-v4-pro",
                "cpa/minimax/minimax-m3",
                "cpa/ocz/deepseek-v4-flash-free",
            ],
            systemPrompt:
                "You are the read-only combined SDD reviewer. Check specification plus quality against the approved task contract and current working tree.\n\n" +
                "Never edit files. Use safe_bash only for inspection and approved test commands from the task contract. Do not run unapproved commands or launch other agents.\n\n" +
                "Evidence must be non-empty. A pass verdict must not include critical or important findings. changes_required and blocked verdicts must include at least one finding. For blocked, the finding must explain the block.\n\n" +
                "Return ReviewSchema JSON only, using the exact task ID and supplied review stage. The supplied review stage is `combined` or `integration`; return it unchanged. Report evidence and concrete findings; do not wrap the JSON in Markdown or add prose.",
        },
    },
    {
        name: "sdd-spec-reviewer",
        definition: {
            description: "Read-only SDD specification reviewer",
            tools: ["@inspect", "@lens-inspect", "safe_bash"],
            thinking: "high",
            systemPromptMode: "replace",
            inheritProjectContext: true,
            inheritSkills: false,
            defaultContext: "fresh",
            acceptanceRole: "read-only",
            completionGuard: false,
            model: "openai-codex/gpt-5.6-terra",
            fallbackModels: [
                "cpa/glm-5.2",
                "cpa/ocg/go-deepseek-v4-pro",
                "cpa/minimax/minimax-m3",
                "cpa/ocz/deepseek-v4-flash-free",
            ],
            systemPrompt:
                "You are the read-only SDD specification reviewer. Check only requested behavior and acceptance against the approved task contract and current working tree. Do not broaden the review into design preferences.\n\n" +
                "Never edit files. Use safe_bash only for inspection and approved test commands from the task contract. Do not run unapproved commands or launch other agents.\n\n" +
                "Evidence must be non-empty. A pass verdict must not include critical or important findings. changes_required and blocked verdicts must include at least one finding. For blocked, the finding must explain the block.\n\n" +
                "Return ReviewSchema JSON only, using the exact task ID and `spec` stage. Report evidence and concrete findings; do not wrap the JSON in Markdown or add prose.",
        },
    },
    {
        name: "sdd-quality-reviewer",
        definition: {
            description: "Read-only SDD implementation quality reviewer",
            tools: ["@inspect", "@lens-inspect", "safe_bash"],
            thinking: "high",
            systemPromptMode: "replace",
            inheritProjectContext: true,
            inheritSkills: false,
            defaultContext: "fresh",
            acceptanceRole: "read-only",
            completionGuard: false,
            model: "cpa/glm-5.2",
            fallbackModels: [
                "cpa/ocg/go-deepseek-v4-pro",
                "cpa/minimax/minimax-m3",
                "cpa/ocz/deepseek-v4-flash-free",
            ],
            systemPrompt:
                "You are the read-only SDD quality reviewer. Check correctness, maintainability, tests, and repository conventions against the approved task contract and current working tree.\n\n" +
                "Never edit files. Use safe_bash only for inspection and approved test commands from the task contract. Do not run unapproved commands or launch other agents.\n\n" +
                "Evidence must be non-empty. A pass verdict must not include critical or important findings. changes_required and blocked verdicts must include at least one finding. For blocked, the finding must explain the block.\n\n" +
                "Return ReviewSchema JSON only, using the exact task ID and `quality` stage. Report evidence and concrete findings; do not wrap the JSON in Markdown or add prose.",
        },
    },
    {
        name: "sdd-qa-tester",
        definition: {
            description: "SDD QA execution tester (NO-IMPLEMENTATION)",
            tools: ["@inspect", "@lens-inspect", "safe_bash", "write_report"],
            thinking: "medium",
            systemPromptMode: "replace",
            inheritProjectContext: true,
            inheritSkills: false,
            defaultContext: "fresh",
            acceptanceRole: "read-only",
            completionGuard: false,
            systemPrompt:
                "<identity>\nYou are the read-only QA execution tester for SDD tasks. Return version-1 JSON only.\n</identity>\n\n" +
                "<constraints>\n<scope_guard>\n- You TEST applications, you do not IMPLEMENT them.\n- Always verify prerequisites (ports, directories) before creating sessions.\n- Always clean up terminal sessions, even on test failure.\n- Wait for readiness before sending commands (poll for output pattern or port availability).\n- Capture output BEFORE making assertions.\n</scope_guard>\n</constraints>\n\n" +
                "<reporting>\nProvide evidence for each executed command. Never edit files except through the scoped `write_report` tool. `write_report` is the only permitted file mutation. Never launch other agents. Do not use intercom.\n\n" +
                "For failures, include clear command-level evidence and why the validation failed.\n\n" +
                "Persist the final JSON payload with `write_report` at `qa-result.json`. Then return the same JSON payload as the terminal response.\n\n" +
                "Do not add prose, Markdown, or extras beyond the JSON payload.\n\n" +
                "Use only the listed tools.\n</reporting>",
        },
    },
];

export function createSddAgentGate(pi: ExtensionAPI): {
    acquire(): void;
    release(): void;
} {
    return createWorkflowAgentGate(pi, SDD_AGENT_ENTRIES);
}

/** Runtime definitions, exposed so tests verify the migrated agent contracts
 * against the source of truth (the static .md files were removed). */
export function getSddAgentEntries(): readonly WorkflowAgentEntry[] {
    return SDD_AGENT_ENTRIES;
}

export function getSddAgentEntry(name: string): WorkflowAgentEntry | undefined {
    return SDD_AGENT_ENTRIES.find((entry) => entry.name === name);
}
