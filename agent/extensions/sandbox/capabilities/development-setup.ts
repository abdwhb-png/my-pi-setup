import {
    existsSync,
    readFileSync,
    mkdirSync,
    lstatSync,
    realpathSync,
} from "node:fs";
import { join, isAbsolute } from "node:path";
import { validatePiSandboxConfig } from "../runtime/policies.ts";
import {
    assertSandboxConfigMigrated,
    localMachineId,
    readGlobalSandboxConfig,
    persistedCapabilityPath,
    sandboxConfigPath,
    canonicalProjectPath,
    expandCapabilityPath,
} from "./authority.ts";
import { publishConfigFile } from "./config-publication.ts";
import {
    validateGlobalInstallations,
    parseGlobalInstallations,
    selectInstallations,
    installationReadPaths,
    installationContains,
} from "./installations.ts";
import { resolveShellPolicy } from "./policy.ts";
import { withSandboxPublicationLockSync } from "./publication-lock.ts";

function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Expected a configuration object");
    return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
    for (const key of Object.keys(value))
        if (!allowed.includes(key))
            throw new Error(`Unsupported profile field: ${key}`);
}
function pathList(value: unknown): string[] {
    if (!Array.isArray(value)) throw new Error("Expected a path list");
    return value.map((item: unknown) => {
        if (typeof item !== "string") throw new Error("Expected a string path");
        return item;
    });
}
function safePath(value: string): string {
    if (!isAbsolute(value) && value !== "~" && !value.startsWith("~/"))
        throw new Error("Paths must be absolute or home-relative");
    const canonical = canonicalProjectPath(value, process.cwd());
    // Do not silently redirect an authorized path through a host symlink.
    const expanded = expandCapabilityPath(value);
    if (canonical !== expanded.replace(/\/$/, ""))
        throw new Error(
            `Redirected path requires explicit authorization: ${value}`,
        );
    return canonical;
}
export interface DevelopmentSetup {
    agentDir: string;
    machineId: string;
    path: string;
    before?: Buffer;
    next: Record<string, unknown>;
    directories: string[];
    unavailable: { name: string; reason: string }[];
}
export function prepareDevelopmentSetup(options: {
    agentDir: string;
    profile: unknown;
    bindings?: unknown;
    machineId?: string;
}): DevelopmentSetup {
    const machineId = options.machineId ?? localMachineId();
    const path = sandboxConfigPath(options.agentDir);
    assertSandboxConfigMigrated(options.agentDir);
    readGlobalSandboxConfig(path, machineId);
    const before = existsSync(path) ? readFileSync(path) : undefined;
    const parsed: unknown = before
        ? JSON.parse(before.toString())
        : { version: 2, machineId };
    const next = object(parsed);
    const profile = object(options.profile);
    keys(profile, ["environment", "filesystem"]);
    const env = object(profile.environment ?? {});
    keys(env, ["installations", "variables"]);
    const fs = object(profile.filesystem ?? {});
    keys(fs, ["allowWrite"]);
    const declarations = validateGlobalInstallations(env.installations);
    const bindings = object(options.bindings ?? {});
    keys(bindings, ["environment"]);
    const bindingEnv = object(bindings.environment ?? {});
    keys(bindingEnv, ["installations"]);
    const overrides = validateGlobalInstallations(bindingEnv.installations);
    for (const name of Object.keys(overrides)) {
        if (!Object.hasOwn(declarations, name))
            throw new Error(`Unknown installation binding: ${name}`);
        declarations[name] = overrides[name];
    }
    const unavailable: DevelopmentSetup["unavailable"] = [];
    const ready: typeof declarations = {};
    for (const [name, roots] of Object.entries(declarations)) {
        const absent = roots.some(
            (entry) =>
                !existsSync(entry.root) ||
                entry.files?.some(
                    (file) => !existsSync(join(entry.root, file)),
                ),
        );
        if (absent) {
            unavailable.push({
                name,
                reason: "Installation resource is missing",
            });
            continue;
        }
        Object.assign(ready, parseGlobalInstallations({ [name]: roots }, true));
    }
    // Check symlink coverage across the whole selected set, not each root separately.
    selectInstallations(ready, undefined, undefined);
    const variables = object(env.variables ?? {});
    for (const [name, value] of Object.entries(variables))
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== "string")
            throw new Error("Invalid environment variable");
    const rawDirectories = fs.allowWrite ?? [];
    if (
        !Array.isArray(rawDirectories) ||
        rawDirectories.some((value) => typeof value !== "string")
    )
        throw new Error("allowWrite must be a path list");
    const directories = rawDirectories.map((value) => safePath(value));
    const oldEnv = object(next.environment ?? {});
    const oldFs = object(next.filesystem ?? {});
    const oldInstallations = object(oldEnv.installations ?? {});
    // An unavailable replacement must not leave an old declaration appearing configured.
    const installations = { ...oldInstallations };
    for (const name of Object.keys(declarations)) delete installations[name];
    Object.assign(
        installations,
        Object.fromEntries(
            Object.entries(ready).map(([name, roots]) => [
                name,
                roots.map((root) => ({
                    ...root,
                    root: persistedCapabilityPath(root.root),
                })),
            ]),
        ),
    );
    for (const roots of Object.values(
        parseGlobalInstallations(installations),
    )) {
        for (const entry of roots) {
            for (const resource of installationReadPaths(entry)) {
                if (
                    directories.some(
                        (dir) =>
                            installationContains(dir, resource) ||
                            (entry.files === undefined &&
                                installationContains(resource, dir)),
                    )
                ) {
                    throw new Error(
                        "Writable caches cannot overlap read-only host installations",
                    );
                }
            }
        }
    }
    next.environment = {
        ...oldEnv,
        installations,
        variables: { ...object(oldEnv.variables ?? {}), ...variables },
    };
    next.filesystem = {
        ...oldFs,
        allowWrite: [
            ...new Set([
                ...pathList(oldFs.allowWrite ?? ["."]),
                ...directories.map(persistedCapabilityPath),
            ]),
        ],
    };
    return {
        agentDir: options.agentDir,
        machineId,
        path,
        before,
        next,
        directories,
        unavailable,
    };
}
export function applyDevelopmentSetup(prepared: DevelopmentSetup): boolean {
    return withSandboxPublicationLockSync(prepared.path, () => {
        assertSandboxConfigMigrated(prepared.agentDir);
        readGlobalSandboxConfig(prepared.path, prepared.machineId);
        // Recheck authority before creating persistent directories.
        const current = existsSync(prepared.path)
            ? readFileSync(prepared.path)
            : undefined;
        if (
            prepared.before === undefined
                ? current !== undefined
                : !current?.equals(prepared.before)
        )
            throw new Error("Configuration changed after preview");
        for (const dir of prepared.directories) {
            safePath(dir);
            mkdirSync(dir, { recursive: true, mode: 0o700 });
            if (
                !lstatSync(dir).isDirectory() ||
                realpathSync(dir) !== dir ||
                lstatSync(dir).uid !== process.getuid?.() ||
                (lstatSync(dir).mode & 0o022) !== 0
            )
                throw new Error("Untrusted cache directory");
        }
        return publishConfigFile(
            prepared.path,
            prepared.before,
            prepared.next,
            {
                backup: true,
                validate: (temporary) => {
                    const config = readGlobalSandboxConfig(
                        temporary,
                        prepared.machineId,
                    )!;
                    resolveShellPolicy({
                        cwd: process.cwd(),
                        baseline: validatePiSandboxConfig({}),
                        global: config,
                        authorityPath: prepared.path,
                    });
                },
            },
        );
    });
}
