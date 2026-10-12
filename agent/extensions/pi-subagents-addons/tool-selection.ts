import type {
    ToolSelectionRequest,
    ToolSelectionResult,
} from "../_shared/subagents/index.ts";
/** @extension-reachability-root Public provider selected by global subagents.toolSelectionResolver. */
import { loadToolGroupsConfig } from "../_shared/tool-groups/config.ts";
import { resolveToolAliases } from "../_shared/tool-groups/resolver.ts";

/** One configuration read per discovery batch, never a cached permission snapshot. */
export function resolveTools(
    request: ToolSelectionRequest,
): ToolSelectionResult[] {
    const { groups } = loadToolGroupsConfig(request.cwd, {
        agentDir: request.agentDir,
        projectTrusted: request.scope !== "user" && request.projectTrusted,
        strict: true,
    });
    const available = new Set(
        [
            ...Object.values(groups).flat(),
            ...request.selections.flatMap(({ selectors }) => selectors),
        ].filter((value) => !value.startsWith("@") && !/[?*]/.test(value)),
    );
    return request.selections.map(({ agentName, selectors }) => {
        const expanded = resolveToolAliases(selectors, available, groups);
        const visited = [
            ...selectors,
            ...expanded.expandedAliases.flatMap(
                (alias) => groups[alias.slice(1)] ?? [],
            ),
        ];
        let error: string | undefined;
        if (visited.some((value) => /[?*]/.test(value)))
            error = "Wildcard tool selections are unsupported";
        else if (visited.includes("@")) error = "Empty tool-group alias";
        else if (expanded.diagnostics.length)
            error = expanded.diagnostics.map((d) => d.message).join("; ");
        return error
            ? { ok: false, error: `${agentName}: ${error}` }
            : { ok: true, selectors: expanded.names };
    });
}
