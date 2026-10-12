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

function publicExport(
    root: string,
    exported: string | { default?: string; types?: string } | undefined,
    name: string,
): string {
    const target = typeof exported === "string" ? exported : exported?.default;
    if (!target?.startsWith("./"))
        throw new Error(`pi-subagents lacks its public ${name} export.`);
    const file = realpathSync(resolve(root, target));
    const distance = relative(root, file);
    if (distance.startsWith("..") || isAbsolute(distance))
        throw new Error(
            `pi-subagents ${name} export escapes its package root.`,
        );
    return file;
}

/** Resolve the configured runtime package, including a local candidate. A bare import could select the old npm copy. */
export async function resolveSubagentPackage(
    cwd: string,
    agentDir = getAgentDir(),
    projectTrusted = isProjectConfigTrusted(cwd, agentDir),
): Promise<{ root: string; preflight: string; agents?: string }> {
    const packages = new Map<string, { preflight: string; agents?: string }>();
    await forEachConfiguredPackage(
        { cwd, agentDir, includeProject: projectTrusted },
        ({ packageRoot, pkg }) => {
            if (pkg?.name !== "pi-subagents") return;
            const root = realpathSync(packageRoot);
            const exports = pkg.exports;
            const exported =
                exports && typeof exports === "object" ? exports : {};
            const preflight = publicExport(
                root,
                exported["./preflight"],
                "preflight",
            );
            const agents =
                exported["./agents"] === undefined
                    ? undefined
                    : publicExport(root, exported["./agents"], "agents");
            packages.set(root, { preflight, agents });
        },
    );
    if (packages.size !== 1)
        throw new Error(
            `Expected one configured pi-subagents package, found ${packages.size}.`,
        );
    for (const [root, api] of packages) return { root, ...api };
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

export type {
    ToolSelectionRequest,
    ToolSelectionResult,
} from "pi-subagents/agents";

/** Read the same effective selections used by native launches from the configured package. */
export async function discoverSubagents(
    cwd: string,
    options: {
        projectTrusted: boolean;
        scope?: import("pi-subagents/agents").AgentScope;
    },
): Promise<import("pi-subagents/agents").AgentDiscoveryResult> {
    const pkg = await resolveSubagentPackage(
        cwd,
        getAgentDir(),
        options.projectTrusted,
    );
    if (!pkg.agents)
        throw new Error("pi-subagents lacks its public agents export.");
    // oxlint-disable-next-line typescript/no-unsafe-assignment -- A variable URL selects the configured public export with its installed API type.
    const api: typeof import("pi-subagents/agents") = await import(
        pathToFileURL(pkg.agents).href
    );
    return api.discoverAgents(cwd, options.scope ?? "both", undefined, {
        projectTrusted: options.projectTrusted,
    });
}
