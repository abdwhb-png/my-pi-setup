import {
    constants,
    accessSync,
    existsSync,
    realpathSync,
    statSync,
} from "node:fs";
import {
    basename,
    delimiter,
    dirname,
    extname,
    isAbsolute,
    join,
    resolve,
} from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { PreparedBashSpawn } from "../../_shared/command-execution/exec.ts";
import { hostExecution } from "../../_shared/execution-provenance/types.ts";
import {
    CapabilityError,
    expandCapabilityPath,
    isCapabilityError,
    type HostCapability,
} from "./authority.ts";
import type { ShellCapabilityResolution } from "./policy.ts";

export const EDITOR_LAUNCHER_NAMES = [
    "zed",
    "code",
    "cursor",
    "codium",
    "windsurf",
    "subl",
    "idea",
    "webstorm",
    "phpstorm",
    "pycharm",
    "fleet",
] as const;

function unsupported(message: string): never {
    throw new CapabilityError("unsupported-command", message);
}
/** Parse only literal argv. Never evaluate a shell to obtain arguments. */
export function parseLiteralCommand(command: string): string[] {
    const args: string[] = [];
    let quote: "'" | '"' | undefined;
    let current = "";
    let started = false;
    for (let i = 0; i < command.length; i++) {
        const char = command[i];
        if (char === "\0" || char === "\n" || char === "\r")
            unsupported("Use one literal command per integration call");
        if (quote === "'") {
            if (char === "'") quote = undefined;
            else current += char;
        } else if (char === "$" || char === "`") {
            unsupported(
                "Shell expansions are not supported by host integrations",
            );
        } else if (char === "\\") {
            const next = command[++i];
            if (
                next === undefined ||
                next === "\n" ||
                next === "\r" ||
                next === "\0"
            )
                unsupported("Invalid escape");
            // Match Bash double-quote escaping rather than silently changing an argument.
            current +=
                quote === '"' && !['"', "\\", "$", "`"].includes(next)
                    ? `\\${next}`
                    : next;
            started = true;
        } else if (quote === '"') {
            if (char === '"') quote = undefined;
            else current += char;
        } else if (char === "'" || char === '"') {
            quote = char;
            started = true;
        } else if (/\s/.test(char)) {
            if (started) {
                args.push(current);
                current = "";
                started = false;
            }
        } else if (/[|&;<>()[\]{}*?~#]/.test(char)) {
            unsupported(
                "Pipelines, redirections, expansions and compositions require sandbox execution or an explicitly selected host profile",
            );
        } else {
            current += char;
            started = true;
        }
    }
    if (quote) unsupported("Unclosed quotation");
    if (started) args.push(current);
    if (!args.length || !args[0] || /^[A-Za-z_][A-Za-z_0-9]*=/.test(args[0]))
        unsupported("Expected a literal executable and arguments");
    return args;
}
function inside(path: string, root: string): boolean {
    return path === root || path.startsWith(`${root}/`);
}
export function approvedExecutable(
    configured: string | undefined,
    projectRoot: string,
    name: string,
): string {
    if (!configured)
        throw new CapabilityError(
            "integration-unavailable",
            `${name} is not configured. Use /sandbox capabilities grant to select its installed launcher.`,
        );
    try {
        const path = realpathSync(expandCapabilityPath(configured));
        if (inside(path, projectRoot))
            throw new CapabilityError(
                "integration-unavailable",
                `${name} resolves inside the project; select its installed host launcher`,
            );
        if (!statSync(path).isFile()) throw new Error("Not a file");
        accessSync(path, constants.X_OK);
        return path;
    } catch (error) {
        if (isCapabilityError(error)) throw error;
        throw new CapabilityError(
            "integration-unavailable",
            `${name} is unavailable at its approved path`,
        );
    }
}
/** Read-only discovery. No version command, updater, GUI, or network probe is launched. */
export function discoverIntegration(
    name: HostCapability,
    cwd: string,
    searchPath = process.env.PATH ?? "",
): Record<string, string> {
    const project = realpathSync(cwd);
    const names =
        name === "editor"
            ? EDITOR_LAUNCHER_NAMES
            : name === "dependencies"
              ? ["sfw", "npm", "pi"]
              : ["dev-services"];
    const found: Record<string, string> = {};
    for (const executable of names) {
        for (const directory of searchPath.split(delimiter)) {
            if (
                !isAbsolute(directory) ||
                directory.includes("node_modules/.bin")
            )
                continue;
            const candidate = join(directory, executable);
            if (!existsSync(candidate)) continue;
            try {
                found[executable] = approvedExecutable(
                    candidate,
                    project,
                    executable,
                );
                break;
            } catch (error) {
                if (!isCapabilityError(error)) throw error;
            }
        }
    }
    return found;
}
export function prepareHostIntegration(
    policy: ShellCapabilityResolution,
    capability: HostCapability,
    command: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
): PreparedBashSpawn {
    const configured = policy.grants.integrations[capability];
    if (!configured)
        throw new CapabilityError(
            "authorization-required",
            `No ${capability} grant`,
        );
    const argv = parseLiteralCommand(command);
    const executable = (name: string) =>
        approvedExecutable(configured[name], policy.projectRoot, name);
    let file: string;
    let args: string[];
    if (capability === "editor") {
        const editorLauncher = approvedExecutable(
            configured.launcher ?? configured.zed,
            policy.projectRoot,
            "editor launcher",
        );
        const launcherBasename = basename(
            editorLauncher,
            extname(editorLauncher),
        );
        const requestedCommand = argv.shift();
        const acceptedCommands = new Set(["editor", launcherBasename]);
        if (configured.zed) acceptedCommands.add("zed");
        if (!requestedCommand || !acceptedCommands.has(requestedCommand))
            unsupported("Use: editor <project-file> [project-file ...]");
        if (!argv.length) unsupported("Provide at least one project file");
        args = argv.map((value) => {
            if (value.startsWith("-"))
                unsupported(
                    "Editor flags are not supported; pass project files",
                );
            try {
                const path = realpathSync(resolve(cwd, value));
                if (
                    !inside(path, policy.projectRoot) ||
                    !statSync(path).isFile()
                )
                    return unsupported(
                        "The editor may open existing files inside the approved project only",
                    );
                return path;
            } catch {
                return unsupported(
                    "The editor may open existing files inside the approved project only",
                );
            }
        });
        file = editorLauncher;
    } else if (capability === "dependencies") {
        if (argv[0] === "sfw") argv.shift();
        const manager = argv.shift();
        if (manager !== "npm" && manager !== "pi")
            unsupported(
                "This integration supports npm and npm-sourced Pi packages. No unprotected fallback was executed.",
            );
        const verb = argv[0];
        if (manager === "npm") {
            if (
                !["install", "ci", "update", "uninstall", "remove"].includes(
                    verb,
                )
            )
                unsupported(
                    "Use an npm dependency operation, not npm exec or npm run",
                );
            const flags = new Set([
                "-D",
                "--save-dev",
                "-E",
                "--save-exact",
                "-O",
                "--save-optional",
                "-P",
                "--save-prod",
                "--no-save",
                "--package-lock-only",
                "--no-audit",
                "--no-fund",
                "--legacy-peer-deps",
            ]);
            if (
                argv
                    .slice(1)
                    .some((arg) => arg.startsWith("-") && !flags.has(arg))
            )
                unsupported(
                    "Unsupported npm option. Use dependency names with --save-dev, --save-exact, --save-optional, --save-prod, --no-save, --package-lock-only, --no-audit, --no-fund or --legacy-peer-deps. Global routing and lifecycle overrides are unavailable in this integration.",
                );
            args = [executable("npm"), ...argv, "--ignore-scripts"];
        } else {
            if (
                !["install", "update", "remove"].includes(verb) ||
                argv.length !== 2 ||
                !argv[1].startsWith("npm:")
            )
                unsupported(
                    "Use: pi install|update|remove npm:<package-source>",
                );
            const agentRoot = realpathSync(dirname(getAgentDir()));
            if (
                policy.projectRoot !== agentRoot &&
                policy.projectRoot !== realpathSync(getAgentDir())
            )
                throw new CapabilityError(
                    "authorization-required",
                    "Manage global Pi packages from the Pi project with its own local grant",
                );
            args = [executable("pi"), ...argv];
        }
        file = executable("sfw");
    } else {
        if (argv[0] === "dev-services" || argv[0] === "./bin/dev")
            unsupported(
                "Pass the target command directly, for example npm test, with hostCapability dev-services",
            );
        file = executable("dev-services");
        args = ["--path", policy.projectRoot, "run", ...argv];
    }
    const executionEnv = { ...env };
    executionEnv.PATH = (env.PATH ?? process.env.PATH ?? "")
        .split(delimiter)
        .filter((directory) => {
            if (
                !isAbsolute(directory) ||
                directory.includes("node_modules/.bin")
            )
                return false;
            try {
                return !inside(realpathSync(directory), policy.projectRoot);
            } catch {
                return false;
            }
        })
        .join(delimiter);
    // Host adapters must not inherit a stale sandbox proxy or bypass SFW updates.
    for (const key of Object.keys(executionEnv))
        if (
            /^(?:ZEROBOX_|SFW_SKIP_UPDATE_CHECK$|NODE_OPTIONS$|BUN_OPTIONS$|BASH_ENV$|ENV$)/.test(
                key,
            )
        )
            delete executionEnv[key];
    if (capability === "dependencies")
        executionEnv.npm_config_ignore_scripts = "true";
    return {
        file,
        args,
        cwd,
        env: executionEnv,
        extraStdio: [],
        execution: {
            ...hostExecution("process"),
            shellProfile: policy.profile,
            hostCapability: capability,
            outcome: "pending",
        },
        supervise: () => ({
            ready: Promise.resolve(),
            settled: Promise.resolve(),
        }),
    };
}
