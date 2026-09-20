import {
    DOCKER_OPERATIONS,
    type DockerOperation,
    type DockerTargetSelector,
    type SandboxDockerPolicy,
} from "./policy-contracts.ts";

/** Safe display metadata for the active runtime. Contains no Engine endpoint or credentials. */
export interface DockerAccessSummary {
    mode: "off" | "targeted" | "full";
    profile: string;
    targets: {
        selector: string;
        profile: string;
        operations: string[];
        requestedProfile?: string;
        requestedOperations?: string[];
        boundedInspection?: boolean;
        hostAccessException: boolean;
    }[];
    hostAccessException: boolean;
    boundedInspection?: boolean;
    breakGlass?: {
        containerId: string;
        expiresAtMs: number;
    }[];
}

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
