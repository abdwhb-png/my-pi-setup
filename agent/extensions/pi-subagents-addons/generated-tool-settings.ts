import { createHash, randomUUID } from "node:crypto";
import {
    accessSync,
    chmodSync,
    constants,
    lstatSync,
    mkdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import type {
    CompiledToolOverride,
    ToolGroupCompilation,
} from "./tool-group-overrides.ts";

export interface SyncGeneratedToolSettingsOptions {
    agentDir: string;
    cwd: string;
    projectTrusted: boolean;
    compilation: ToolGroupCompilation;
    /** One-shot operator approval of exact existing values; never inferred from equality. */
    adopt?: {
        global?: Record<string, CompiledToolOverride["tools"]>;
        project?: Record<string, CompiledToolOverride["tools"]>;
    };
}

function object(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`Invalid ${label}: expected object`);
    return value as Record<string, unknown>;
}

function fingerprint(tools: unknown): string {
    return createHash("sha256")
        .update(JSON.stringify(tools) ?? "missing")
        .digest("hex");
}

interface Ownership {
    sources: string[];
    fingerprint: string;
    objectCreated: boolean;
}

function readOwnership(value: unknown): Record<string, Ownership> {
    if (value === undefined) return {};
    const ledger = object(value, "generatedToolOverrides");
    if (ledger.version !== 1)
        throw new Error("Unsupported generatedToolOverrides version");
    return Object.fromEntries(
        Object.entries(
            object(ledger.agents, "generatedToolOverrides.agents"),
        ).map(([name, raw]) => {
            const entry = object(raw, `ownership for ${name}`);
            if (
                !Array.isArray(entry.sources) ||
                !entry.sources.every(
                    (source): source is string => typeof source === "string",
                ) ||
                typeof entry.fingerprint !== "string" ||
                !/^[a-f0-9]{64}$/.test(entry.fingerprint) ||
                typeof entry.objectCreated !== "boolean"
            )
                throw new Error(`Invalid ownership for ${name}`);
            return [
                name,
                {
                    sources: entry.sources,
                    fingerprint: entry.fingerprint,
                    objectCreated: entry.objectCreated,
                },
            ];
        }),
    );
}

function readSettings(path: string): {
    bytes: string | undefined;
    mode: number;
} {
    try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink())
            throw new Error(
                `Settings must be a regular file, not a symlink: ${path}`,
            );
        accessSync(path, constants.R_OK | constants.W_OK);
        return { bytes: readFileSync(path, "utf8"), mode: stat.mode & 0o777 };
    } catch (error) {
        if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
        )
            return { bytes: undefined, mode: 0o600 };
        throw error;
    }
}

function prepareSettings(
    path: string,
    bytes: string | undefined,
    desired: Record<string, CompiledToolOverride>,
    approvals: Record<string, CompiledToolOverride["tools"]> = {},
): string | undefined {
    let raw: unknown = {};
    if (bytes !== undefined) {
        try {
            raw = JSON.parse(bytes);
        } catch {
            // Parser diagnostics can contain credentials from the source text.
            throw new Error(`Invalid settings JSON: ${path}`);
        }
    }
    const settings = object(raw, `settings ${path}`);
    const before = JSON.stringify(settings);
    const subagents =
        settings.subagents === undefined
            ? {}
            : object(settings.subagents, "subagents");
    const overrides =
        subagents.agentOverrides === undefined
            ? {}
            : object(subagents.agentOverrides, "agentOverrides");
    const metadata =
        settings.piSubagentsAddons === undefined
            ? {}
            : object(settings.piSubagentsAddons, "piSubagentsAddons");
    const owned = readOwnership(metadata.generatedToolOverrides);
    for (const [name, ownership] of Object.entries(owned)) {
        const existing = Object.hasOwn(overrides, name)
            ? object(overrides[name], `override ${name}`)
            : undefined;
        if (!existing || fingerprint(existing.tools) !== ownership.fingerprint)
            throw new Error(
                `Manual edit conflicts with generated tools: ${name}`,
            );
        if (!Object.hasOwn(desired, name)) {
            delete existing.tools;
            if (ownership.objectCreated && Object.keys(existing).length === 0)
                delete overrides[name];
            delete owned[name];
        }
    }
    for (const [name, output] of Object.entries(desired)) {
        const existing = Object.hasOwn(overrides, name)
            ? object(overrides[name], `override ${name}`)
            : undefined;
        const ownership = Object.hasOwn(owned, name) ? owned[name] : undefined;
        if (
            !ownership &&
            Object.hasOwn(approvals, name) &&
            (!existing ||
                fingerprint(existing.tools) !== fingerprint(approvals[name]) ||
                fingerprint(output.tools) !== fingerprint(approvals[name]))
        )
            throw new Error(
                `Stale or permission-changing adoption for ${name}`,
            );
        if (
            !ownership &&
            existing &&
            Object.hasOwn(existing, "tools") &&
            !Object.hasOwn(approvals, name)
        )
            throw new Error(`Unowned tools require explicit adoption: ${name}`);
        Object.defineProperty(overrides, name, {
            value: { ...existing, tools: output.tools },
            enumerable: true,
            configurable: true,
            writable: true,
        });
        Object.defineProperty(owned, name, {
            value: {
                sources: output.sources,
                fingerprint: fingerprint(output.tools),
                objectCreated:
                    ownership?.objectCreated ?? existing === undefined,
            },
            enumerable: true,
            configurable: true,
            writable: true,
        });
    }
    if (Object.keys(owned).length) {
        subagents.agentOverrides = overrides;
        settings.subagents = subagents;
        metadata.generatedToolOverrides = { version: 1, agents: owned };
        settings.piSubagentsAddons = metadata;
    } else if (Object.hasOwn(metadata, "generatedToolOverrides")) {
        delete metadata.generatedToolOverrides;
        if (Object.keys(metadata).length === 0)
            delete settings.piSubagentsAddons;
    }
    return before === JSON.stringify(settings)
        ? undefined
        : `${JSON.stringify(settings, null, 2)}\n`;
}

function prepareProjectDirectory(cwd: string): string {
    const root = realpathSync(cwd);
    if (root === realpathSync(homedir()))
        throw new Error("Home is not a supported project root");
    const directory = join(root, ".pi");
    try {
        if (!lstatSync(directory).isDirectory())
            throw new Error(
                `Project settings directory must not be a symlink: ${directory}`,
            );
    } catch (error) {
        if (
            !(
                error instanceof Error &&
                "code" in error &&
                error.code === "ENOENT"
            )
        )
            throw error;
        try {
            if (!statSync(join(root, ".agents")).isDirectory())
                throw new Error("Missing marker");
        } catch (markerError) {
            throw new Error(`Missing supported project root marker: ${root}`, {
                cause: markerError,
            });
        }
        mkdirSync(directory, { mode: 0o700, recursive: true });
    }
    return directory;
}

/** Publish a complete compilation under Pi-compatible locks; atomic per file, not across files. */
export async function syncGeneratedToolSettings(
    options: SyncGeneratedToolSettingsOptions,
): Promise<{ changed: string[] }> {
    const targets = [
        {
            path: resolve(options.agentDir, "settings.json"),
            desired: options.compilation.global,
            approvals: options.adopt?.global,
        },
    ];
    if (options.projectTrusted && options.compilation.project)
        targets.push({
            path: join(prepareProjectDirectory(options.cwd), "settings.json"),
            desired: options.compilation.project,
            approvals: options.adopt?.project,
        });
    targets.sort((a, b) => a.path.localeCompare(b.path));
    if (new Set(targets.map((target) => target.path)).size !== targets.length)
        throw new Error("Global and project settings must be distinct");
    const releases: Array<() => Promise<void>> = [];
    const changed: string[] = [];
    const failures: unknown[] = [];
    let compromised: Error | undefined;
    try {
        for (const { path } of targets) {
            if (realpathSync(dirname(path)) !== dirname(path))
                throw new Error(
                    `Settings parent must not be redirected by a symlink: ${path}`,
                );
            releases.push(
                await lockfile.lock(path, {
                    realpath: false,
                    retries: {
                        retries: 10,
                        factor: 1,
                        minTimeout: 25,
                        maxTimeout: 25,
                        randomize: false,
                    },
                    onCompromised: (error) => {
                        compromised = error;
                    },
                }),
            );
        }
        const prepared = targets.map(({ path, desired, approvals }) => {
            const original = readSettings(path);
            return {
                path,
                original,
                next: prepareSettings(path, original.bytes, desired, approvals),
            };
        });
        for (const { path, original, next } of prepared) {
            if (compromised) throw compromised;
            if (next === undefined) continue;
            const temporary = join(
                dirname(path),
                `.generated-tools-${randomUUID()}.tmp`,
            );
            try {
                writeFileSync(temporary, next, { mode: 0o600, flag: "wx" });
                chmodSync(temporary, original.mode);
                if (realpathSync(dirname(path)) !== dirname(path))
                    throw new Error(`Settings parent changed: ${path}`);
                if (readSettings(path).bytes !== original.bytes)
                    throw new Error(`Concurrent settings edit: ${path}`);
                renameSync(temporary, path);
                changed.push(path);
            } finally {
                try {
                    unlinkSync(temporary);
                } catch (error) {
                    if (
                        !(
                            error instanceof Error &&
                            "code" in error &&
                            error.code === "ENOENT"
                        )
                    )
                        failures.push(error);
                }
            }
            if (failures.length) break;
        }
    } catch (error) {
        failures.push(error);
    } finally {
        for (const release of releases.toReversed()) {
            try {
                await release();
            } catch (error) {
                failures.push(error);
            }
        }
    }
    if (failures.length)
        throw new AggregateError(
            failures,
            `Generated tools sync failed; published files: ${changed.join(", ") || "none"}. ${failures.map(String).join("; ")}`,
        );
    return { changed };
}
