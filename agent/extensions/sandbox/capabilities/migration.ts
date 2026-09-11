import { createHash, randomUUID } from "node:crypto";
import {
    closeSync,
    existsSync,
    fsyncSync,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    renameSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createDefaultSandboxBaseline } from "../runtime/default-config.ts";
import { resolveDockerPolicy } from "../runtime/docker-policy.ts";
import { validatePiSandboxConfig } from "../runtime/policies.ts";
import {
    readGlobalSandboxConfig,
    readProjectSandboxConfig,
    type GlobalSandboxConfig,
    type SandboxConfigLayer,
} from "./authority.ts";
import {
    readCapabilityAuthority,
    type CapabilityAuthority,
} from "./legacy-authority.ts";
import { resolveShellPolicy } from "./policy.ts";

interface SourceSnapshot {
    path: string;
    bytes?: Buffer;
    digest?: string;
}
interface ArchiveRecord {
    path: string;
    archivePath: string;
    digest: string;
}
interface MigrationDestination {
    path: string;
    body: string;
    digest: string;
    before: Pick<SourceSnapshot, "digest">;
    archivePath?: string;
}
interface MigrationMarker {
    version: 1;
    state: "publishing";
    destinations: MigrationDestination[];
    archives: ArchiveRecord[];
    temporaryPaths: string[];
}
export interface LegacyMigrationPreview {
    legacyAuthorityPath: string;
    legacyDockerPath: string;
    authority?: CapabilityAuthority;
    inactive: string[];
    sources: SourceSnapshot[];
    proposedGlobal: SandboxConfigLayer;
    proposedProject: SandboxConfigLayer;
}
/** Boundary injection used only to test a real filesystem publication failure. */
export interface MigrationFileOperations {
    rename?: (from: string, to: string) => void;
}
export interface PublishMigrationOptions {
    preview: LegacyMigrationPreview;
    globalPath: string;
    projectPath: string;
    machineId: string;
    /** The interactive caller must select this proposed ceiling explicitly. */
    globalCeiling: SandboxConfigLayer;
    projectOverride?: SandboxConfigLayer;
    cancelled?: boolean;
    filesystem?: MigrationFileOperations;
}
export interface PublishMigrationResult {
    published: boolean;
    archives: string[];
    inactive: string[];
}
export interface MigrationRecoveryResult {
    recovered: "restored" | "completed";
}

function sha256(bytes: Buffer | string): string {
    return createHash("sha256").update(bytes).digest("hex");
}
function snapshot(path: string): SourceSnapshot {
    if (!existsSync(path)) return { path };
    const bytes = readFileSync(path);
    return { path, bytes, digest: sha256(bytes) };
}
function assertUnchanged(source: SourceSnapshot): void {
    if (snapshot(source.path).digest !== source.digest) {
        throw new Error(
            "Migration source changed after preview: " + source.path,
        );
    }
}
function syncPath(path: string): void {
    const descriptor = openSync(path, "r");
    try {
        fsyncSync(descriptor);
    } finally {
        closeSync(descriptor);
    }
}
function writeDurably(path: string, body: string | Buffer): void {
    writeFileSync(path, body, { mode: 0o600 });
    syncPath(path);
    syncPath(dirname(path));
}
function removeDurably(path: string): void {
    unlinkSync(path);
    syncPath(dirname(path));
}
function archive(source: SourceSnapshot): ArchiveRecord | undefined {
    if (!source.bytes || source.digest === undefined) return undefined;
    const archivePath = source.path + "." + randomUUID() + ".archive";
    writeDurably(archivePath, source.bytes);
    return { path: source.path, archivePath, digest: source.digest };
}
function record(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}
function jsonObject(
    source: SourceSnapshot,
    inactive: string[],
): Record<string, unknown> | undefined {
    if (!source.bytes) return undefined;
    try {
        const value = record(JSON.parse(source.bytes.toString("utf8")));
        if (!value) throw new Error("root is not an object");
        return value;
    } catch (error) {
        inactive.push(
            "Historic configuration at " +
                source.path +
                " is invalid and remains inactive: " +
                (error instanceof Error ? error.message : String(error)),
        );
        return undefined;
    }
}
function activeFields(
    raw: Record<string, unknown> | undefined,
    scope: "global" | "project",
    inactive: string[],
): SandboxConfigLayer {
    if (!raw) return {};
    const result: SandboxConfigLayer = {};
    if (raw.mode === "sandbox" || raw.mode === "host") result.mode = raw.mode;
    else if (raw.mode !== undefined)
        inactive.push(
            "Historic " +
                scope +
                " mode remains inactive because active sandbox.json only accepts sandbox or host",
        );
    for (const key of [
        "network",
        "filesystem",
        "environment",
        "tmpNamespace",
    ] as const) {
        if (raw[key] !== undefined) Object.assign(result, { [key]: raw[key] });
    }
    if (raw.docker !== undefined) {
        const docker = record(raw.docker);
        if (!docker)
            inactive.push(
                "Historic " +
                    scope +
                    " Docker configuration is invalid and remains inactive",
            );
        else if (scope === "global") {
            const { grants: _grants, ...compatible } = docker;
            if (docker.grants !== undefined)
                inactive.push(
                    "Historic per-project Docker grants remain inactive because Docker now requires a selected global ceiling and project activation",
                );
            result.docker = compatible;
        } else {
            const { enabled, targets, ...globalOnly } = docker;
            if (Object.keys(globalOnly).length > 0)
                inactive.push(
                    "Historic project Docker authority remains inactive because Docker ceilings are global-only",
                );
            result.docker = {
                ...(enabled === undefined ? {} : { enabled }),
                ...(targets === undefined ? {} : { targets }),
            };
        }
    }
    for (const key of Object.keys(raw)) {
        if (
            ![
                "$schema",
                "version",
                "machineId",
                "enabled",
                "profile",
                "mode",
                "network",
                "filesystem",
                "environment",
                "tmpNamespace",
                "docker",
            ].includes(key)
        ) {
            inactive.push(
                "Historic " +
                    scope +
                    " field " +
                    key +
                    " remains inactive because it has no sandbox.json equivalent",
            );
        }
    }
    return result;
}
function mergeLayer(
    base: SandboxConfigLayer,
    addition: SandboxConfigLayer,
): SandboxConfigLayer {
    const mergeRecord = (
        key: "network" | "filesystem" | "environment" | "docker",
    ): Record<string, unknown> | undefined => {
        const left = record(base[key]);
        const right = record(addition[key]);
        if (!left) return right ?? record(base[key]);
        if (!right) return left;
        return { ...left, ...right };
    };
    return {
        ...base,
        ...addition,
        network: mergeRecord("network"),
        filesystem: mergeRecord("filesystem"),
        environment: mergeRecord("environment"),
        docker: mergeRecord("docker"),
    };
}
function authorityLayer(
    authority: CapabilityAuthority | undefined,
    projectRoot: string | undefined,
    inactive: string[],
): SandboxConfigLayer {
    if (!authority || !projectRoot) return {};
    const project = authority.projects.find(
        (entry) => resolve(entry.projectRoot) === resolve(projectRoot),
    );
    if (!project) return {};
    if (project.grants.host || project.profile === "host")
        inactive.push(
            "Historic host access remains inactive until this session explicitly selects host mode within a global ceiling",
        );
    return {
        network: {
            allowedDomains: project.grants.domains,
            allowedHostDomains: project.grants.hostDomains,
        },
        filesystem: {
            // Legacy lists describe additional paths. An empty list must not
            // become an explicit v2 restriction that closes the project root.
            ...(project.grants.readPaths.length > 0
                ? { allowRead: project.grants.readPaths }
                : {}),
            ...(project.grants.writePaths.length > 0
                ? { allowWrite: project.grants.writePaths }
                : {}),
        },
        ...(project.grants.hostTmp ? { tmpNamespace: "host" as const } : {}),
    };
}
function serializeGlobal(
    machineId: string,
    ceiling: SandboxConfigLayer,
): GlobalSandboxConfig {
    return { version: 2, machineId, ...ceiling };
}
/** Compose the active parser, Docker resolver, shell resolver, and Pi compiler. */
function validateDocuments(
    globalPath: string,
    projectPath: string,
    machineId: string,
): void {
    const global = readGlobalSandboxConfig(globalPath, machineId);
    const project = readProjectSandboxConfig(projectPath);
    const docker = resolveDockerPolicy({
        globalConfig: global?.docker,
        projectConfig: project?.docker,
    });
    const baseline = createDefaultSandboxBaseline(docker);
    const resolved = resolveShellPolicy({
        cwd: dirname(dirname(projectPath)),
        baseline,
        global,
        project,
        authorityPath: globalPath,
    });
    const { docker: _docker, ...shellConfig } = resolved.config;
    validatePiSandboxConfig(shellConfig, docker);
}
function atomicWrite(
    path: string,
    body: string | Buffer,
    filesystem: MigrationFileOperations,
): void {
    const temporaryPath =
        path + "." + process.pid + "." + randomUUID() + ".tmp";
    writeDurably(temporaryPath, body);
    try {
        (filesystem.rename ?? renameSync)(temporaryPath, path);
        syncPath(dirname(path));
    } catch (error) {
        if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
        throw error;
    }
}
function readMarker(markerPath: string, globalPath: string): MigrationMarker {
    const metadata = lstatSync(markerPath);
    const uid = process.getuid?.();
    if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        (metadata.mode & 0o022) !== 0 ||
        (uid !== undefined && metadata.uid !== uid)
    ) {
        throw new Error(
            "Migration marker is not a trusted private regular file",
        );
    }
    const parsed = record(JSON.parse(readFileSync(markerPath, "utf8")));
    if (
        !parsed ||
        parsed.version !== 1 ||
        parsed.state !== "publishing" ||
        !Array.isArray(parsed.destinations) ||
        !Array.isArray(parsed.archives) ||
        !Array.isArray(parsed.temporaryPaths)
    ) {
        throw new Error("Migration marker is invalid");
    }
    const destinations = parsed.destinations.map((entry) => {
        const value = record(entry);
        const before = value && record(value.before);
        if (
            !value ||
            !before ||
            typeof value.path !== "string" ||
            typeof value.body !== "string" ||
            typeof value.digest !== "string" ||
            (before.digest !== undefined &&
                typeof before.digest !== "string") ||
            (value.archivePath !== undefined &&
                typeof value.archivePath !== "string")
        ) {
            throw new Error("Migration marker destination is invalid");
        }
        return {
            path: value.path,
            body: value.body,
            digest: value.digest,
            before: { digest: before.digest as string | undefined },
            ...(value.archivePath === undefined
                ? {}
                : { archivePath: value.archivePath }),
        };
    });
    if (destinations.length !== 2 || destinations[0]?.path !== globalPath)
        throw new Error(
            "Migration marker does not belong to this global sandbox.json",
        );
    const archives = parsed.archives.map((entry) => {
        const value = record(entry);
        if (
            !value ||
            typeof value.path !== "string" ||
            typeof value.archivePath !== "string" ||
            typeof value.digest !== "string"
        )
            throw new Error("Migration marker archive is invalid");
        return {
            path: value.path,
            archivePath: value.archivePath,
            digest: value.digest,
        };
    });
    const temporaryPaths = parsed.temporaryPaths.map((path: unknown) => {
        if (typeof path !== "string")
            throw new Error("Migration marker temporary path is invalid");
        return path;
    });
    return {
        version: 1,
        state: "publishing",
        destinations,
        archives,
        temporaryPaths,
    };
}
function destinationState(
    destination: MigrationDestination,
): "before" | "published" | "both" | "unexpected" {
    const current = snapshot(destination.path);
    if (
        current.digest === destination.digest &&
        current.digest === destination.before.digest
    )
        return "both";
    if (current.digest === destination.digest) return "published";
    if (current.digest === destination.before.digest) return "before";
    return "unexpected";
}
function restoreDestination(
    destination: MigrationDestination,
    filesystem: MigrationFileOperations,
): void {
    if (destination.before.digest === undefined) {
        removeDurably(destination.path);
        return;
    }
    if (!destination.archivePath)
        throw new Error("Migration archive is missing for " + destination.path);
    const bytes = readFileSync(destination.archivePath);
    if (sha256(bytes) !== destination.before.digest)
        throw new Error("Migration archive does not match " + destination.path);
    atomicWrite(destination.path, bytes, filesystem);
}
function removeTemporaryPaths(marker: MigrationMarker): void {
    for (const path of marker.temporaryPaths)
        if (existsSync(path)) unlinkSync(path);
}
/**
 * Complete an interrupted transaction only if both destinations landed. Otherwise
 * restore each published destination from its exact archive after digest checks.
 */
export function recoverIncompleteMigration(
    globalPath: string,
    filesystem: MigrationFileOperations = {},
): MigrationRecoveryResult | undefined {
    const markerPath = globalPath + ".migration";
    if (!existsSync(markerPath)) return undefined;
    const marker = readMarker(markerPath, globalPath);
    const states = marker.destinations.map(destinationState);
    if (states.some((state) => state === "unexpected"))
        throw new Error(
            "Migration recovery refused because a destination changed after interruption",
        );
    if (states.every((state) => state === "published" || state === "both")) {
        const machineId = record(
            JSON.parse(marker.destinations[0].body),
        )?.machineId;
        if (typeof machineId !== "string")
            throw new Error("Migration marker machine identity is invalid");
        validateDocuments(
            marker.destinations[0].path,
            marker.destinations[1].path,
            machineId,
        );
        removeTemporaryPaths(marker);
        removeDurably(markerPath);
        return { recovered: "completed" };
    }
    for (const [index, destination] of marker.destinations.entries()) {
        if (states[index] === "published")
            restoreDestination(destination, filesystem);
    }
    for (const destination of marker.destinations) {
        if (
            destinationState(destination) !== "before" &&
            destinationState(destination) !== "both"
        )
            throw new Error(
                "Migration recovery could not verify restored destination",
            );
    }
    removeTemporaryPaths(marker);
    removeDurably(markerPath);
    return { recovered: "restored" };
}

/** Reads historic inputs without mutation. The caller must select the proposed global ceiling. */
export function previewLegacyMigration(
    agentDir: string,
    machineId: string,
    projectRoot?: string,
): LegacyMigrationPreview {
    const legacyAuthorityPath = join(agentDir, "sandbox.capabilities.json");
    const legacyDockerPath = join(agentDir, "sandbox.global.json");
    const globalPath = join(agentDir, "sandbox.json");
    const projectPath = projectRoot
        ? join(projectRoot, ".pi", "sandbox.json")
        : undefined;
    const globalSettingsPath = join(agentDir, "settings.json");
    const projectSettingsPath = projectRoot
        ? join(projectRoot, ".pi", "settings.json")
        : undefined;
    const sources = [
        legacyAuthorityPath,
        legacyDockerPath,
        globalPath,
        globalSettingsPath,
        ...(projectPath ? [projectPath] : []),
        ...(projectSettingsPath ? [projectSettingsPath] : []),
    ].map(snapshot);
    const find = (path: string) =>
        sources.find((source) => source.path === path)!;
    const inactive: string[] = [];
    let authority: CapabilityAuthority | undefined;
    if (find(legacyAuthorityPath).bytes) {
        try {
            authority = readCapabilityAuthority(legacyAuthorityPath, machineId);
            if (authority.machineId !== machineId) {
                inactive.push(
                    "Legacy grants belong to another machine and remain inactive",
                );
                authority = undefined;
            }
        } catch (error) {
            inactive.push(
                "Historic capability authority is invalid and remains inactive: " +
                    (error instanceof Error ? error.message : String(error)),
            );
        }
    }
    const settingsSandbox = (
        path: string,
    ): Record<string, unknown> | undefined =>
        record(jsonObject(find(path), inactive)?.sandbox);
    const globalLayers = [
        activeFields(
            jsonObject(find(legacyDockerPath), inactive),
            "global",
            inactive,
        ),
        activeFields(
            jsonObject(find(globalPath), inactive),
            "global",
            inactive,
        ),
        activeFields(settingsSandbox(globalSettingsPath), "global", inactive),
    ];
    const projectLayers =
        projectPath && projectSettingsPath
            ? [
                  activeFields(
                      jsonObject(find(projectPath), inactive),
                      "project",
                      inactive,
                  ),
                  activeFields(
                      settingsSandbox(projectSettingsPath),
                      "project",
                      inactive,
                  ),
                  authorityLayer(authority, projectRoot, inactive),
              ]
            : [];
    return {
        legacyAuthorityPath,
        legacyDockerPath,
        authority,
        inactive,
        sources,
        proposedGlobal: globalLayers.reduce(mergeLayer, {}),
        proposedProject: projectLayers.reduce(mergeLayer, {}),
    };
}
export function formatMigrationPreview(
    preview: LegacyMigrationPreview,
): string {
    const sources = preview.sources
        .filter((source) => source.bytes)
        .map((source) => source.path);
    return [
        "Migration preview",
        "Sources: " + (sources.length === 0 ? "none" : sources.join(", ")),
        "Proposed global ceiling: " + JSON.stringify(preview.proposedGlobal),
        "Proposed project override: " + JSON.stringify(preview.proposedProject),
        ...(preview.inactive.length > 0
            ? [
                  "Inactive historic rights:",
                  ...preview.inactive.map((item) => "- " + item),
              ]
            : []),
    ].join("\n");
}
/**
 * Validate both temporary active documents before creating a durable marker.
 * The marker blocks admissions until this function or recovery reaches a verified state.
 */
export function publishLegacyMigration(
    options: PublishMigrationOptions,
): PublishMigrationResult {
    if (options.cancelled)
        return {
            published: false,
            archives: [],
            inactive: options.preview.inactive,
        };
    const markerPath = options.globalPath + ".migration";
    if (existsSync(markerPath))
        throw new Error(
            "Sandbox migration is incomplete; recover it before publishing again",
        );
    options.preview.sources.forEach(assertUnchanged);
    const globalBody =
        JSON.stringify(
            serializeGlobal(options.machineId, options.globalCeiling),
            null,
            2,
        ) + "\n";
    const projectBody =
        JSON.stringify(
            options.projectOverride ?? options.preview.proposedProject,
            null,
            2,
        ) + "\n";
    mkdirSync(dirname(options.globalPath), { recursive: true, mode: 0o700 });
    mkdirSync(dirname(options.projectPath), { recursive: true, mode: 0o700 });
    const globalTemporaryPath =
        options.globalPath + "." + process.pid + "." + randomUUID() + ".tmp";
    const projectTemporaryPath =
        options.projectPath + "." + process.pid + "." + randomUUID() + ".tmp";
    writeDurably(globalTemporaryPath, globalBody);
    writeDurably(projectTemporaryPath, projectBody);
    try {
        validateDocuments(
            globalTemporaryPath,
            projectTemporaryPath,
            options.machineId,
        );
    } catch (error) {
        unlinkSync(globalTemporaryPath);
        unlinkSync(projectTemporaryPath);
        throw error;
    }
    options.preview.sources.forEach(assertUnchanged);
    const beforeGlobal = snapshot(options.globalPath);
    const beforeProject = snapshot(options.projectPath);
    const snapshots = new Map(
        [...options.preview.sources, beforeGlobal, beforeProject].map(
            (source) => [source.path, source],
        ),
    );
    const archives = [...snapshots.values()]
        .map(archive)
        .filter((entry): entry is ArchiveRecord => entry !== undefined);
    options.preview.sources.forEach(assertUnchanged);
    const archiveByPath = new Map(archives.map((entry) => [entry.path, entry]));
    const destinations: MigrationDestination[] = [
        {
            path: options.globalPath,
            body: globalBody,
            digest: sha256(globalBody),
            before: { digest: beforeGlobal.digest },
            ...(archiveByPath.get(options.globalPath)
                ? {
                      archivePath: archiveByPath.get(options.globalPath)!
                          .archivePath,
                  }
                : {}),
        },
        {
            path: options.projectPath,
            body: projectBody,
            digest: sha256(projectBody),
            before: { digest: beforeProject.digest },
            ...(archiveByPath.get(options.projectPath)
                ? {
                      archivePath: archiveByPath.get(options.projectPath)!
                          .archivePath,
                  }
                : {}),
        },
    ];
    const marker: MigrationMarker = {
        version: 1,
        state: "publishing",
        destinations,
        archives,
        temporaryPaths: [globalTemporaryPath, projectTemporaryPath],
    };
    atomicWrite(
        markerPath,
        JSON.stringify(marker, null, 2) + "\n",
        options.filesystem ?? {},
    );
    (options.filesystem?.rename ?? renameSync)(
        globalTemporaryPath,
        options.globalPath,
    );
    syncPath(dirname(options.globalPath));
    (options.filesystem?.rename ?? renameSync)(
        projectTemporaryPath,
        options.projectPath,
    );
    syncPath(dirname(options.projectPath));
    validateDocuments(
        options.globalPath,
        options.projectPath,
        options.machineId,
    );
    removeDurably(markerPath);
    return {
        published: true,
        archives: archives.map((entry) => entry.archivePath),
        inactive: options.preview.inactive,
    };
}
/** Kept for callers that named cancellation; it now performs verified recovery. */
export function cancelIncompleteMigration(
    globalPath: string,
    filesystem: MigrationFileOperations = {},
): MigrationRecoveryResult | undefined {
    return recoverIncompleteMigration(globalPath, filesystem);
}
