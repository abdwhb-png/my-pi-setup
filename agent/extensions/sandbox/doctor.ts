import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import {
    parseSandboxExecutionContext,
    type SandboxExecutionContext,
} from "../_shared/sandbox-runtime/execution-context.ts";
import { formatShellPolicy } from "./capabilities/runtime.ts";
import {
    inspectDockerClients,
    formatDockerClientInspection,
} from "./docker-client-inspection.ts";
import { inspectSandboxExecutable } from "./executable-inspection.ts";
import type { LoadSandboxConfigResult } from "./index.ts";
import type { PrivateRuntimeBundle } from "./runtime/runtime-bundle.ts";
import {
    buildShellPath,
    expandShellPathEntry,
} from "./runtime/shell-baseline.ts";

function list(values: readonly string[]): string {
    return values.join(", ") || "(none)";
}
/** Read-only inspection. Never start a command or print environment values. */
export function sandboxDoctor(
    resolved: LoadSandboxConfigResult,
    executable?: string,
    context?: SandboxExecutionContext,
    runtime?: PrivateRuntimeBundle,
): string {
    const { config, shell } = resolved;
    const parsed = parseSandboxExecutionContext(context);
    const admitted = parsed?.version === 3 ? parsed : undefined;
    const path =
        admitted?.environment.path.map(expandShellPathEntry).join(delimiter) ??
        buildShellPath(config.environment.path);
    const lines = [
        "Sandbox doctor",
        formatShellPolicy(shell),
        `Global authority: ${shell.authorityPath}`,
        `Project configuration: ${join(shell.projectRoot, ".pi/sandbox.json")} (${existsSync(join(shell.projectRoot, ".pi/sandbox.json")) ? "present" : "absent"})`,
        `Source: ${resolved.source}`,
        `Host authorization: ${shell.hostAllowed ? "allowed, explicit session selection required" : "unavailable (global host.allowed is false)"}`,
        `PATH: ${path}`,
        `Configured environment keys: ${list(Object.keys(config.environment.variables))} (values hidden)`,
        `Runtime policy: ${admitted ? "admitted" : "planned, awaiting engine admission"}`,
        `Private runtime: ${admitted?.runtime.version ?? runtime?.version ?? "not verified"}`,
        `Configured read: ${list(config.filesystem.allowRead)}`,
        `Configured write: ${list(config.filesystem.allowWrite)}`,
        `Configured read denials: ${list(config.filesystem.denyRead)}`,
        `Configured write denials: ${list(config.filesystem.denyWrite)}`,
        `Configured direct TCP: ${config.network.mediatedDirectTcp.enabled ? list(config.network.mediatedDirectTcp.ports.map(String)) : "(off)"}`,
        "Zerobox metadata defaults: .git: follows explicit filesystem rules; .agents and .codex: protected unless explicitly writable.",
        "Fixed restrictions: private HOME, protected global sandbox.json and lease storage, /mnt/c writes blocked. Host mode bypasses shell restrictions.",
        `Unix socket grants: ${list(config.resources?.unixSockets ?? [])}`,
        `TCP publications: ${config.resources?.tcpPublications.length ?? 0}`,
        `Docker: ${config.docker.mode}`,
        ...(config.docker.mode !== "disabled" &&
        shell.mode === "sandbox" &&
        config.enabled
            ? formatDockerClientInspection(
                  inspectDockerClients({
                      config,
                      cwd: shell.projectRoot,
                      context: admitted,
                      runtime,
                  }),
              )
            : []),
    ];
    if (admitted) {
        lines.push(
            `Admitted direct TCP: ${admitted.network.mediatedDirectTcp ? list(admitted.network.mediatedDirectTcp.ports.map(String)) : "(off)"}`,
        );
        lines.push(
            "Admitted runtime filesystem (private lease paths are aliases):",
        );
        for (const [name, values] of Object.entries(admitted.filesystem))
            lines.push(`  ${name}: ${list(values)}`);
    } else
        lines.push(
            "Admitted runtime policy: unavailable or differs from current configuration.",
        );
    if (executable) {
        const inspection = inspectSandboxExecutable(
            { config, cwd: shell.projectRoot, context: admitted, runtime },
            executable,
        );
        if (inspection.path)
            lines.push(
                `Resolved executable: ${inspection.path}`,
                `Real path: ${inspection.realPath}`,
                `Command source: ${inspection.source}`,
                `Configured read coverage: ${inspection.coverage === "missing" ? "missing (authorize an installation or add a precise filesystem.allowRead grant)" : inspection.coverage}`,
            );
        lines.push(...inspection.issues);
        lines.push(
            "Read-only inspection: not executed. Static dependency inspection does not prove dynamic loading, service or TLS readiness.",
        );
    }
    return lines.join("\n");
}
