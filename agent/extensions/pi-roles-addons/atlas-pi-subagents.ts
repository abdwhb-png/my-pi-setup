import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getActiveRole } from "../_shared/pi-roles";

export const ATLAS_PI_SUBAGENTS_MARKER = "<atlas-pi-subagents>";

const ATLAS_ROLE_NAME = "atlas-orchestrator";
const ATLAS_PI_SUBAGENTS_INSTRUCTION = `${ATLAS_PI_SUBAGENTS_MARKER}
When Atlas is the active parent orchestrator, load and follow the pi-subagents skill before the first delegation. Use its current execution API and follow its orchestration, retry, isolation, and parent-only constraints.

Keep orchestration lightweight and parent-owned:
- For implementation, omit \`context\` for \`worker\` so its configured fork preference and safe fresh fallback apply. Use \`context: "fresh"\` deliberately for independent reviewers, scouts, validators, or a replacement that must challenge prior assumptions.
- Make every child task self-sufficient. Include the working directory or repository, plan or approved contract, exact objective and scope, relevant decisions and prior findings, files or symbols to inspect first, validation commands, and required result evidence.
- Preserve worker continuity after failed verification. Resume the retained child with the exact failure evidence and parent diagnosis, assign the latest returned \`runId\`, and use that latest id for the next follow-up. Allow at most two retained resumes before a fresh replacement receives a compact history of both failed approaches; escalate if that replacement cannot complete safely.
- Tell mutation-capable children to use \`contact_supervisor\` with reason \`need_decision\` and wait when an unapproved product, architecture, scope, or authority decision blocks progress. Do not use supervisor contact for routine completion.
- Keep one writer per shared worktree. Parallelize read-only work, or writers only when each has an explicitly isolated worktree or repository and non-conflicting ownership.
- Synthesize reviewer findings in the parent before sending accepted fixes to one worker. Stop review/fix cycling when no concrete fix worth doing remains, a user decision is required, or bounded recovery is exhausted.
</atlas-pi-subagents>`;

function shouldInject(systemPrompt: string, ctx: ExtensionContext): boolean {
    if (process.env.PI_SUBAGENT_CHILD === "1") return false;
    if (systemPrompt.includes(ATLAS_PI_SUBAGENTS_MARKER)) return false;

    try {
        const activeRole = getActiveRole(ctx.sessionManager.getEntries());
        return activeRole?.name === ATLAS_ROLE_NAME;
    } catch {
        return false;
    }
}

export default function atlasPiSubagents(pi: ExtensionAPI): void {
    pi.on("before_agent_start", (event, ctx) => {
        if (!shouldInject(event.systemPrompt, ctx)) {
            return { systemPrompt: event.systemPrompt };
        }

        return {
            systemPrompt: `${event.systemPrompt}\n\n${ATLAS_PI_SUBAGENTS_INSTRUCTION}`,
        };
    });
}
