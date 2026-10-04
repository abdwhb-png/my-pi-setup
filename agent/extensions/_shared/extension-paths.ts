import { isAbsolute, resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export type ExtensionScope =
    | { scope: "global"; agentDir?: string }
    | { scope: "project"; cwd: string };
export type ExtensionArea = "config" | "artifacts" | "plans" | "session-plans";

/** Resolve owned storage only. Resource discovery and core files retain Pi's paths. */
export function extensionPath(
    scope: ExtensionScope,
    area: ExtensionArea,
    ...segments: string[]
): string {
    if (
        segments.some(
            (part) =>
                isAbsolute(part) ||
                part.split(/[\\/]/).some((segment) => segment === ".."),
        )
    ) {
        throw new Error(
            "Extension paths must be relative and cannot traverse parents",
        );
    }
    const planning = area === "plans" || area === "session-plans";
    if (planning && scope.scope !== "project")
        throw new Error("Planning storage requires a project cwd");
    const base =
        scope.scope === "global"
            ? (scope.agentDir ?? getAgentDir())
            : resolve(scope.cwd, CONFIG_DIR_NAME);
    return resolve(
        base,
        ...(planning ? ["planning", area] : [area]),
        ...segments,
    );
}
