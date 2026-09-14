import { homedir } from "node:os";
import { posix } from "node:path";
import {
    parseSandboxExecutionContext,
    type SandboxExecutionContext,
} from "../sandbox-runtime/execution-context.ts";

function absoluteDisplayPath(value: string): string | undefined {
    if (value === "~") return homedir();
    if (value.startsWith("~/")) return posix.join(homedir(), value.slice(2));
    return value.startsWith("/") ? value : undefined;
}

function contains(root: string, path: string): boolean {
    return root === "/" || path === root || path.startsWith(`${root}/`);
}

/** Interpret only known, complete error lines; never probe the host filesystem. */
export function sandboxPathDiagnostic(
    output: string,
    value: SandboxExecutionContext | undefined,
): string | undefined {
    const context = parseSandboxExecutionContext(value);
    if (context?.version !== 3 || context.profile !== "bash-general")
        return undefined;
    const roots = [
        ...context.mounts.map((mount) => mount.destination),
        // Virtual kernel filesystems are not ordinary host read grants.
        ...context.kernelMounts
            .filter(
                (mount) =>
                    mount.filesystem !== "tmpfs" && mount.destination !== "/",
            )
            .map((mount) => mount.destination),
        context.home.path,
        context.tmp.path,
    ].flatMap((path) => absoluteDisplayPath(path) ?? []);
    const aliases = (context.pathAliases ?? []).flatMap(
        (alias) => absoluteDisplayPath(alias.destination) ?? [],
    );
    const paths = new Set<string>();
    for (const line of output.split("\n")) {
        const path =
            /^(?:\/[^\s:]+\/)?bash: line \d+: cd: (\/[^\r\n]+): No such file or directory$/.exec(
                line,
            )?.[1] ??
            /^Error: Cannot find module '(\/[^'\r\n]+)'$/.exec(line)?.[1];
        // Normalizing '..' can cross a symlink, so leave ambiguous paths alone.
        if (
            !path ||
            /[\x00-\x1f\x7f]/.test(path) ||
            posix.normalize(path) !== path
        )
            continue;
        if (roots.some((root) => contains(root, path) || contains(path, root)))
            continue;
        // An alias needs traversal semantics. Do not infer absence from its lexical spelling.
        if (
            aliases.some(
                (alias) => contains(alias, path) || contains(path, alias),
            )
        )
            continue;
        paths.add(path);
        if (paths.size === 3) break;
    }
    if (!paths.size) return undefined;
    return (
        [...paths]
            .map(
                (path) =>
                    `Sandbox: ${path} is outside the admitted read scope.`,
            )
            .join("\n") +
        "\nIts existence on the host cannot be determined from this error. Authorize read access explicitly before retrying this path in the sandbox."
    );
}
