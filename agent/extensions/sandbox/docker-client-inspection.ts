import { join } from "node:path";
import { parseSandboxExecutionContext } from "../_shared/sandbox-runtime/execution-context.ts";
import {
    inspectSandboxExecutable,
    type SandboxExecutableEnvironment,
    type SandboxExecutableInspection,
} from "./executable-inspection.ts";

export interface DockerClientInspection {
    admission: "pending" | "admitted";
    cli: SandboxExecutableInspection;
    compose: SandboxExecutableInspection;
}

function inspect(
    environment: SandboxExecutableEnvironment,
    executable: string,
): SandboxExecutableInspection {
    try {
        return inspectSandboxExecutable(environment, executable);
    } catch (error) {
        return {
            state: "unknown",
            issues: [
                `Static executable inspection failed: ${error instanceof Error ? error.message : String(error)}`,
            ],
        };
    }
}

/** Standard Linux plugin discovery only; no client or daemon execution. */
export function inspectDockerClients(
    environment: SandboxExecutableEnvironment,
): DockerClientInspection {
    const parsed = parseSandboxExecutionContext(environment.context);
    const context = parsed?.version === 3 ? parsed : undefined;
    const cli = inspect(environment, "docker");
    let compose: SandboxExecutableInspection;
    if (environment.config.environment.variables.DOCKER_CONFIG !== undefined) {
        compose = {
            state: "unknown",
            issues: [
                "Custom DOCKER_CONFIG plugin discovery is not inspected; verify docker compose version in the sandbox.",
            ],
        };
    } else {
        const candidates = [
            join(
                context?.home.path ?? "/home/sandbox",
                ".docker/cli-plugins/docker-compose",
            ),
            "/usr/local/lib/docker/cli-plugins/docker-compose",
            "/usr/local/libexec/docker/cli-plugins/docker-compose",
            "/usr/lib/docker/cli-plugins/docker-compose",
            "/usr/libexec/docker/cli-plugins/docker-compose",
        ].map((path) => inspect(environment, path));
        compose = candidates.find(
            (candidate) => candidate.state === "exposed",
        ) ??
            candidates.find(
                (candidate) => candidate.state !== "unavailable",
            ) ?? {
                state: "unavailable",
                issues: [
                    "Compose plugin is unavailable in the standard sandbox plugin directories.",
                ],
            };
    }
    return { admission: context ? "admitted" : "pending", cli, compose };
}

export function dockerClientWidgetLabel(
    inspection?: DockerClientInspection,
): string {
    if (inspection?.admission !== "admitted") return "client check pending";
    if (inspection.cli.state === "unknown") return "CLI not verified";
    if (inspection.cli.state !== "exposed") return "CLI unavailable";
    if (inspection.compose.state === "unknown")
        return "CLI exposed · Compose not verified";
    if (inspection.compose.state !== "exposed")
        return "CLI exposed · Compose unavailable";
    return "CLI exposed · Compose exposed";
}

export function formatDockerClientInspection(
    inspection?: DockerClientInspection,
): string[] {
    if (!inspection)
        return [
            "Docker client check: pending admission. Run /sandbox doctor docker for planned inspection.",
        ];
    const phase =
        inspection.admission === "admitted"
            ? "admitted scope"
            : "planned inspection";
    return [
        `Docker CLI: ${inspection.cli.state} (${phase})`,
        ...(inspection.cli.path
            ? [
                  `  Executable: ${inspection.cli.path}`,
                  `  Canonical target: ${inspection.cli.realPath}`,
              ]
            : []),
        ...inspection.cli.issues.map((issue) => `  ${issue}`),
        `Docker Compose: ${inspection.compose.state} (${phase}; standard plugin directories)`,
        ...(inspection.compose.path
            ? [
                  `  Plugin: ${inspection.compose.path}`,
                  `  Canonical target: ${inspection.compose.realPath}`,
              ]
            : []),
        ...inspection.compose.issues.map((issue) => `  ${issue}`),
        ...([inspection.cli, inspection.compose].some(
            (client) =>
                client.state !== "exposed" && client.state !== "unknown",
        )
            ? [
                  "Docker permission does not expose the client executable or Compose plugin. Authorize their discoverable paths, canonical targets and dependencies explicitly.",
              ]
            : []),
        "Static inspection does not prove client execution, custom plugin discovery or daemon readiness. This inspection executes no commands and changes no permissions.",
    ];
}
