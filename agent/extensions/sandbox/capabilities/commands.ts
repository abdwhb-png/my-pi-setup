import { realpathSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { validatePiSandboxConfig } from "../runtime/policies.ts";
import { approvedExecutable, discoverIntegration } from "./adapters.ts";
import {
    capabilityAuthorityPath,
    CapabilityError,
    emptyGrants,
    expandCapabilityPath,
    HOST_CAPABILITIES,
    parseShellProfile,
    readCapabilityAuthority,
    saveProjectCapabilities,
    type ProjectCapabilities,
    type ShellProfile,
} from "./authority.ts";
import type { ShellCapabilityResolution } from "./policy.ts";
import { activeShellOperations, formatShellPolicy } from "./runtime.ts";

export type CapabilityCommandContext = Pick<
    ExtensionContext,
    "cwd" | "hasUI" | "isProjectTrusted"
> & {
    ui: Pick<ExtensionContext["ui"], "notify" | "confirm" | "input" | "select">;
};
export interface CapabilityCommandOptions<C extends CapabilityCommandContext> {
    agentDir: string;
    machineId: string;
    load(
        ctx: C,
        session?: ProjectCapabilities,
        profile?: ShellProfile,
    ): ShellCapabilityResolution;
    apply(
        ctx: C,
        session?: ProjectCapabilities,
        profile?: ShellProfile,
    ): Promise<void>;
}
const HELP =
    "Use /sandbox profile isolated|integrated|host, or /sandbox capabilities [grant|revoke editor|dependencies|dev-services|network|host-network|read-path|write-path|tmp|host] [--session]. Use /sandbox capabilities migrate to review existing settings.";
const CUSTOM_EDITOR_LAUNCHER = "Choose another installed editor launcher path";

export function createCapabilityCommands<
    C extends CapabilityCommandContext = CapabilityCommandContext,
>(options: CapabilityCommandOptions<C>) {
    let session: ProjectCapabilities | undefined;
    const authorityPath = capabilityAuthorityPath(options.agentDir);
    const savedProject = (ctx: C): ProjectCapabilities => {
        const root = realpathSync(ctx.cwd);
        const authority = readCapabilityAuthority(
            authorityPath,
            options.machineId,
        );
        const existing =
            authority.machineId === options.machineId
                ? authority.projects.find((p) => p.projectRoot === root)
                : undefined;
        return structuredClone(
            session?.projectRoot === root
                ? session
                : (existing ?? {
                      projectRoot: root,
                      profile: "isolated",
                      grants: emptyGrants(),
                  }),
        );
    };
    return {
        async handle(args: string, ctx: C): Promise<boolean> {
            const tokens = args.trim().split(/\s+/);
            const temporary = tokens.at(-1) === "--session";
            const words = temporary ? tokens.slice(0, -1) : tokens;
            const legacyOn = words[0] === "on";
            const legacyOff = words[0] === "off";
            if (
                !["profile", "capabilities"].includes(words[0]) &&
                !legacyOn &&
                !legacyOff
            )
                return false;
            try {
                const maxWords =
                    words[0] === "profile"
                        ? 2
                        : legacyOn || legacyOff
                          ? 1
                          : ["grant", "revoke"].includes(words[1])
                            ? 3
                            : 2;
                if (words.length > maxWords || words.includes("--session"))
                    throw new CapabilityError("unsupported-command", HELP);
                if (
                    words[0] === "capabilities" &&
                    (!words[1] || words[1] === "list")
                ) {
                    const policy = options.load(ctx, session);
                    ctx.ui.notify(
                        [
                            formatShellPolicy(policy),
                            `Authority: ${authorityPath}`,
                            ...HOST_CAPABILITIES.map((name) => {
                                const available = discoverIntegration(
                                    name,
                                    ctx.cwd,
                                );
                                return `${name}: installed launchers ${Object.keys(available).join(", ") || "not found"}; grant ${policy.grants.integrations[name] ? "present" : "absent"}`;
                            }),
                            ...activeShellOperations().map(
                                (op) =>
                                    `Already admitted #${op.id}: ${op.profile}${op.capability ? ` / ${op.capability}` : ""}. Continues until completion or explicit cancellation.`,
                            ),
                            HELP,
                        ].join("\n"),
                        "info",
                    );
                    return true;
                }
                if (!ctx.hasUI)
                    throw new CapabilityError(
                        "authorization-required",
                        "Grant changes require an interactive user decision. Existing grants remain usable.",
                    );
                const restriction =
                    legacyOn ||
                    (words[0] === "profile" && words[1] === "isolated") ||
                    (words[0] === "capabilities" && words[1] === "revoke");
                if (!restriction && !ctx.isProjectTrusted())
                    throw new CapabilityError(
                        "authorization-required",
                        "Trust the project before granting local capabilities. Trust alone does not grant access.",
                    );
                const current = options.load(ctx, session);
                if (
                    ["migration-required", "machine-mismatch"].includes(
                        current.state,
                    ) &&
                    words[1] !== "migrate"
                ) {
                    throw new CapabilityError(
                        "migration-required",
                        "Review existing settings once with /sandbox capabilities migrate before changing this project's rights.",
                    );
                }
                const next = savedProject(ctx);
                let approvalRequired = false;
                let migration = false;
                if (words[0] === "profile" || legacyOn || legacyOff) {
                    next.profile = parseShellProfile(
                        legacyOn ? "isolated" : legacyOff ? "host" : words[1],
                    );
                    if (next.profile === "host" && !next.grants.host) {
                        next.grants.host = true;
                        approvalRequired = true;
                    }
                } else if (words[1] === "migrate") {
                    migration = true;
                    const choice = await ctx.ui.select(
                        `Migrate this project's shell policy${
                            current.state === "machine-mismatch"
                                ? temporary
                                    ? " (foreign authority remains unchanged)"
                                    : " (foreign grants will be archived; no other project is activated)"
                                : ""
                        }`,
                        [
                            "Use isolated defaults (no network, private /tmp)",
                            "Retain the listed legacy openings on this machine",
                            "Cancel",
                        ].map((label, index) =>
                            index === 1
                                ? `${label}: ${JSON.stringify(current.requestedGrants)}`
                                : label,
                        ),
                    );
                    if (!choice || choice === "Cancel") return true;
                    if (choice.startsWith("Retain")) {
                        next.grants = structuredClone(current.requestedGrants);
                        next.profile = next.grants.host ? "host" : "integrated";
                    } else {
                        next.grants = emptyGrants();
                        next.profile = "isolated";
                    }
                    // The selection is the single explicit migration decision.
                } else if (words[1] === "grant" || words[1] === "revoke") {
                    const grant = words[1] === "grant";
                    const name = words[2];
                    approvalRequired = grant;
                    if (grant && next.profile === "isolated")
                        next.profile = "integrated";
                    if (HOST_CAPABILITIES.some((value) => value === name)) {
                        const capability = HOST_CAPABILITIES.find(
                            (value) => value === name,
                        )!;
                        if (!grant) delete next.grants.integrations[capability];
                        else {
                            const executables = discoverIntegration(
                                capability,
                                ctx.cwd,
                            );
                            if (capability === "editor") {
                                const discovered = new Map(
                                    Object.entries(executables).map(
                                        ([editorName, path]) => [
                                            `${editorName}: ${path}`,
                                            path,
                                        ],
                                    ),
                                );
                                const selection = await ctx.ui.select(
                                    "Choose the local editor launcher for this project",
                                    [
                                        ...discovered.keys(),
                                        CUSTOM_EDITOR_LAUNCHER,
                                    ],
                                );
                                if (!selection) return true;
                                let selectedPath = discovered.get(selection);
                                if (selection === CUSTOM_EDITOR_LAUNCHER) {
                                    const input = await ctx.ui.input(
                                        "Approved editor launcher",
                                        "Absolute or home-relative path to an installed launcher",
                                    );
                                    if (!input?.trim()) return true;
                                    selectedPath = input.trim();
                                }
                                if (!selectedPath)
                                    throw new CapabilityError(
                                        "integration-unavailable",
                                        "Select one of the discovered editor launchers or enter its installed path",
                                    );
                                next.grants.integrations.editor = {
                                    launcher: approvedExecutable(
                                        selectedPath,
                                        next.projectRoot,
                                        "editor launcher",
                                    ),
                                };
                            } else {
                                const required =
                                    capability === "dependencies"
                                        ? ["sfw", "npm"]
                                        : ["dev-services"];
                                for (const executable of required) {
                                    if (!executables[executable])
                                        throw new CapabilityError(
                                            "integration-unavailable",
                                            `${executable} was not found in installed host tools. Install/configure it from the host first; no installation was attempted.`,
                                        );
                                }
                                next.grants.integrations[capability] =
                                    executables;
                            }
                        }
                    } else if (name === "tmp") next.grants.hostTmp = grant;
                    else if (name === "host") {
                        next.grants.host = grant;
                        if (!grant && next.profile === "host")
                            next.profile = "isolated";
                    } else if (
                        [
                            "network",
                            "host-network",
                            "read-path",
                            "write-path",
                        ].includes(name)
                    ) {
                        const field =
                            name === "network"
                                ? "domains"
                                : name === "host-network"
                                  ? "hostDomains"
                                  : name === "read-path"
                                    ? "readPaths"
                                    : "writePaths";
                        if (!grant) next.grants[field] = [];
                        else {
                            const value = await ctx.ui.input(
                                `Grant ${name} for ${next.projectRoot}`,
                                name.includes("network")
                                    ? "One domain, optionally with a port"
                                    : "One existing absolute or home-relative directory",
                            );
                            if (!value?.trim()) return true;
                            const item = name.includes("network")
                                ? value.trim()
                                : realpathSync(
                                      expandCapabilityPath(value.trim()),
                                  );
                            if (name.includes("network"))
                                validatePiSandboxConfig({
                                    network:
                                        name === "network"
                                            ? { allowedDomains: [item] }
                                            : { allowedHostDomains: [item] },
                                });
                            next.grants[field] = [
                                ...new Set([...next.grants[field], item]),
                            ];
                        }
                    } else
                        throw new CapabilityError("unsupported-command", HELP);
                } else throw new CapabilityError("unsupported-command", HELP);
                if (
                    approvalRequired &&
                    !(await ctx.ui.confirm(
                        "Approve local shell capabilities",
                        [
                            `Project: ${next.projectRoot}`,
                            `Scope: ${temporary ? "this session" : "this project on this machine"}`,
                            `Profile: ${next.profile}`,
                            JSON.stringify(next.grants, null, 2),
                            "Host execution has the user's authority. Dev Services commands and dependency code may execute on the host. Command permissions remain applicable.",
                        ].join("\n"),
                    ))
                )
                    return true;
                if (temporary) session = next;
                else {
                    const archive = await saveProjectCapabilities(
                        authorityPath,
                        next,
                        options.machineId,
                        { replaceForeign: migration },
                    );
                    if (archive)
                        ctx.ui.notify(
                            `Previous machine's authority preserved at ${archive}`,
                            "info",
                        );
                    session = undefined;
                }
                await options.apply(ctx, session, next.profile);
                const outcome = migration
                    ? temporary
                        ? current.state === "machine-mismatch"
                            ? "Migration applied for this session. Foreign authority remains unchanged"
                            : "Migration applied for this session. Persistent authority remains unchanged"
                        : "Migration saved"
                    : temporary
                      ? "Shell capabilities updated for this session"
                      : "Shell capabilities updated";
                ctx.ui.notify(
                    `${outcome}. New commands use the new policy. Already admitted operations continue.`,
                    "info",
                );
            } catch (error) {
                ctx.ui.notify(
                    error instanceof Error ? error.message : String(error),
                    "error",
                );
            }
            return true;
        },
        session: (): ProjectCapabilities | undefined => session,
        reset: (): void => {
            session = undefined;
        },
    };
}
