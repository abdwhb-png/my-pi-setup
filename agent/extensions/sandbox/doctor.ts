import {
    accessSync,
    constants,
    existsSync,
    realpathSync,
    statSync,
} from "node:fs";
import { delimiter, join, matchesGlob, resolve, sep } from "node:path";
import type { SandboxExecutionContextV1 } from "../_shared/sandbox-runtime/execution-context.ts";
import { formatShellPolicy } from "./capabilities/runtime.ts";
import type { LoadSandboxConfigResult } from "./index.ts";
import {
    buildShellPath,
    expandShellPathEntry,
    SHELL_SYSTEM_READ_PATHS,
} from "./runtime/shell-baseline.ts";

function list(values: readonly string[]): string {
    return values.join(", ") || "(none)";
}
function contains(root: string, target: string): boolean {
    return (
        target === root ||
        target.startsWith(root.endsWith(sep) ? root : root + sep)
    );
}

/** Read-only inspection. Never start a command or print environment values. */
export function sandboxDoctor(
    resolved: LoadSandboxConfigResult,
    executable?: string,
    context?: SandboxExecutionContextV1,
): string {
    const { config, shell } = resolved;
    const path = buildShellPath(config.environment.path);
    const normalize = (value: string) =>
        resolve(shell.projectRoot, expandShellPathEntry(value));
    const lines = [
        "Sandbox doctor",
        formatShellPolicy(shell),
        `Global authority: ${shell.authorityPath}`,
        `Project configuration: ${join(shell.projectRoot, ".pi/sandbox.json")} (${existsSync(join(shell.projectRoot, ".pi/sandbox.json")) ? "present" : "absent"})`,
        `Source: ${resolved.source}`,
        `Host authorization: ${shell.hostAllowed ? "allowed, explicit session selection required" : "unavailable (global host.allowed is false)"}`,
        `PATH: ${path}`,
        `Configured environment keys: ${list(Object.keys(config.environment.variables))} (values hidden)`,
        `System read baseline: ${list(SHELL_SYSTEM_READ_PATHS)}`,
        `Configured read: ${list(config.filesystem.allowRead)}`,
        `Configured write: ${list(config.filesystem.allowWrite)}`,
        `Configured read denials: ${list(config.filesystem.denyRead)}`,
        `Configured write denials: ${list(config.filesystem.denyWrite)}`,
        "Zerobox metadata defaults: .git: follows explicit filesystem rules; .agents and .codex: protected unless explicitly writable.",
        "Fixed restrictions: private HOME, protected global sandbox.json and lease storage, /mnt/c writes blocked. Host mode bypasses shell restrictions.",
        `Unix socket grants: ${list(config.resources?.unixSockets ?? [])}`,
        `TCP publications: ${config.resources?.tcpPublications.length ?? 0}`,
        `Docker: ${config.docker.mode}`,
    ];
    if (context) {
        lines.push(
            "Admitted runtime filesystem (private lease paths are aliases):",
        );
        for (const [name, values] of Object.entries(context.filesystem))
            lines.push(`  ${name}: ${list(values)}`);
    } else
        lines.push(
            "Admitted runtime policy: unavailable or differs from current configuration.",
        );
    if (executable) {
        if (/\s/.test(executable))
            throw new Error(
                "Supply one executable name or path, without arguments",
            );
        const candidates = executable.includes("/")
            ? [normalize(executable)]
            : path.split(delimiter).map((root) => join(root, executable));
        const found = candidates.find((candidate) => {
            try {
                accessSync(candidate, constants.X_OK);
                return statSync(candidate).isFile();
            } catch (error) {
                if (
                    error instanceof Error &&
                    "code" in error &&
                    ["ENOENT", "EACCES", "ENOTDIR"].includes(String(error.code))
                )
                    return false;
                throw error;
            }
        });
        if (!found)
            lines.push(`Executable unavailable on host PATH: ${executable}`);
        else {
            const real = realpathSync(found);
            const allows = [
                ...SHELL_SYSTEM_READ_PATHS,
                ...config.filesystem.allowRead,
                ...config.filesystem.allowWrite,
            ].map(normalize);
            const denies = config.filesystem.denyRead.map(normalize);
            const targets = [found, real];
            const denied = targets.some((target) =>
                denies.some(
                    (root) =>
                        contains(root, target) || matchesGlob(target, root),
                ),
            );
            const covered = targets.every((target) =>
                allows.some((root) => {
                    const realRoot = existsSync(root)
                        ? realpathSync(root)
                        : root;
                    return contains(root, target) || contains(realRoot, target);
                }),
            );
            lines.push(
                `Resolved executable: ${found}`,
                `Real path: ${real}`,
                `Configured read coverage: ${denied ? "denied" : covered ? "covered" : "missing (add a precise filesystem.allowRead grant)"}`,
            );
        }
        lines.push(
            "Read-only inspection: not executed. Interpreter, library, service and TLS readiness are not proven by path resolution.",
        );
    }
    return lines.join("\n");
}
