import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import type { ExtensionAPI, ToolInfo } from "@earendil-works/pi-coding-agent";
import {
    registerRequiredChildExtensions,
    resolveSubagentPackage,
    type RequiredChildExtension,
    type RequiredChildExtensionRegistration,
} from "../_shared/subagents/index.ts";
import { fromToolGroupAlias } from "../_shared/tool-groups/types.ts";

/** Use the registered owner of each global tool, including overrides of built-ins. */
export function collectToolProviders(
    tools: readonly Pick<ToolInfo, "name" | "sourceInfo">[],
    subagentsRoot: string,
): RequiredChildExtension[] {
    const providers = new Map<string, Set<string>>();
    const canonicalPaths = new Map<string, string>();
    for (const tool of tools) {
        if (fromToolGroupAlias(tool.name) !== undefined) continue;
        const source = tool.sourceInfo;
        if (source.scope !== "user" || !isAbsolute(source.path)) continue;
        let file = canonicalPaths.get(source.path);
        if (!file) {
            file = realpathSync(source.path);
            if (!statSync(file).isFile())
                throw new Error(`Tool provider is not a file: ${source.path}`);
            canonicalPaths.set(source.path, file);
        }
        const distance = relative(subagentsRoot, file);
        if (
            distance === "" ||
            (!isAbsolute(distance) &&
                distance !== ".." &&
                !distance.startsWith(`..${sep}`))
        )
            continue;
        const names = providers.get(file) ?? new Set<string>();
        names.add(tool.name);
        providers.set(file, names);
    }
    return [...providers]
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([path, names]) => ({
            id: `global-tools.${createHash("sha256").update(path).digest("hex")}`,
            path,
            whenTools: [...names].toSorted(),
        }));
}

export function registerGlobalToolProviders(pi: ExtensionAPI): void {
    let registration: RequiredChildExtensionRegistration | undefined;
    let generation = 0;
    pi.on("session_start", async (_event, ctx) => {
        const current = ++generation;
        registration?.dispose();
        registration = undefined;
        const { root } = await resolveSubagentPackage(ctx.cwd);
        if (current !== generation) return;
        registration = registerRequiredChildExtensions({
            sessionId: ctx.sessionManager.getSessionId(),
            extensions: () => collectToolProviders(pi.getAllTools(), root),
        });
    });
    pi.on("session_shutdown", () => {
        generation++;
        registration?.dispose();
        registration = undefined;
    });
}
