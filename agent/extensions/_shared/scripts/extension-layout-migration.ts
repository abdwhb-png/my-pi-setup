import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
    accessSync,
    chmodSync,
    constants,
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import {
    dirname,
    join,
    resolve,
    relative,
    isAbsolute,
    basename,
    sep,
} from "node:path";
import {
    CONFIG_OWNERS,
    extensionConfigPath,
    type ExtensionConfigOwner,
} from "../config-loader.ts";
import { extensionPath, type ExtensionScope } from "../extension-paths.ts";
import { resolveRuntimePath } from "../home-path.ts";
import { managedOutputArchiveTimestamp } from "../tool-output-archive.ts";
import { assertNoSymlinkPath } from "./migration-paths.ts";

function files(root: string): string[] {
    assertNoSymlinkPath(root);
    if (lstatSync(root).isFile()) return [root];
    return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
        const path = join(root, entry.name);
        if (entry.isSymbolicLink())
            throw new Error(`Refusing symlink: ${path}`);
        if (entry.isDirectory()) return files(path);
        if (!entry.isFile()) throw new Error(`Unsupported artifact: ${path}`);
        return [path];
    });
}

export interface LayoutMigrationOptions {
    agentDir: string;
    projects: string[];
    artifactSources?: string[];
}
export interface FileImage {
    data: string;
    mode: number;
}
export interface LayoutChange {
    path: string;
    before: FileImage | null;
    after: FileImage | null;
}
export interface LayoutMigration {
    version: 1;
    agentDir: string;
    projects: string[];
    changes: LayoutChange[];
    sourceFiles?: Record<string, string[]>;
}
interface Journal extends LayoutMigration {
    state: "applying" | "complete" | "rolled-back";
}

function object(value: unknown, path: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`Expected a JSON object: ${path}`);
    return value as Record<string, unknown>;
}
function parseObjectText(
    content: string,
    path: string,
): Record<string, unknown> {
    try {
        return object(JSON.parse(content), path);
    } catch {
        throw new Error(`Invalid migration input: ${path}`);
    }
}
function parse(path: string): Record<string, unknown> {
    try {
        return parseObjectText(readFileSync(path, "utf8"), path);
    } catch {
        throw new Error(`Invalid migration input: ${path}`);
    }
}
function json(value: unknown): Buffer {
    return Buffer.from(JSON.stringify(value, null, 2) + "\n");
}
function hash(value: Buffer): string {
    return createHash("sha256").update(value).digest("hex");
}
function image(path: string): FileImage | null {
    assertNoSymlinkPath(path);
    if (!existsSync(path)) return null;
    const stat = lstatSync(path);
    if (!stat.isFile()) throw new Error(`Expected a regular file: ${path}`);
    return {
        data: readFileSync(path).toString("base64"),
        mode: stat.mode & 0o777,
    };
}
function same(a: FileImage | null, b: FileImage | null): boolean {
    return a?.data === b?.data && a?.mode === b?.mode;
}
function assertWritable(path: string): void {
    let parent = dirname(path);
    while (!existsSync(parent)) parent = dirname(parent);
    accessSync(parent, constants.W_OK | constants.X_OK);
}

function assertSandboxMigrationComplete(agentDir: string): void {
    const sandboxPaths = [
        join(agentDir, CONFIG_OWNERS.sandbox.legacyFile),
        extensionConfigPath("sandbox", { scope: "global", agentDir }),
    ];
    if (sandboxPaths.some((path) => existsSync(path + ".migration")))
        throw new Error(
            "Finish the existing sandbox migration before moving its configuration",
        );
}

function assertSourceInventory(plan: LayoutMigration): void {
    const removed = new Set(
        plan.changes
            .filter((change) => change.after === null)
            .map((change) => change.path),
    );
    for (const [root, expected] of Object.entries(plan.sourceFiles ?? {})) {
        assertNoSymlinkPath(root);
        const current = new Set(existsSync(root) ? files(root) : []);
        const original = new Set(expected);
        if (
            [...current].some((path) => !original.has(path)) ||
            expected.some((path) => !current.has(path) && !removed.has(path))
        )
            throw new Error(
                `Artifact source inventory changed after preflight: ${root}`,
            );
    }
}

/** Read-only preflight. It never creates directories, locks, databases, or backups. */
export function planLayoutMigration(
    options: LayoutMigrationOptions,
): LayoutMigration {
    const agentDir = resolve(options.agentDir);
    assertSandboxMigrationComplete(agentDir);
    const projects = [...new Set(options.projects.map((cwd) => resolve(cwd)))];
    const artifactSources = new Set(
        (options.artifactSources ?? []).map((path) =>
            resolveRuntimePath(path, process.cwd()),
        ),
    );
    const changes = new Map<string, LayoutChange>();
    const scopes: ExtensionScope[] = [
        { scope: "global", agentDir },
        ...projects.map((cwd) => ({ scope: "project" as const, cwd })),
    ];
    const roots = scopes.map((scope) =>
        scope.scope === "global" ? agentDir : join(scope.cwd, ".pi"),
    );
    const settings = roots.map((root) =>
        existsSync(join(root, "settings.json"))
            ? parse(join(root, "settings.json"))
            : {},
    );
    const dirty = new Set<number>();
    const priorSettings = structuredClone(settings);
    const moves = new Map<string, string>();
    const destinations = new Map<string, string>();
    const planMoves = new Map<string, { path: string; sha256: string }>();
    const legacyPlanRootPath = extensionPath(
        { scope: "global", agentDir },
        "artifacts",
        "extension-layout-migrations",
        "legacy-plan-root.json",
    );
    let globalPlanFileDir: string | undefined;
    let globalPlanOwner: string | undefined;
    const projectPlanOverrides = new Set<string>();
    if (existsSync(legacyPlanRootPath)) {
        const metadata = parse(legacyPlanRootPath);
        const prior = metadata.globalPlanFileDir;
        if (prior !== undefined && (typeof prior !== "string" || !prior.trim()))
            throw new Error(`Invalid legacy plan root: ${legacyPlanRootPath}`);
        globalPlanFileDir = prior;
        const owner = metadata.globalPlanOwner;
        if (
            owner !== undefined &&
            (typeof owner !== "string" || !isAbsolute(owner))
        )
            throw new Error(
                `Invalid legacy global plan owner: ${legacyPlanRootPath}`,
            );
        globalPlanOwner = owner;
        const overrides = metadata.projectPlanOverrides ?? [];
        if (
            !Array.isArray(overrides) ||
            overrides.some((cwd) => typeof cwd !== "string" || !isAbsolute(cwd))
        )
            throw new Error(
                `Invalid legacy project plan overrides: ${legacyPlanRootPath}`,
            );
        for (const cwd of overrides) projectPlanOverrides.add(cwd);
    }
    function hasProjectPlanOverride(cwd: string): boolean {
        return (
            projectPlanOverrides.has(cwd) ||
            Boolean(
                object(
                    priorSettings[roots.indexOf(join(cwd, ".pi"))].plans ?? {},
                    "plans",
                ).planFileDir,
            )
        );
    }
    const directories: Array<{
        from: string;
        to: string;
        cwd?: string;
        kind?:
            | "plans"
            | "session-plans"
            | "brainstorms"
            | "think"
            | "archive"
            | "telemetry";
    }> = [];
    function relocate(
        from: string,
        to: string,
        cwd?: string,
        kind?:
            | "plans"
            | "session-plans"
            | "brainstorms"
            | "think"
            | "archive"
            | "telemetry",
    ): void {
        if (resolve(from) === resolve(to)) return;
        if (
            relative(from, to) &&
            !relative(from, to).startsWith("..") &&
            !isAbsolute(relative(from, to))
        )
            throw new Error(
                `Migration destination is inside its source: ${from}`,
            );
        if (directories.some((move) => move.from === from && move.to !== to))
            throw new Error(`Ambiguous project ownership for ${from}`);
        directories.push({ from, to, cwd, kind });
    }
    function relocateConfigured(
        owner: string,
        raw: Record<string, unknown>,
        scope: ExtensionScope,
    ): void {
        function authorizedSource(value: string, cwd: string): string {
            const source = resolveRuntimePath(value, cwd);
            if (scope.scope === "project" && !artifactSources.has(source))
                throw new Error(
                    `Project configuration cannot authorize a migration source: ${source}. Inspect this directory and explicitly select its exact path with --artifact-source if it should be moved.`,
                );
            return source;
        }
        if (owner === "plans" && "planFileDir" in raw) {
            if (typeof raw.planFileDir !== "string" || !raw.planFileDir.trim())
                throw new Error("Invalid legacy plans.planFileDir");
            if (!projects.length)
                throw new Error(
                    "Migrating plans.planFileDir requires explicit --project paths",
                );
            if (scope.scope === "global") globalPlanFileDir = raw.planFileDir;
            else projectPlanOverrides.add(scope.cwd);
            const candidates =
                scope.scope === "project"
                    ? [scope.cwd]
                    : projects.filter((cwd) => !hasProjectPlanOverride(cwd));
            for (const cwd of candidates) {
                if (scope.scope === "global") claimGlobalPlanRoot(cwd);
                relocate(
                    authorizedSource(raw.planFileDir, cwd),
                    extensionPath({ scope: "project", cwd }, "plans"),
                    cwd,
                    "plans",
                );
            }
            delete raw.planFileDir;
        }
        if ((owner === "safeBash" || owner === "saveTokens") && raw.telemetry) {
            const telemetry = object(raw.telemetry, `${owner}.telemetry`);
            if ("directory" in telemetry) {
                if (
                    typeof telemetry.directory !== "string" ||
                    !telemetry.directory.trim()
                )
                    throw new Error(`Invalid ${owner} telemetry directory`);
                if (
                    scope.scope === "global" &&
                    !isAbsolute(telemetry.directory) &&
                    telemetry.directory !== "~" &&
                    !telemetry.directory.startsWith("~/")
                )
                    throw new Error(
                        `Relative global telemetry directory in ${owner}.telemetry.directory: ${telemetry.directory}. Resolve its original Pi working directory and set an absolute or home-relative source before migration.`,
                    );
                // Both extensions historically have a global telemetry store, including project overrides.
                const cwd = scope.scope === "project" ? scope.cwd : agentDir;
                relocate(
                    authorizedSource(telemetry.directory, cwd),
                    extensionPath(
                        { scope: "global", agentDir },
                        "artifacts",
                        owner === "safeBash"
                            ? "safe-bash-telemetry"
                            : "save-tokens-telemetry",
                    ),
                    undefined,
                    "telemetry",
                );
                delete telemetry.directory;
            }
        }
    }
    function claimGlobalPlanRoot(cwd: string): void {
        if (
            !globalPlanFileDir ||
            !(
                isAbsolute(globalPlanFileDir) ||
                globalPlanFileDir === "~" ||
                globalPlanFileDir.startsWith("~/")
            )
        )
            return;
        if (globalPlanOwner && globalPlanOwner !== cwd)
            throw new Error(
                `Ambiguous project ownership for ${globalPlanFileDir}: already owned by ${globalPlanOwner}, cannot move it to ${cwd}`,
            );
        globalPlanOwner = cwd;
    }
    function replace(path: string, content: Buffer | null, mode = 0o600): void {
        const before = image(path);
        const after =
            content === null
                ? null
                : { data: content.toString("base64"), mode };
        assertWritable(path);
        if (!same(before, after)) changes.set(path, { path, before, after });
    }
    const outputs = new Map<string, Record<string, unknown>>();
    for (const [owner, spec] of Object.entries(CONFIG_OWNERS)) {
        const { settingsKey, legacyFile, globalOnly, section } = spec as {
            settingsKey?: string;
            legacyFile?: string;
            globalOnly?: boolean;
            section?: string;
        };
        const layers = scopes.flatMap((scope, i) => {
            if (globalOnly && scope.scope === "project") return [];
            const legacy = legacyFile ? join(roots[i], legacyFile) : undefined;
            const oldSettings = settingsKey && settingsKey in settings[i];
            return [
                {
                    scope,
                    i,
                    legacy: legacy && existsSync(legacy) ? legacy : undefined,
                    oldSettings,
                },
            ];
        });
        if (
            layers.some((layer) => layer.oldSettings) &&
            layers.some((layer) => layer.legacy)
        ) {
            throw new Error(
                `Ambiguous legacy sources for ${owner}: settings and standalone files coexist. Consolidate the active configuration before migration.`,
            );
        }
        for (const layer of layers) {
            if (!layer.oldSettings && !layer.legacy) continue;
            const destination = extensionConfigPath(
                owner as ExtensionConfigOwner,
                layer.scope,
            );
            if (existsSync(destination))
                throw new Error(
                    `Configuration conflict: ${destination} already exists alongside legacy configuration`,
                );
            const raw = layer.oldSettings
                ? object(settings[layer.i][settingsKey!], owner)
                : parse(layer.legacy!);
            relocateConfigured(owner, raw, layer.scope);
            const output = outputs.get(destination) ?? {};
            if (section) output[section] = raw;
            else Object.assign(output, raw);
            outputs.set(destination, output);
            if (layer.oldSettings) {
                delete settings[layer.i][settingsKey!];
                dirty.add(layer.i);
            }
            if (layer.legacy) replace(layer.legacy, null);
        }
    }
    if (globalPlanFileDir) {
        for (const cwd of projects) {
            if (!hasProjectPlanOverride(cwd)) {
                claimGlobalPlanRoot(cwd);
                relocate(
                    resolveRuntimePath(globalPlanFileDir, cwd),
                    extensionPath({ scope: "project", cwd }, "plans"),
                    cwd,
                    "plans",
                );
            }
        }
    }
    if (globalPlanFileDir || projectPlanOverrides.size)
        replace(
            legacyPlanRootPath,
            json({
                ...(globalPlanFileDir ? { globalPlanFileDir } : {}),
                ...(globalPlanOwner ? { globalPlanOwner } : {}),
                ...(projectPlanOverrides.size
                    ? { projectPlanOverrides: [...projectPlanOverrides] }
                    : {}),
            }),
        );
    for (const name of [
        "tool-result-archive",
        "safe-bash-telemetry",
        "save-tokens-telemetry",
        "package-finalizer-state.json",
    ])
        relocate(
            join(agentDir, name),
            extensionPath({ scope: "global", agentDir }, "artifacts", name),
            undefined,
            name === "tool-result-archive"
                ? "archive"
                : name.endsWith("-telemetry")
                  ? "telemetry"
                  : undefined,
        );
    for (const name of ["models-dev-catalog-v1.json", "ai-providers"])
        relocate(
            join(agentDir, "cache", name),
            extensionPath(
                { scope: "global", agentDir },
                "artifacts",
                "cache",
                name,
            ),
        );
    relocate(
        join(agentDir, "think-in-code"),
        extensionPath(
            { scope: "global", agentDir },
            "artifacts",
            "think-in-code",
        ),
        undefined,
        "think",
    );
    relocate(
        join(agentDir, ".sdd"),
        extensionPath({ scope: "global", agentDir }, "artifacts", "sdd"),
    );
    relocate(
        join(agentDir, "config/skill-gate-analytics.json"),
        extensionPath(
            { scope: "global", agentDir },
            "artifacts",
            "skill-gate-analytics.json",
        ),
    );
    if (process.env.PI_TOOL_RESULT_ARCHIVE_DIR?.trim()) {
        const source = process.env.PI_TOOL_RESULT_ARCHIVE_DIR;
        if (!isAbsolute(source) && source !== "~" && !source.startsWith("~/"))
            throw new Error(
                "Relative PI_TOOL_RESULT_ARCHIVE_DIR is ambiguous. Resolve its original Pi working directory and set an absolute or home-relative source before migration.",
            );
        relocate(
            resolveRuntimePath(
                process.env.PI_TOOL_RESULT_ARCHIVE_DIR,
                process.cwd(),
            ),
            extensionPath(
                { scope: "global", agentDir },
                "artifacts",
                "tool-result-archive",
            ),
            undefined,
            "archive",
        );
    }
    for (const cwd of projects) {
        relocate(
            join(cwd, ".pi/session-plans"),
            extensionPath({ scope: "project", cwd }, "session-plans"),
            cwd,
            "session-plans",
        );
        relocate(
            join(cwd, ".pi/plans"),
            extensionPath({ scope: "project", cwd }, "plans"),
            cwd,
            "plans",
        );
        relocate(
            join(cwd, "docs/brainstorms"),
            extensionPath(
                { scope: "project", cwd },
                "artifacts",
                "brainstorms",
            ),
            cwd,
            "brainstorms",
        );
        for (const name of ["debug", "session-cron.json", "session-cron.lock"])
            relocate(
                join(cwd, ".pi", name),
                extensionPath({ scope: "project", cwd }, "artifacts", name),
            );
        const lock = join(cwd, ".pi/session-cron.lock");
        if (existsSync(lock)) {
            const pid = parse(lock).pid;
            if (typeof pid !== "number")
                throw new Error(`Invalid cron lock: ${lock}`);
            try {
                process.kill(pid, 0);
                throw new Error(`Pi is still running: ${lock}`);
            } catch (error) {
                if (
                    !(
                        error instanceof Error &&
                        "code" in error &&
                        error.code === "ESRCH"
                    )
                )
                    throw error;
            }
        }
    }
    const sourceFiles: Record<string, string[]> = {};
    for (const move of directories) {
        assertNoSymlinkPath(move.from);
        const inventory = existsSync(move.from) ? files(move.from) : [];
        sourceFiles[move.from] = inventory;
        if (!existsSync(move.from)) continue;
        if (move.kind === "telemetry" && !lstatSync(move.from).isDirectory())
            throw new Error(
                `Telemetry source must be a directory: ${move.from}`,
            );
        for (const path of inventory) {
            if (
                move.kind === "archive" &&
                managedOutputArchiveTimestamp(
                    basename(path).replace(/\.meta\.json$/, ""),
                ) === undefined
            )
                continue;
            if (move.kind === "plans" && !/\.mdx?$/.test(path))
                throw new Error(
                    `Plan root contains a non-Markdown file: ${path}. Choose a dedicated plan root before migration.`,
                );
            const destination = lstatSync(move.from).isDirectory()
                ? join(move.to, relative(move.from, path))
                : move.to;
            if (existsSync(destination))
                throw new Error(`Artifact conflict: ${destination}`);
            const prior = moves.get(path);
            if (prior && prior !== destination)
                throw new Error(`Ambiguous artifact ownership: ${path}`);
            const competing = destinations.get(destination);
            if (competing && competing !== path)
                throw new Error(
                    `Artifact conflict: ${competing} and ${path} both map to ${destination}`,
                );
            destinations.set(destination, path);
            moves.set(path, destination);
            if (
                (move.kind === "plans" ||
                    move.kind === "session-plans" ||
                    move.kind === "brainstorms") &&
                /\.mdx?$/.test(path)
            )
                planMoves.set(path, {
                    path: destination,
                    sha256: hash(readFileSync(path)),
                });
        }
    }
    function rewritePath(value: string, cwd: string): string {
        const absolute = resolveRuntimePath(value, cwd);
        let destination = moves.get(absolute);
        if (!destination) {
            const parent = directories
                .filter(
                    (move) =>
                        move.from === absolute ||
                        absolute.startsWith(move.from + "/"),
                )
                .sort((a, b) => b.from.length - a.from.length)[0];
            if (parent)
                destination = join(parent.to, relative(parent.from, absolute));
        }
        if (!destination) return value;
        return isAbsolute(value) || value.startsWith("~/")
            ? destination
            : relative(cwd, destination);
    }
    function rewriteFields(value: unknown, cwd: string): unknown {
        if (Array.isArray(value))
            return value.map((item) => rewriteFields(item, cwd));
        if (!value || typeof value !== "object") return value;
        return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [
                key,
                typeof item === "string" &&
                ["path", "root", "planPath", "manifestPath"].includes(key)
                    ? rewritePath(item, cwd)
                    : rewriteFields(item, cwd),
            ]),
        );
    }
    function rewriteQueuedPlan(queued: Record<string, unknown>): unknown {
        if (
            typeof queued.cwd === "string" &&
            projects.includes(resolve(queued.cwd))
        )
            return rewriteFields(queued, queued.cwd);
        if (
            typeof queued.planPath === "string" &&
            (isAbsolute(queued.planPath) || queued.planPath.startsWith("~/"))
        )
            return {
                ...queued,
                planPath: rewritePath(queued.planPath, agentDir),
            };
        return queued;
    }
    for (const [source, destination] of moves) {
        const move = directories.find(
            (entry) =>
                entry.from === source || source.startsWith(entry.from + "/"),
        )!;
        let content: Buffer = readFileSync(source);
        // Historical repair snapshots must retain their original database bytes and references.
        const repairBackup = relative(move.from, source).startsWith(
            `repair-backups${sep}`,
        );
        if (
            move.kind === "think" &&
            !repairBackup &&
            source.endsWith("store.sqlite")
        ) {
            for (const suffix of ["-wal", "-journal"])
                if (
                    existsSync(source + suffix) &&
                    lstatSync(source + suffix).size > 0
                )
                    throw new Error(
                        `SQLite needs a clean shutdown and checkpoint before migration: ${source + suffix}`,
                    );
            // Work entirely in memory: even dry-run must leave the source database and WAL untouched.
            // SQLite requires rollback-format header flags for deserialization, even after a clean WAL shutdown.
            // https://www.sqlite.org/c3ref/deserialize.html
            const memoryImage = Buffer.from(content);
            if (
                memoryImage.subarray(0, 16).toString("binary") !==
                "SQLite format 3\0"
            )
                throw new Error(`Invalid SQLite database: ${source}`);
            memoryImage[18] = 1;
            memoryImage[19] = 1;
            const database = Database.deserialize(memoryImage);
            try {
                const rows = database
                    .query<{ id: string; archive_path: string }, []>(
                        "SELECT id, archive_path FROM archives",
                    )
                    .all();
                database.transaction(() => {
                    for (const row of rows) {
                        const target = moves.get(row.archive_path);
                        if (!target)
                            throw new Error(
                                `SQLite archive is outside the migration or missing: ${row.archive_path}`,
                            );
                        database
                            .query(
                                "UPDATE archives SET archive_path=? WHERE id=?",
                            )
                            .run(target, row.id);
                    }
                })();
                const check = database.query("PRAGMA integrity_check").get();
                if (
                    JSON.stringify(check) !==
                    JSON.stringify({ integrity_check: "ok" })
                )
                    throw new Error(`SQLite integrity check failed: ${source}`);
                content = database.serialize();
            } finally {
                database.close();
            }
        }
        if (
            (move.kind === "session-plans" || move.kind === "brainstorms") &&
            source.endsWith("/manifest.json")
        )
            content = json(rewriteFields(parse(source), move.cwd!));
        if (
            source.startsWith(join(agentDir, ".sdd/queue") + "/") &&
            source.endsWith(".json")
        ) {
            const queued = parse(source);
            const migrated = rewriteQueuedPlan(queued);
            if (JSON.stringify(migrated) !== JSON.stringify(queued))
                content = json(migrated);
        }
        replace(destination, content, lstatSync(source).mode & 0o777);
        replace(source, null);
    }
    const queueRoot = extensionPath(
        { scope: "global", agentDir },
        "artifacts",
        "sdd",
        "queue",
    );
    if (existsSync(queueRoot))
        for (const path of files(queueRoot)) {
            if (!path.endsWith(".json")) continue;
            const queued = parse(path);
            const migrated = rewriteQueuedPlan(queued);
            if (JSON.stringify(migrated) !== JSON.stringify(queued))
                replace(path, json(migrated), lstatSync(path).mode & 0o777);
        }
    const sessionRoot = join(agentDir, "sessions");
    if (existsSync(sessionRoot))
        for (const path of files(sessionRoot)) {
            // pi-subagents owns these transcripts, which are not Pi session entries.
            if (
                relative(sessionRoot, path)
                    .split(sep)
                    .includes("subagent-artifacts")
            )
                continue;
            if (/\.(sqlite|db)(-|$)/.test(path))
                throw new Error(
                    `Unsupported session backend: ${path}. This migration supports Pi JSONL sessions only.`,
                );
            if (!path.endsWith(".jsonl")) continue;
            const original = readFileSync(path, "utf8");
            const lines = original.trimEnd().split("\n");
            const header = parseObjectText(lines[0], path);
            if (
                header.type !== "session" ||
                typeof header.cwd !== "string" ||
                (header.version !== undefined &&
                    ![1, 2, 3].includes(Number(header.version)))
            )
                throw new Error(`Unrecognized session header: ${path}`);
            const cwd = resolve(header.cwd);
            if (!projects.includes(cwd)) continue;
            let changed = false;
            const migrated = lines.map((line, index) => {
                if (index === 0) return line;
                const entry = parseObjectText(line, path);
                if (
                    entry.type !== "custom" ||
                    typeof entry.customType !== "string"
                )
                    return line;
                if (
                    ![
                        "plan-review-guard:revision",
                        "plan-review-guard:submitted",
                        "plan-review-guard:abandoned",
                        "plans:approved",
                        "plannotator:plan-approved",
                        "brainstorm-forcer",
                        "brainstorm-forcer-terminal-commit",
                    ].includes(entry.customType)
                )
                    return line;
                const updated = rewriteFields(entry.data, cwd);
                if (JSON.stringify(updated) === JSON.stringify(entry.data))
                    return line;
                changed = true;
                return JSON.stringify({ ...entry, data: updated });
            });
            if (changed)
                replace(
                    path,
                    Buffer.from(
                        migrated.join("\n") +
                            (original.endsWith("\n") ? "\n" : ""),
                    ),
                    lstatSync(path).mode & 0o777,
                );
        }
    if (planMoves.size) {
        const path = extensionPath(
            { scope: "global", agentDir },
            "artifacts",
            "plan-path-map.json",
        );
        const existing = existsSync(path) ? parse(path) : {};
        for (const [source, target] of planMoves) {
            if (
                source in existing &&
                JSON.stringify(existing[source]) !== JSON.stringify(target)
            )
                throw new Error(`Plan mapping conflict: ${source}`);
            existing[source] = target;
        }
        replace(path, json(existing));
    }
    for (const [path, value] of outputs) replace(path, json(value));
    for (const i of dirty) {
        const path = join(roots[i], "settings.json");
        replace(path, json(settings[i]), lstatSync(path).mode & 0o777);
    }
    return {
        version: 1,
        agentDir,
        projects,
        changes: [...changes.values()],
        sourceFiles,
    };
}

function writeImage(path: string, value: FileImage | null): void {
    if (value === null) {
        rmSync(path);
        return;
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${randomUUID()}.migration-tmp`;
    try {
        writeFileSync(temp, Buffer.from(value.data, "base64"), {
            flag: "wx",
            mode: value.mode,
        });
        chmodSync(temp, value.mode);
        renameSync(temp, path);
    } finally {
        rmSync(temp, { force: true });
    }
}
function persistJournal(path: string, journal: Journal): void {
    writeImage(path, { data: json(journal).toString("base64"), mode: 0o600 });
}

function withMigrationLock<T>(agentDir: string, action: () => T): T {
    assertSandboxMigrationComplete(agentDir);
    const root = extensionPath(
        { scope: "global", agentDir },
        "artifacts",
        "extension-layout-migrations",
    );
    assertNoSymlinkPath(root);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const lock = join(root, "active.lock");
    if (existsSync(lock)) {
        const pid = parse(lock).pid;
        if (typeof pid !== "number")
            throw new Error(`Invalid migration lock: ${lock}`);
        try {
            process.kill(pid, 0);
            throw new Error(`Migration is already running: ${lock}`);
        } catch (error) {
            if (
                !(
                    error instanceof Error &&
                    "code" in error &&
                    error.code === "ESRCH"
                )
            )
                throw error;
        }
        rmSync(lock);
    }
    writeFileSync(lock, JSON.stringify({ pid: process.pid }), {
        flag: "wx",
        mode: 0o600,
    });
    try {
        return action();
    } finally {
        rmSync(lock, { force: true });
    }
}

/** Apply an inspected plan while Pi is stopped. Source bytes are checked again before any write. */
export function applyLayoutMigration(
    plan: LayoutMigration,
): string | undefined {
    assertSandboxMigrationComplete(plan.agentDir);
    assertSourceInventory(plan);
    for (const change of plan.changes) {
        if (!same(image(change.path), change.before))
            throw new Error(`Preflight is stale: ${change.path}`);
    }
    const root = extensionPath(
        { scope: "global", agentDir: plan.agentDir },
        "artifacts",
        "extension-layout-migrations",
    );
    assertNoSymlinkPath(root);
    if (existsSync(root))
        for (const name of readdirSync(root)) {
            if (!name.endsWith(".json")) continue;
            const previous = parse(join(root, name));
            if (previous.state === "applying")
                throw new Error(
                    `Unfinished migration: resume or roll back ${join(root, name)}`,
                );
        }
    if (!plan.changes.length) return undefined;
    const journal: Journal = { ...plan, state: "applying" };
    const path = join(root, `${Date.now()}-${randomUUID()}.json`);
    withMigrationLock(plan.agentDir, () => {
        assertSourceInventory(plan);
        for (const change of plan.changes)
            if (!same(image(change.path), change.before))
                throw new Error(`Preflight is stale: ${change.path}`);
        for (const name of readdirSync(root)) {
            if (
                name.endsWith(".json") &&
                parse(join(root, name)).state === "applying"
            )
                throw new Error(
                    `Unfinished migration: resume or roll back ${join(root, name)}`,
                );
        }
        persistJournal(path, journal);
    });
    recoverLayoutMigration(path, "resume");
    return path;
}

/** Recovery accepts only untouched preflight bytes or exact bytes already written by this journal. */
export function recoverLayoutMigration(
    path: string,
    action: "resume" | "rollback",
): void {
    const raw = parse(path);
    if (raw.version !== 1 || !Array.isArray(raw.changes))
        throw new Error(`Invalid migration journal: ${path}`);
    const journal = raw as unknown as Journal;
    if (journal.state === "rolled-back" && action === "resume")
        throw new Error("Cannot resume a rolled-back migration");
    withMigrationLock(journal.agentDir, () => {
        if (action === "resume") assertSourceInventory(journal);
        for (const change of journal.changes) {
            const current = image(change.path);
            if (!same(current, change.before) && !same(current, change.after))
                throw new Error(`Migration recovery conflict: ${change.path}`);
        }
        const ordered = [...journal.changes].sort(
            (a, b) =>
                Number((action === "resume" ? a.after : a.before) === null) -
                Number((action === "resume" ? b.after : b.before) === null),
        );
        for (const change of ordered) {
            const desired = action === "resume" ? change.after : change.before;
            if (!same(image(change.path), desired))
                writeImage(change.path, desired);
            if (!same(image(change.path), desired))
                throw new Error(
                    `Migration verification failed: ${change.path}`,
                );
        }
        journal.state = action === "resume" ? "complete" : "rolled-back";
        persistJournal(path, journal);
    });
}
