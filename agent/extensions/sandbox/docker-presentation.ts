import type { DockerAccessSummary } from "../_shared/sandbox-runtime/docker-summary.ts";
import {
    DOCKER_OPERATIONS,
    type DockerOperation,
    type DockerTargetSelector,
    type SandboxDockerPolicy,
} from "./runtime/contracts.ts";

export const DOCKER_ACCESS_PROFILES: ReadonlyArray<{
    label: string;
    operations: DockerOperation[];
}> = [
    {
        label: "Exploitation",
        operations: [
            "ps",
            "inspect",
            "logs",
            "stats",
            "start",
            "stop",
            "restart",
        ],
    },
    { label: "Observation", operations: ["ps", "inspect", "logs", "stats"] },
    { label: "Administration", operations: [...DOCKER_OPERATIONS] },
];

export function dockerSelectorLabel(selector: DockerTargetSelector): string {
    if (selector.type === "compose-service")
        return `compose-service: ${selector.project} / ${selector.service}`;
    if (selector.type === "container-name")
        return `container-name: ${selector.name}`;
    return `container-id: ${selector.id}`;
}

export function summarizeDockerAccess(
    policy: SandboxDockerPolicy,
    nowMs = Date.now(),
): DockerAccessSummary {
    if (policy.mode !== "targeted")
        return {
            mode: policy.mode === "disabled" ? "off" : "full",
            profile: policy.mode === "disabled" ? "None" : "Full",
            targets: [],
            hostAccessException: false,
        };
    const breakGlass = policy.targets
        .filter(
            (target) =>
                target.selector.type === "ephemeral-container" &&
                target.selector.unsafeExecExpiresAtMs > nowMs,
        )
        .map((target) => ({
            containerId:
                target.selector.type === "ephemeral-container"
                    ? target.selector.id
                    : "",
            expiresAtMs:
                target.selector.type === "ephemeral-container"
                    ? target.selector.unsafeExecExpiresAtMs
                    : 0,
        }));
    const targets = policy.targets
        .filter((target) => target.selector.type !== "ephemeral-container")
        .map((target) => {
            const requestedOperations = DOCKER_OPERATIONS.filter((operation) =>
                (target.operations ?? DOCKER_OPERATIONS).includes(operation),
            );
            const requestedProfile =
                DOCKER_ACCESS_PROFILES.find(
                    (candidate) =>
                        candidate.operations.length ===
                            requestedOperations.length &&
                        candidate.operations.every((operation) =>
                            requestedOperations.includes(operation),
                        ),
                )?.label ?? "Custom";
            const boundedInspection =
                target.allowUnsafeTarget &&
                requestedOperations.includes("exec");
            const operations = boundedInspection
                ? requestedOperations.filter(
                      (operation) => operation !== "exec",
                  )
                : requestedOperations;
            const profile =
                DOCKER_ACCESS_PROFILES.find(
                    (candidate) =>
                        candidate.operations.length === operations.length &&
                        candidate.operations.every((operation) =>
                            operations.includes(operation),
                        ),
                )?.label ?? "Custom";
            const summary: DockerAccessSummary["targets"][number] = {
                selector: dockerSelectorLabel(target.selector),
                profile,
                operations,
                hostAccessException: target.allowUnsafeTarget,
            };
            if (requestedProfile !== profile) {
                summary.requestedProfile = requestedProfile;
                summary.requestedOperations = requestedOperations;
            }
            if (boundedInspection) summary.boundedInspection = true;
            return summary;
        })
        .toSorted((a, b) => a.selector.localeCompare(b.selector));
    const profiles = new Set(targets.map((target) => target.profile));
    return {
        mode: "targeted",
        profile:
            profiles.size === 1
                ? targets[0].profile
                : targets.length
                  ? "Mixed"
                  : "None",
        targets,
        hostAccessException: targets.some(
            (target) => target.hostAccessException,
        ),
        boundedInspection: targets.some(
            (target) => target.boundedInspection === true,
        ),
        ...(breakGlass.length > 0 ? { breakGlass } : {}),
    };
}

export function dockerSummaryLabel(summary: DockerAccessSummary): string {
    if (summary.mode !== "targeted") return summary.mode;
    return `targeted · ${summary.profile}${summary.boundedInspection ? " + inspection" : ""} · ${summary.targets.length} target${summary.targets.length === 1 ? "" : "s"}${summary.hostAccessException ? " · host-access exception" : ""}${summary.breakGlass?.length ? " · break-glass exec" : ""}`;
}

export function formatDockerSummary(
    title: string,
    summary: DockerAccessSummary,
): string[] {
    return [
        `${title}: ${dockerSummaryLabel(summary)}`,
        ...summary.targets.flatMap((target) => [
            `  ${target.selector} — ${target.profile}`,
            ...(target.requestedProfile
                ? [`  Requested profile: ${target.requestedProfile}`]
                : []),
            `  Operations: ${target.operations.join(", ") || "none"}`,
            ...(target.boundedInspection
                ? [
                      "  Arbitrary exec: unavailable; read-only inspection: test -r, stat, ls",
                  ]
                : []),
            `  Host-access exception: ${target.hostAccessException ? "enabled by the confirmed grant" : "off"}`,
        ]),
        ...(summary.breakGlass ?? []).map(
            (entry) =>
                `  Break-glass exec: container ${entry.containerId} until ${new Date(entry.expiresAtMs).toISOString()}`,
        ),
    ];
}

export function formatDockerGrantResult(
    saved: DockerAccessSummary,
    active?: DockerAccessSummary,
    failure?: string,
): string {
    return [
        failure
            ? `Docker grant saved; activation failed: ${failure}`
            : active?.mode === "off"
              ? "Docker grant saved; Docker access is off in the active configuration."
              : active
                ? "Docker grant saved and active for this project."
                : "Docker grant saved, not active: Sandbox is disabled.",
        ...formatDockerSummary("Saved Docker grant", saved),
        ...(active ? formatDockerSummary("Active Docker", active) : []),
        ...(active && JSON.stringify(saved) !== JSON.stringify(active)
            ? [
                  "The effective configuration differs from the saved grant. Check project restrictions with /sandbox doctor.",
              ]
            : []),
    ].join("\n");
}

export function formatActiveDocker(
    configured: DockerAccessSummary,
    active: DockerAccessSummary | undefined,
    state: string,
): string[] {
    if (!active)
        return [
            `Runtime: ${state}${state === "enabled" ? " (Docker summary unavailable; reload Sandbox)" : ""}`,
        ];
    const breakGlassActive = Boolean(active.breakGlass?.length);
    const persistentActive: DockerAccessSummary = { ...active };
    delete persistentActive.breakGlass;
    const persistentDifference =
        JSON.stringify(configured) !== JSON.stringify(persistentActive);
    return [
        ...formatDockerSummary("Active Docker", active),
        ...(breakGlassActive
            ? [
                  "Active Docker includes a temporary session-only break-glass authorization.",
              ]
            : []),
        ...(persistentDifference
            ? [
                  "Active Docker differs from the current configuration. Run /sandbox on to apply it.",
              ]
            : breakGlassActive
              ? [
                    "The active runtime differs from the saved grant only while this temporary authorization remains active.",
                ]
              : []),
    ];
}
