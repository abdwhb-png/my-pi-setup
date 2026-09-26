import { registerSubagentToolSelectionTransformer } from "pi-subagents/tool-selection";
import { resolveToolAliases } from "../_shared/tool-groups/resolver.ts";

export function registerToolGroupChildSelection(
    groups: Record<string, string[]>,
    registeredNames: () => string[],
): () => void {
    return registerSubagentToolSelectionTransformer({
        name: "tool-groups",
        resolve({ tools }) {
            const selectors = [...(tools ?? [])];
            if (!selectors.some((name) => name.startsWith("@")))
                return selectors;
            const available = [
                ...new Set(
                    [
                        ...registeredNames(),
                        ...Object.values(groups).flat(),
                        ...selectors,
                    ].filter(
                        (name) =>
                            !name.startsWith("@") &&
                            !name.includes("*") &&
                            !name.includes("?"),
                    ),
                ),
            ];
            const result = resolveToolAliases(selectors, available, groups);
            if (result.diagnostics.length > 0) {
                throw new Error(
                    `Child tool selection failed: ${result.diagnostics.map(({ code, member }) => `${code}: ${member}`).join(", ")}`,
                );
            }
            return result.names;
        },
    });
}
