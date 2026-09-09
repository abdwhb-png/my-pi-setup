import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface PresentedTool {
    name: string;
    description?: string;
    deferred?: boolean;
}
type Presenter = (tools: readonly PresentedTool[]) => readonly string[];
const KEY = Symbol.for("pi.tool-policy.presentation.v1");
type Root = typeof globalThis & { [KEY]?: Map<string, Presenter> };
function registry(): Map<string, Presenter> {
    return ((globalThis as Root)[KEY] ??= new Map<string, Presenter>());
}

export function registerToolPresentation(
    pi: ExtensionAPI,
    source: string,
    present: Presenter,
): void {
    registry().set(source, present);
    pi.on("session_shutdown", () => {
        if (registry().get(source) === present) registry().delete(source);
    });
}
export function toolPresentation(tools: readonly PresentedTool[]): string[] {
    return [
        ...new Set(
            [...registry().entries()]
                .toSorted(([a], [b]) => a.localeCompare(b))
                .flatMap(([, present]) => present(tools)),
        ),
    ];
}
