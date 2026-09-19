import {
    accessSync,
    constants,
    existsSync,
    readFileSync,
    realpathSync,
    statSync,
} from "node:fs";
import { delimiter, dirname, join, matchesGlob, resolve, sep } from "node:path";
import {
    parseSandboxExecutionContext,
    type SandboxExecutionContext,
} from "../_shared/sandbox-runtime/execution-context.ts";
import { installationReadPaths } from "./capabilities/installations.ts";
import type { PiSandboxConfig } from "./runtime/policies.ts";
import type { PrivateRuntimeBundle } from "./runtime/runtime-bundle.ts";
import {
    buildShellPath,
    expandShellPathEntry,
    PRIVATE_SHELL_ROOT,
} from "./runtime/shell-baseline.ts";

export interface SandboxExecutableEnvironment {
    config: PiSandboxConfig;
    cwd: string;
    context?: SandboxExecutionContext;
    runtime?: PrivateRuntimeBundle;
}

export interface SandboxExecutableInspection {
    state:
        | "exposed"
        | "unavailable"
        | "inaccessible"
        | "dependency-inaccessible"
        | "unknown";
    path?: string;
    realPath?: string;
    source?: string;
    coverage?: "covered" | "denied" | "missing";
    issues: string[];
}

function contains(root: string, target: string): boolean {
    return (
        target === root ||
        target.startsWith(root.endsWith(sep) ? root : root + sep)
    );
}

/** Inspect file metadata and admission scope; never execute a discovered tool. */
export function inspectSandboxExecutable(
    environment: SandboxExecutableEnvironment,
    executable: string,
): SandboxExecutableInspection {
    const { config, cwd, runtime } = environment;
    const parsed = parseSandboxExecutionContext(environment.context);
    const admitted = parsed?.version === 3 ? parsed : undefined;
    const path =
        admitted?.environment.path.map(expandShellPathEntry).join(delimiter) ??
        buildShellPath(config.environment.path);
    const normalize = (value: string) =>
        resolve(cwd, expandShellPathEntry(value));
    const physical = (value: string): string => {
        const mount = admitted?.mounts
            .map((m) => ({
                ...m,
                source: expandShellPathEntry(m.source),
                destination: expandShellPathEntry(m.destination),
            }))
            .filter((m) => contains(m.destination, value))
            .sort((a, b) => b.destination.length - a.destination.length)[0];
        if (mount && !mount.source.includes("<"))
            return join(mount.source, value.slice(mount.destination.length));
        if (runtime && contains(PRIVATE_SHELL_ROOT, value))
            return join(
                runtime.components.shell.root,
                value.slice(PRIVATE_SHELL_ROOT.length),
            );
        return value;
    };
    const filesystem = admitted?.filesystem ?? config.filesystem;
    const allows = [...filesystem.allowRead, ...filesystem.allowWrite]
        .filter((value) => !value.startsWith("<"))
        .map(normalize);
    const denies = [
        ...filesystem.denyRead,
        ...(admitted?.filesystem.denyReadGlobs ?? []),
    ]
        .filter((value) => !value.startsWith("<"))
        .map(normalize);
    const coverage = (value: string): "denied" | "covered" | "missing" => {
        const file = physical(value);
        if (!existsSync(file)) return "missing";
        const targets = [value, realpathSync(file)];
        if (
            targets.some((target) =>
                denies.some(
                    (root) =>
                        contains(root, target) || matchesGlob(target, root),
                ),
            )
        )
            return "denied";
        if (
            contains(PRIVATE_SHELL_ROOT, value) &&
            ((runtime &&
                contains(runtime.components.shell.root, realpathSync(file))) ||
                admitted?.mounts.some(
                    (m) =>
                        contains(expandShellPathEntry(m.destination), value) &&
                        m.origin === "runtime",
                ))
        )
            return "covered";
        return targets.every((target) =>
            allows.some(
                (root) =>
                    contains(root, target) ||
                    (existsSync(root) && contains(realpathSync(root), target)),
            ),
        )
            ? "covered"
            : "missing";
    };
    if (/\s/.test(executable))
        throw new Error(
            "Supply one executable name or path, without arguments",
        );
    const candidates = executable.includes("/")
        ? [normalize(executable)]
        : path.split(delimiter).map((root) => join(root, executable));
    let blocked: SandboxExecutableInspection | undefined;
    for (const candidate of candidates) {
        try {
            accessSync(physical(candidate), constants.X_OK);
            if (!statSync(physical(candidate)).isFile()) continue;
        } catch (error) {
            if (
                error instanceof Error &&
                "code" in error &&
                ["ENOENT", "EACCES", "ENOTDIR"].includes(String(error.code))
            )
                continue;
            throw error;
        }
        const real = realpathSync(physical(candidate));
        const access = coverage(candidate);
        const installation = config.environment.installations?.find((item) =>
            item.roots.some((root) =>
                installationReadPaths(root).some((resource) => {
                    const path = expandShellPathEntry(resource);
                    return root.files === undefined
                        ? contains(path, real)
                        : path === real || path === candidate;
                }),
            ),
        );
        const result: SandboxExecutableInspection = {
            state: access === "covered" ? "exposed" : "inaccessible",
            path: candidate,
            realPath: real,
            coverage: access,
            source: contains(PRIVATE_SHELL_ROOT, candidate)
                ? "private runtime"
                : installation
                  ? `authorized installation ${installation.name}`
                  : "explicit filesystem configuration",
            issues: [],
        };
        if (access !== "covered") {
            result.issues.push(
                `${access === "denied" ? "Read denied" : "Read grant missing"} for executable: ${candidate}`,
            );
            if (real !== candidate && coverage(real) !== "covered")
                result.issues.push(
                    `${access === "denied" ? "Read denied" : "Read grant missing"} for executable target: ${real}`,
                );
            blocked ??= result;
            continue;
        }
        const dependencies = executableDependencies(readFileSync(real));
        for (const dependency of dependencies.absolute)
            if (coverage(dependency) !== "covered")
                result.issues.push(`Dependency inaccessible: ${dependency}`);
        for (const dependency of dependencies.libraries) {
            const directories = [
                ...dependencies.search.map((entry) =>
                    entry
                        .replaceAll("${ORIGIN}", dirname(candidate))
                        .replaceAll("$ORIGIN", dirname(candidate)),
                ),
                "/lib/x86_64-linux-gnu",
                "/usr/lib/x86_64-linux-gnu",
                "/lib64",
                "/usr/lib64",
                "/lib",
                "/usr/lib",
            ];
            if (
                !directories.some(
                    (directory) =>
                        coverage(join(directory, dependency)) === "covered",
                )
            )
                result.issues.push(`Dependency inaccessible: ${dependency}`);
        }
        if (result.issues.length) result.state = "dependency-inaccessible";
        return result;
    }
    return (
        blocked ?? {
            state: "unavailable",
            issues: [`Executable unavailable on sandbox PATH: ${executable}`],
        }
    );
}

/** Inspect file metadata only. Never use ldd or execute an untrusted installation. */
function executableDependencies(bytes: Buffer): {
    absolute: string[];
    libraries: string[];
    search: string[];
} {
    const result = {
        absolute: [] as string[],
        libraries: [] as string[],
        search: [] as string[],
    };
    if (bytes.subarray(0, 2).toString() === "#!") {
        const interpreter = bytes
            .subarray(2, 4096)
            .toString()
            .split(/\r?\n/, 1)[0]
            ?.trim()
            .split(/\s+/, 1)[0];
        if (interpreter?.startsWith("/")) result.absolute.push(interpreter);
        return result;
    }
    if (bytes.length < 64 || bytes.subarray(0, 4).toString() !== "\x7fELF")
        return result;
    if (bytes[4] !== 2 || bytes[5] !== 1)
        throw new Error(
            "Static dependency inspection supports only little-endian ELF64",
        );
    const number = (offset: number) => {
        const value = Number(bytes.readBigUInt64LE(offset));
        if (!Number.isSafeInteger(value)) throw new Error("Invalid ELF offset");
        return value;
    };
    const start = number(32),
        size = bytes.readUInt16LE(54),
        count = bytes.readUInt16LE(56);
    if (size < 56 || start + size * count > bytes.length)
        throw new Error("Invalid ELF program headers");
    const segments: Array<{
        type: number;
        offset: number;
        address: number;
        length: number;
    }> = [];
    for (let i = 0; i < count; i++) {
        const at = start + i * size;
        const segment = {
            type: bytes.readUInt32LE(at),
            offset: number(at + 8),
            address: number(at + 16),
            length: number(at + 32),
        };
        if (segment.offset + segment.length > bytes.length)
            throw new Error("Invalid ELF segment");
        segments.push(segment);
    }
    const string = (offset: number, end = bytes.length) => {
        const nul = bytes.indexOf(0, offset);
        if (offset < 0 || nul < offset || nul >= end)
            throw new Error("Invalid ELF string");
        return bytes.subarray(offset, nul).toString();
    };
    for (const segment of segments)
        if (segment.type === 3)
            result.absolute.push(
                string(segment.offset, segment.offset + segment.length),
            );
    const dynamic = segments.find((segment) => segment.type === 2);
    if (!dynamic) return result;
    let table: number | undefined;
    const needed: number[] = [];
    const paths: number[] = [];
    for (
        let at = dynamic.offset;
        at + 16 <= dynamic.offset + dynamic.length;
        at += 16
    ) {
        const tag = number(at),
            value = number(at + 8);
        if (tag === 0) break;
        if (tag === 5) table = value;
        if (tag === 1) needed.push(value);
        if (tag === 15 || tag === 29) paths.push(value);
    }
    if (table === undefined) return result;
    const load = segments.find(
        (segment) =>
            segment.type === 1 &&
            table >= segment.address &&
            table < segment.address + segment.length,
    );
    if (!load) throw new Error("Invalid ELF string table");
    const offset = load.offset + table - load.address;
    result.libraries = needed.map((value) => string(offset + value));
    result.search = paths.flatMap((value) => string(offset + value).split(":"));
    return result;
}
