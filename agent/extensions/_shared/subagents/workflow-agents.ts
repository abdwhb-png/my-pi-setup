import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Gate workflow-specific subagents behind the active workflow lifecycle by
 * writing/removing their `.md` agent definition files in the shared agent dir.
 *
 * Keep Markdown discovery so ordinary upstream agentOverrides apply to workflow
 * agents, just as they do to user agents. Runtime registration has a different
 * override contract.
 */

export type WorkflowAgentEntry = {
    /** Agent name (also the `.md` basename, e.g. "brainstorm-code-scout"). */
    name: string;
    /** Full `.md` content: YAML frontmatter + body. */
    markdown: string;
};

function agentsDir(): string {
    return join(getAgentDir(), "agents");
}

function agentPath(name: string): string {
    return join(agentsDir(), `${name}.md`);
}

export function isWorkflowAgentActive(name: string): boolean {
    return existsSync(agentPath(name));
}

/**
 * Write each entry's `.md` into the shared agent dir and return a handle that
 * removes exactly those files. Files only exist while a workflow owns them.
 */
export function registerWorkflowAgents(
    entries: readonly WorkflowAgentEntry[],
): { dispose(): void } {
    const dir = agentsDir();
    mkdirSync(dir, { recursive: true });
    const written: string[] = [];
    for (const entry of entries) {
        const path = agentPath(entry.name);
        writeFileSync(path, entry.markdown, "utf8");
        written.push(path);
    }
    let disposed = false;
    return {
        dispose() {
            if (disposed) return;
            disposed = true;
            for (const path of written) {
                try {
                    rmSync(path, { force: true });
                } catch {
                    // Best effort: a missing file is already the desired state.
                }
            }
        },
    };
}

/**
 * Refcounted lifecycle gate: writes the agent files when the first run
 * acquires, removes them when the last run releases. Safe for concurrent runs
 * and resume-after-restart (a resumed run re-acquires on start).
 */
export function createWorkflowAgentGate(
    entries: readonly WorkflowAgentEntry[],
): { acquire(): void; release(): void } {
    let refCount = 0;
    let handle: { dispose(): void } | null = null;
    return {
        acquire() {
            refCount += 1;
            if (handle) return;
            handle = registerWorkflowAgents(entries);
        },
        release() {
            if (refCount <= 0) return; // no active run
            refCount -= 1;
            if (refCount !== 0) return; // other runs still active
            handle?.dispose();
            handle = null;
        },
    };
}
