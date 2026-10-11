import { realpathSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
    registerSubagentCapabilityCeiling,
    resolveCurrentSubagentCapabilityCeiling,
} from "pi-subagents/capability-ceiling";
import type {
    SubagentLaunchContractInput,
    SubagentLaunchContractResult,
} from "pi-subagents/preflight";
import { isProjectConfigTrusted } from "../config-loader.ts";
import { forEachConfiguredPackage } from "../package-install/configured-packages.ts";

export type Restriction = Parameters<
    typeof registerSubagentCapabilityCeiling
>[0]["ceiling"];
export type RestrictionHandle = ReturnType<
    typeof registerSubagentCapabilityCeiling
>;
export type ExtensionBindings = NonNullable<
    SubagentLaunchContractInput["extensionBindings"]
>;
export const restrictSubagents = registerSubagentCapabilityCeiling;
export const currentSubagentRestriction =
    resolveCurrentSubagentCapabilityCeiling;

/** pi-subagents keys persisted owners by file, falling back to the in-memory UUID. */
export function subagentSessionKey(
    sessionId?: string,
    sessionFile?: string,
): string {
    const key = sessionFile ?? sessionId;
    if (!key?.trim())
        throw new Error(
            "Subagent runtime did not provide a trusted session identity.",
        );
    return key;
}

/** Resolve the configured runtime package, including a local candidate. A bare import could select the old npm copy. */
export async function resolveSubagentPackage(
    cwd: string,
    agentDir = getAgentDir(),
    projectTrusted = isProjectConfigTrusted(cwd, agentDir),
): Promise<{ root: string; preflight: string }> {
    const packages = new Map<string, string>();
    await forEachConfiguredPackage(
        { cwd, agentDir, includeProject: projectTrusted },
        ({ packageRoot, pkg }) => {
            if (pkg?.name !== "pi-subagents") return;
            const root = realpathSync(packageRoot);
            const exports = pkg.exports;
            const exported =
                typeof exports === "object"
                    ? exports["./preflight"]
                    : undefined;
            const target =
                typeof exported === "string"
                    ? exported
                    : typeof exported === "object"
                      ? exported.default
                      : undefined;
            if (typeof target !== "string" || !target.startsWith("./"))
                throw new Error(
                    "pi-subagents lacks its public preflight export.",
                );
            const preflight = realpathSync(resolve(root, target));
            const distance = relative(root, preflight);
            if (distance.startsWith("..") || isAbsolute(distance))
                throw new Error(
                    "pi-subagents export escapes its package root.",
                );
            packages.set(root, preflight);
        },
    );
    if (packages.size !== 1)
        throw new Error(
            `Expected one configured pi-subagents package, found ${packages.size}.`,
        );
    for (const [root, preflight] of packages) return { root, preflight };
    throw new Error("Configured pi-subagents package disappeared.");
}

export async function preflightSubagent(
    input: SubagentLaunchContractInput,
    options: { agentDir?: string; projectTrusted?: boolean } = {},
): Promise<SubagentLaunchContractResult> {
    const agentDir = options.agentDir ?? getAgentDir();
    const projectTrusted =
        options.projectTrusted ??
        input.projectTrusted ??
        isProjectConfigTrusted(input.cwd, agentDir);
    const pkg = await resolveSubagentPackage(
        input.cwd,
        agentDir,
        projectTrusted,
    );
    // oxlint-disable-next-line typescript/no-unsafe-assignment -- A variable URL selects the configured public export with its installed API type.
    const api: typeof import("pi-subagents/preflight") = await import(
        pathToFileURL(pkg.preflight).href
    );
    return api.resolveSubagentLaunchContract({ ...input, projectTrusted });
}
