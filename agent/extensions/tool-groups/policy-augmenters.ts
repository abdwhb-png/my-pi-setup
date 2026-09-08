export type ToolPolicyAugmenter = () => readonly string[];

export const TOOL_POLICY_REFRESH_EVENT = "pi-tool-groups:policy-refresh";

interface ToolPolicyAugmenterRegistry {
    augmenters: Map<string, ToolPolicyAugmenter>;
}

const REGISTRY_KEY = Symbol.for("pi.tool-groups.policy-augmenters.v1");

function getRegistry(): ToolPolicyAugmenterRegistry {
    const root = globalThis as typeof globalThis & {
        [REGISTRY_KEY]?: ToolPolicyAugmenterRegistry;
    };
    return (root[REGISTRY_KEY] ??= { augmenters: new Map() });
}

export function registerToolPolicyAugmenter(
    source: string,
    augmenter: ToolPolicyAugmenter,
): () => void {
    if (!source.trim()) throw new Error("Policy augmenter source is required");
    const registry = getRegistry();
    registry.augmenters.set(source, augmenter);
    return () => {
        if (registry.augmenters.get(source) === augmenter) {
            registry.augmenters.delete(source);
        }
    };
}

export function collectToolPolicyAugmentations(): string[] {
    const names: string[] = [];
    const seen = new Set<string>();
    for (const augmenter of getRegistry().augmenters.values()) {
        for (const name of augmenter()) {
            if (!name || seen.has(name)) continue;
            seen.add(name);
            names.push(name);
        }
    }
    return names;
}
