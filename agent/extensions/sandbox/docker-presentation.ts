import {
    DOCKER_ACCESS_PROFILES,
    dockerSelectorLabel,
    summarizeDockerAccess,
    type DockerAccessSummary,
} from "../_shared/sandbox-runtime/docker-summary.ts";

export { DOCKER_ACCESS_PROFILES, dockerSelectorLabel, summarizeDockerAccess };

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
