import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import {
    parseSandboxExecutionContext,
    type SandboxExecutionContext,
    type SandboxExecutionContextV3,
} from "../_shared/sandbox-runtime/execution-context.ts";
import { shellPolicyLines } from "./capabilities/runtime.ts";
import {
    inspectDockerClients,
    dockerClientInspectionLines,
    type SandboxDiagnosticLine,
    type DockerClientInspection,
} from "./docker-client-inspection.ts";
import {
    inspectSandboxExecutable,
    type SandboxExecutableInspection,
} from "./executable-inspection.ts";
import type { LoadSandboxConfigResult } from "./index.ts";
import type { PrivateRuntimeBundle } from "./runtime/runtime-bundle.ts";
import {
    buildShellPath,
    expandShellPathEntry,
} from "./runtime/shell-baseline.ts";

function list(values: readonly string[]): string {
    return values.join(", ") || "(none)";
}

export interface SandboxDoctorInspection {
    resolved: LoadSandboxConfigResult;
    admitted?: SandboxExecutionContextV3;
    runtime?: PrivateRuntimeBundle;
    runtimeProblem?: string;
    path: string;
    projectConfig: { path: string; present: boolean };
    dockerClients?: DockerClientInspection;
    executable?: { name: string; inspection: SandboxExecutableInspection };
}

/** Read-only inspection. Never start a command or print environment values. */
export function inspectSandboxDoctor(
    resolved: LoadSandboxConfigResult,
    executable?: string,
    context?: SandboxExecutionContext,
    runtime?: PrivateRuntimeBundle,
): SandboxDoctorInspection {
    const { config, shell } = resolved;
    const parsed = parseSandboxExecutionContext(context);
    const admitted = parsed?.version === 3 ? parsed : undefined;
    const path =
        admitted?.environment.path.map(expandShellPathEntry).join(delimiter) ??
        buildShellPath(config.environment.path);
    const projectPath = join(shell.projectRoot, ".pi/sandbox.json");
    return {
        resolved,
        admitted,
        runtime,
        path,
        projectConfig: { path: projectPath, present: existsSync(projectPath) },
        dockerClients:
            config.docker.mode !== "disabled" &&
            shell.mode === "sandbox" &&
            config.enabled
                ? inspectDockerClients({
                      config,
                      cwd: shell.projectRoot,
                      context: admitted,
                      runtime,
                  })
                : undefined,
        executable: executable
            ? {
                  name: executable,
                  inspection: inspectSandboxExecutable(
                      {
                          config,
                          cwd: shell.projectRoot,
                          context: admitted,
                          runtime,
                      },
                      executable,
                  ),
              }
            : undefined,
    };
}

export function sandboxDoctor(
    resolved: LoadSandboxConfigResult,
    executable?: string,
    context?: SandboxExecutionContext,
    runtime?: PrivateRuntimeBundle,
): string {
    return formatSandboxDoctor(
        inspectSandboxDoctor(resolved, executable, context, runtime),
    );
}

export function sandboxDoctorLines(
    report: SandboxDoctorInspection,
): SandboxDiagnosticLine[] {
    const { resolved, admitted, runtime, path } = report;
    const { config, shell } = resolved;
    const lines: SandboxDiagnosticLine[] = [
        "Sandbox doctor",
        ...shellPolicyLines(shell),
        { label: "Global authority", value: shell.authorityPath },
        {
            label: "Project configuration",
            value: `${report.projectConfig.path} (${report.projectConfig.present ? "present" : "absent"})`,
        },
        { label: "Source", value: resolved.source },
        {
            label: "Host authorization",
            value: shell.hostAllowed
                ? "allowed, explicit session selection required"
                : "unavailable (global host.allowed is false)",
        },
        { label: "PATH", value: path },
        {
            label: "Configured environment keys",
            value: `${list(Object.keys(config.environment.variables))} (values hidden)`,
        },
        {
            label: "Runtime policy",
            value: admitted ? "admitted" : "planned, awaiting engine admission",
        },
        {
            label: "Private runtime",
            value:
                admitted?.runtime.version ?? runtime?.version ?? "not verified",
        },
        { label: "Configured read", value: list(config.filesystem.allowRead) },
        {
            label: "Configured write",
            value: list(config.filesystem.allowWrite),
        },
        {
            label: "Configured read denials",
            value: list(config.filesystem.denyRead),
        },
        {
            label: "Configured write denials",
            value: list(config.filesystem.denyWrite),
        },
        {
            label: "Configured direct TCP",
            value: config.network.mediatedDirectTcp.enabled
                ? list(config.network.mediatedDirectTcp.ports.map(String))
                : "(off)",
        },
        "Zerobox metadata defaults: .git: follows explicit filesystem rules; .agents and .codex: protected unless explicitly writable.",
        "Fixed restrictions: private HOME, protected global sandbox.json and lease storage, /mnt/c writes blocked. Host mode bypasses shell restrictions.",
        {
            label: "Unix socket grants",
            value: list(config.resources?.unixSockets ?? []),
        },
        {
            label: "TCP publications",
            value: `${config.resources?.tcpPublications.length ?? 0}`,
        },
        { label: "Docker", value: config.docker.mode },
        ...(report.dockerClients
            ? dockerClientInspectionLines(report.dockerClients)
            : []),
    ];
    if (admitted) {
        lines.push({
            label: "Admitted direct TCP",
            value: admitted.network.mediatedDirectTcp
                ? list(admitted.network.mediatedDirectTcp.ports.map(String))
                : "(off)",
        });
        lines.push(
            "Admitted runtime filesystem (private lease paths are aliases):",
        );
        for (const [name, values] of Object.entries(admitted.filesystem))
            lines.push({ label: `  ${name}`, value: list(values) });
    } else
        lines.push(
            "Admitted runtime policy: unavailable or differs from current configuration.",
        );
    if (report.executable) {
        const { inspection } = report.executable;
        if (inspection.path)
            lines.push(
                { label: "Resolved executable", value: inspection.path },
                { label: "Real path", value: `${inspection.realPath}` },
                { label: "Command source", value: `${inspection.source}` },
                {
                    label: "Configured read coverage",
                    value: `${inspection.coverage === "missing" ? "missing (authorize an installation or add a precise filesystem.allowRead grant)" : inspection.coverage}`,
                },
            );
        lines.push(...inspection.issues);
        lines.push(
            "Read-only inspection: not executed. Static dependency inspection does not prove dynamic loading, service or TLS readiness.",
        );
    }
    if (report.runtimeProblem)
        lines.push({
            label: "Runtime verification failed",
            value: report.runtimeProblem,
        });
    return lines;
}

export function formatSandboxDoctor(report: SandboxDoctorInspection): string {
    return sandboxDoctorLines(report)
        .map((line) =>
            typeof line === "string" ? line : `${line.label}: ${line.value}`,
        )
        .join("\n");
}
