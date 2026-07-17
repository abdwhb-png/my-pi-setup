/**
 * role-subagents — Restrict available subagents per role via `subagents:` frontmatter.
 *
 * When a role file has a `subagents:` field (comma-separated subagent names),
 * this extension intercepts `tool_call` events for the `subagent` tool and
 * blocks calls targeting agents not in the allowed list.
 *
 * Frontmatter format in role `.md` files:
 *   subagents: worker, scout, reviewer
 *
 * If `subagents` is absent or empty, no restriction is applied.
 */

import type {
    ExtensionAPI,
    ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {
    getActiveRole,
    parseCommaList,
    readFrontmatter,
} from '../_shared/pi-roles';

/** Cache: role path → allowed subagent names (null = unrestricted). */
const subagentCache = new Map<string, string[] | null>();

function getAllowedSubagents(rolePath: string): string[] | null {
    const cached = subagentCache.get(rolePath);
    if (cached !== undefined) return cached;

    const fm = readFrontmatter<{ subagents?: string }>(rolePath);
    if (!fm || !fm.subagents) {
        subagentCache.set(rolePath, null);
        return null;
    }

    const allowed = parseCommaList(fm.subagents);
    subagentCache.set(rolePath, allowed);
    return allowed;
}

function getTargetAgent(input: Record<string, unknown>): string | undefined {
    const agent = input.agent;
    return typeof agent === 'string' ? agent : undefined;
}

function handleToolCall(
    event: { toolName: string; input: Record<string, unknown> },
    ctx: ExtensionContext,
): { block?: boolean; reason?: string } | undefined {
    // Only intercept subagent tool
    if (event.toolName !== 'subagent') return undefined;

    // Get active role
    let entries;
    try {
        entries = ctx.sessionManager.getEntries();
    } catch {
        return undefined;
    }

    const activeRole = getActiveRole(entries);
    if (!activeRole) return undefined;

    // Check subagent restrictions
    const allowed = getAllowedSubagents(activeRole.path);
    if (!allowed) return undefined;

    const targetAgent = getTargetAgent(event.input);
    if (!targetAgent) return undefined;

    if (!allowed.includes(targetAgent)) {
        return {
            block: true,
            reason:
                `Role "${activeRole.name}" only allows subagents: ${allowed.join(', ')}. ` +
                `"${targetAgent}" is not allowed.`,
        };
    }

    return undefined;
}

export default function roleSubagents(pi: ExtensionAPI): void {
    pi.on('tool_call', async (event, ctx) => {
        const result = handleToolCall(
            event as { toolName: string; input: Record<string, unknown> },
            ctx,
        );
        if (result) return result;
    });
}
