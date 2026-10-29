import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import {
    extensionConfigPath,
    isProjectConfigTrusted,
} from "../_shared/config-loader.ts";
import { DOCKER_PERMISSION_GROUPS } from "../_shared/sandbox-runtime/docker-summary.ts";
import {
    assertSandboxConfigMigrated,
    readGlobalSandboxConfig,
    readProjectSandboxConfig,
    sandboxConfigPath,
} from "./capabilities/authority.ts";
import {
    previewSandboxDocuments,
    publishSandboxDocuments,
} from "./capabilities/migration.ts";
import {
    discoverDockerTargets,
    inspectDockerMetadata,
    formatDockerAccess,
} from "./docker-access.ts";
import { dockerSelectorLabel } from "./docker-presentation.ts";
import {
    DOCKER_OPERATIONS,
    type DockerOperation,
    type DockerTargetSelector,
} from "./runtime/contracts.ts";
import {
    DEFAULT_DOCKER_ENDPOINT,
    parseDockerTargetSelector,
    resolveDockerPolicy,
} from "./runtime/docker-policy.ts";

function object(value: unknown): Record<string, unknown> {
    if (value === undefined) return {};
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Expected a configuration object");
    return { ...value };
}
function list(value: unknown): unknown[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error("Expected a configuration list");
    return value;
}
function withoutSelector(values: unknown[], selector: DockerTargetSelector) {
    return values.filter(
        (value) =>
            JSON.stringify(parseDockerTargetSelector(value)) !==
            JSON.stringify(selector),
    );
}
export interface DockerGrantEdit {
    selector: DockerTargetSelector;
    operations: DockerOperation[];
    hostAccessRequired: boolean;
    hostAccess: boolean;
}
export function buildDockerUpdate<
    G extends Record<string, unknown>,
    P extends Record<string, unknown>,
>(global: G, project: P, edit: DockerGrantEdit) {
    if (edit.hostAccessRequired && !edit.hostAccess)
        throw new Error("Explicit host access approval is required");
    const g = object(global.docker),
        p = object(project.docker);
    const unsafe = list(g.unsafeTargets);
    const trusted = list(g.trustedExecTargets);
    const targets = list(p.targets).filter(
        (value) =>
            JSON.stringify(
                parseDockerTargetSelector(object(value).selector),
            ) !== JSON.stringify(edit.selector),
    );
    const next = {
        global: {
            ...global,
            docker: {
                ...g,
                allowed: true,
                unsafeTargets: [
                    ...(edit.hostAccess
                        ? withoutSelector(unsafe, edit.selector)
                        : unsafe),
                    ...(edit.hostAccess ? [edit.selector] : []),
                ],
                trustedExecTargets: [
                    ...(edit.hostAccess && edit.operations.includes("exec")
                        ? withoutSelector(trusted, edit.selector)
                        : trusted),
                    ...(edit.hostAccess && edit.operations.includes("exec")
                        ? [edit.selector]
                        : []),
                ],
            },
        },
        project: {
            ...project,
            docker: {
                ...p,
                enabled: true,
                targets: [
                    ...targets,
                    { selector: edit.selector, operations: edit.operations },
                ],
            },
        },
    };
    resolveDockerPolicy({
        globalConfig: next.global.docker,
        projectConfig: next.project.docker,
    });
    return next;
}

/** One interactive entry point owns discovery, consent, and recoverable publication. */
export async function manageDockerAccess(
    ctx: ExtensionCommandContext,
    options: {
        selector?: DockerTargetSelector;
        agentDir: string;
        machineId: string;
        onChanged(): Promise<void>;
    },
) {
    if (!ctx.hasUI)
        throw new Error("Run /sandbox docker configure interactively");
    if (
        !isProjectConfigTrusted(
            ctx.cwd,
            options.agentDir,
            ctx.isProjectTrusted(),
        )
    )
        throw new Error(
            "Use /trust and restart Pi before editing Docker access",
        );
    assertSandboxConfigMigrated(options.agentDir, ctx.cwd);
    const globalPath = sandboxConfigPath(options.agentDir);
    const projectPath = extensionConfigPath("sandbox", {
        scope: "project",
        cwd: ctx.cwd,
    });
    readGlobalSandboxConfig(globalPath, options.machineId);
    readProjectSandboxConfig(projectPath);
    const sources = previewSandboxDocuments(globalPath, projectPath);
    const globalBytes = sources[0]?.bytes;
    const projectBytes = sources[1]?.bytes;
    const global = globalBytes
        ? object(JSON.parse(globalBytes.toString("utf8")))
        : { version: 2, machineId: options.machineId };
    const project = projectBytes
        ? object(JSON.parse(projectBytes.toString("utf8")))
        : {};
    const g = object(global.docker),
        p = object(project.docker);
    if (g.mode === "full")
        throw new Error(
            "Full Docker access already grants engine control. Select targeted mode in global policy before managing individual permissions.",
        );
    const action = await ctx.ui.select("Configure Docker access", [
        "Add or edit a service",
        "Remove a project service",
        "Revoke a global host-access exception",
        "Engine information permission",
        "Cancel",
    ]);
    if (!action || action === "Cancel") return;
    let nextGlobal = global,
        nextProject = project;
    let preview: string[] = [];
    let recheck: (() => Promise<void>) | undefined;
    if (action === "Engine information permission") {
        const choice = await ctx.ui.select(
            "Engine information may reveal host identity, versions, counts, and daemon configuration.",
            [
                "Allow for this project",
                "Disable for this project",
                "Revoke globally",
                "Cancel",
            ],
        );
        if (!choice || choice === "Cancel") return;
        nextGlobal = {
            ...global,
            docker: {
                ...g,
                ...(choice === "Allow for this project"
                    ? { allowed: true, allowEngineInfo: true }
                    : choice === "Revoke globally"
                      ? { allowEngineInfo: false }
                      : {}),
            },
        };
        nextProject = {
            ...project,
            docker: {
                ...p,
                ...(choice === "Allow for this project"
                    ? { enabled: true }
                    : {}),
                engineInfo: choice === "Allow for this project",
            },
        };
        preview = [
            choice,
            "Global authorization does not activate this permission in other projects.",
        ];
    } else {
        const endpoint =
            typeof g.endpoint === "string"
                ? g.endpoint
                : DEFAULT_DOCKER_ENDPOINT;
        const selectors =
            action === "Add or edit a service"
                ? options.selector
                    ? [options.selector]
                    : await discoverDockerTargets(endpoint)
                : action === "Remove a project service"
                  ? list(p.targets).map((value) => object(value).selector)
                  : list(g.unsafeTargets);
        // Persisted selectors are validated by the real policy parser before selection.
        resolveDockerPolicy({ globalConfig: g, projectConfig: p });
        const candidates = selectors.map(parseDockerTargetSelector);
        if (!candidates.length)
            throw new Error(
                "No existing Docker services found. Creation and image builds are not supported by targeted access.",
            );
        const labels = candidates.map(dockerSelectorLabel);
        const chosen = options.selector
            ? dockerSelectorLabel(options.selector)
            : await ctx.ui.select("Choose a Docker service", [
                  ...labels,
                  "Back",
                  "Cancel",
              ]);
        if (chosen === "Back") return manageDockerAccess(ctx, options);
        const selector = candidates[labels.indexOf(chosen ?? "")];
        if (!selector) {
            if (options.selector)
                throw new Error(
                    "The selected service is no longer configured. Refresh Docker permissions.",
                );
            return;
        }
        if (action === "Remove a project service") {
            nextProject = {
                ...project,
                docker: {
                    ...p,
                    targets: list(p.targets).filter(
                        (value) =>
                            JSON.stringify(
                                parseDockerTargetSelector(
                                    object(value).selector,
                                ),
                            ) !== JSON.stringify(selector),
                    ),
                },
            };
            preview = [
                "Remove from this project: " + dockerSelectorLabel(selector),
                "Global exceptions remain unchanged.",
            ];
        } else if (action === "Revoke a global host-access exception") {
            nextGlobal = {
                ...global,
                docker: {
                    ...g,
                    unsafeTargets: withoutSelector(
                        list(g.unsafeTargets),
                        selector,
                    ),
                    trustedExecTargets: withoutSelector(
                        list(g.trustedExecTargets),
                        selector,
                    ),
                },
            };
            preview = [
                "Revoke globally: " + dockerSelectorLabel(selector),
                "This affects every project selecting this service.",
            ];
        } else {
            const operations: DockerOperation[] = [];
            const permitted = list(g.operations ?? [...DOCKER_OPERATIONS]);
            for (const [label, group] of DOCKER_PERMISSION_GROUPS) {
                const available = group.filter((operation) =>
                    permitted.includes(operation),
                );
                if (!available.length) continue;
                // oxlint-disable-next-line no-await-in-loop -- Each consent determines the next interactive prompt.
                const choice = await ctx.ui.select(
                    `${label}: ${available.join(", ")}`,
                    ["Allow", "Do not allow", "Back", "Cancel"],
                );
                if (!choice || choice === "Cancel") return;
                if (choice === "Back")
                    return manageDockerAccess(ctx, { ...options, selector });
                if (choice === "Allow") operations.push(...available);
            }
            if (!operations.length)
                throw new Error("Select at least one operation");
            const inspect = () =>
                inspectDockerMetadata({
                    mode: "targeted",
                    endpoint,
                    targets: [
                        {
                            selector,
                            operations: ["ps"],
                            allowUnsafeTarget: false,
                        },
                    ],
                });
            const access = await inspect();
            if (!access[0]?.containers.length)
                throw new Error("The selected service no longer exists");
            const requiresHost = access[0].containers.some(
                (container) =>
                    container.mounts.length > 0 || container.facts.length > 0,
            );
            const hostAccess =
                requiresHost &&
                (await ctx.ui.confirm(
                    "Approve this service's host access?",
                    formatDockerAccess(access).join("\n") +
                        "\nCommands can access the mounted host files independently of shell filesystem restrictions. Global approval also applies when other projects select this service.",
                ));
            if (requiresHost && !hostAccess) return;
            const next = buildDockerUpdate(global, project, {
                selector,
                operations,
                hostAccessRequired: requiresHost,
                hostAccess,
            });
            nextGlobal = next.global;
            nextProject = next.project;
            const fingerprint = JSON.stringify(access);
            recheck = async () => {
                if (JSON.stringify(await inspect()) !== fingerprint)
                    throw new Error(
                        "Container access changed. Inspect and approve it again.",
                    );
            };
            preview = [
                dockerSelectorLabel(selector),
                "Operations: " + operations.join(", "),
                ...(hostAccess
                    ? [
                          "Remember global host access",
                          ...(operations.includes("exec")
                              ? [
                                    "Remember arbitrary command execution until revoked",
                                ]
                              : []),
                      ]
                    : []),
                "Remember this project's target selection.",
            ];
        }
    }
    if (g.allowed !== true)
        preview.push(
            "Enable Docker globally. Other explicitly enabled projects may also regain their previously configured access.",
        );
    if (!(await ctx.ui.confirm("Save Docker permissions?", preview.join("\n"))))
        return;
    await withFileMutationQueue(globalPath, async () =>
        withFileMutationQueue(projectPath, async () => {
            if (
                !isProjectConfigTrusted(
                    ctx.cwd,
                    options.agentDir,
                    ctx.isProjectTrusted(),
                )
            )
                throw new Error("Project trust changed");
            assertSandboxConfigMigrated(options.agentDir, ctx.cwd);
            await recheck?.();
            if (
                !isProjectConfigTrusted(
                    ctx.cwd,
                    options.agentDir,
                    ctx.isProjectTrusted(),
                )
            )
                throw new Error("Project trust changed");
            publishSandboxDocuments({
                globalPath,
                projectPath,
                machineId: options.machineId,
                sources,
                globalLayer: nextGlobal,
                projectLayer: nextProject,
            });
        }),
    );
    ctx.ui.notify("Docker permissions saved. Applying runtime policy…", "info");
    await options.onChanged();
}
