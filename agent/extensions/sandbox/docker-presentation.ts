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

/** Window before expiry during which the widget counts down per second. */
export const BREAK_GLASS_COUNTDOWN_WINDOW_MS = 30_000;

/**
 * Format the time left on a break-glass grant, or undefined when it is over.
 * Above the countdown window the remaining time is expressed in minutes;
 * inside it the value updates every second.
 */
export function formatBreakGlassRemaining(
    expiresAtMs: number,
    nowMs = Date.now(),
): string | undefined {
    const remaining = expiresAtMs - nowMs;
    if (!Number.isFinite(remaining) || remaining <= 0) return undefined;
    if (remaining > BREAK_GLASS_COUNTDOWN_WINDOW_MS)
        return `${Math.ceil(remaining / 60_000)}m`;
    return `${Math.ceil(remaining / 1_000)}s`;
}

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
    let profile = "None";
    if (profiles.size === 1) profile = targets[0].profile;
    else if (targets.length > 0) profile = "Mixed";
    return {
        mode: "targeted",
        profile,
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
    let savedLine = "Docker grant saved, not active: Sandbox is disabled.";
    if (failure) {
        savedLine = `Docker grant saved; activation failed: ${failure}`;
    } else if (active?.mode === "off") {
        savedLine =
            "Docker grant saved; Docker access is off in the active configuration.";
    } else if (active) {
        savedLine = "Docker grant saved and active for this project.";
    }
    return [
        savedLine,
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
    let differenceNote: string[] = [];
    if (persistentDifference) {
        differenceNote = [
            "Active Docker differs from the current configuration. Run /sandbox on to apply it.",
        ];
    } else if (breakGlassActive) {
        differenceNote = [
            "The active runtime differs from the saved grant only while this temporary authorization remains active.",
        ];
    }
    return [
        ...formatDockerSummary("Active Docker", active),
        ...(breakGlassActive
            ? [
                  "Active Docker includes a temporary session-only break-glass authorization.",
              ]
            : []),
        ...differenceNote,
    ];
}
