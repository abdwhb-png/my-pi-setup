import { createHash, randomUUID } from "node:crypto";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { CONFIG_OWNERS } from "../extensions/_shared/config-loader.ts";
import { extensionPath } from "../extensions/_shared/extension-paths.ts";
import { toPortableHomePath } from "../extensions/_shared/home-path.ts";

import { assertNoSymlinkPath } from "../extensions/_shared/scripts/migration-paths.ts";

const OPERATIONAL_FILES = new Set([
    "settings.json",
    "models.json",
    "mcp.json",
    "mcp-onboarding.json",
    "pi-permission-system-addons.json",
    "pi-session-recall.json",
    "plannotator.json",
    "sandbox.json",
    "session-status-bar.json",
    "slow-mode.json",
    "tool-groups.json",
    "fancy-footer.json",
    "trust.json",
    "package-finalizer-state.json",
]);

export interface PortablePathMigrationOptions {
    agentDir: string;
    home?: string;
    workspaceDir?: string;
    apply?: boolean;
    backupRoot?: string;
}

export interface PortablePathMigrationResult {
    changedFiles: string[];
    backupDir?: string;
}

function walkJsonFiles(directory: string): string[] {
    assertNoSymlinkPath(directory);
    if (!existsSync(directory)) return [];
    const files: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink())
            throw new Error(`Refusing symlink: ${path}`);
        if (entry.isDirectory()) files.push(...walkJsonFiles(path));
        else if (entry.isFile() && entry.name.endsWith(".json"))
            files.push(path);
    }
    return files;
}

function operationalFiles(agentDir: string, workspaceDir?: string): string[] {
    const files = [...OPERATIONAL_FILES]
        .map((name) => join(agentDir, name))
        .filter(existsSync);
    for (const spec of Object.values(CONFIG_OWNERS)) {
        files.push(
            extensionPath({ scope: "global", agentDir }, "config", spec.file),
        );
        if (workspaceDir && !("globalOnly" in spec && spec.globalOnly))
            files.push(
                extensionPath(
                    { scope: "project", cwd: workspaceDir },
                    "config",
                    spec.file,
                ),
            );
    }
    files.push(
        extensionPath(
            { scope: "global", agentDir },
            "artifacts",
            "package-finalizer-state.json",
        ),
    );
    for (const directory of ["queue", "progress", "results"]) {
        files.push(...walkJsonFiles(join(agentDir, ".sdd", directory)));
        files.push(
            ...walkJsonFiles(
                extensionPath(
                    { scope: "global", agentDir },
                    "artifacts",
                    "sdd",
                    directory,
                ),
            ),
        );
    }
    const workspaceSettings = workspaceDir
        ? join(workspaceDir, ".pi", "settings.json")
        : undefined;
    if (workspaceSettings && existsSync(workspaceSettings))
        files.push(workspaceSettings);
    return [...new Set(files.filter(existsSync))].toSorted();
}

function convertJsonString(value: string, home: string): string {
    const portablePath = toPortableHomePath(value, home);
    if (portablePath !== value) return portablePath;

    try {
        const parsed: unknown = JSON.parse(value);
        if (!parsed || typeof parsed !== "object") return value;
        const converted = JSON.stringify(convertJsonValue(parsed, home));
        return converted === value ? value : converted;
    } catch {
        const escapedHome = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return value.replace(new RegExp(`${escapedHome}(?=$|/)`, "g"), "~");
    }
}

function convertJsonValue(value: unknown, home: string): unknown {
    if (typeof value === "string") return convertJsonString(value, home);
    if (Array.isArray(value))
        return value.map((item) => convertJsonValue(item, home));
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [
                convertJsonString(key, home),
                convertJsonValue(item, home),
            ]),
        );
    }
    return value;
}

function digest(content: Buffer): string {
    return createHash("sha256").update(content).digest("hex");
}

function timestamp(): string {
    return new Date()
        .toISOString()
        .replaceAll(":", "-")
        .replace(/\.\d+Z$/, "Z");
}

function writeAtomically(path: string, content: string, mode: number): void {
    const temporary = join(
        dirname(path),
        `.${basename(path)}.${randomUUID()}.portable-path-tmp`,
    );
    writeFileSync(temporary, content, { mode, flag: "wx" });
    try {
        renameSync(temporary, path);
    } finally {
        rmSync(temporary, { force: true });
    }
}

export function migrateOperationalState(
    options: PortablePathMigrationOptions,
): PortablePathMigrationResult {
    const agentDir = resolve(options.agentDir);
    const home = resolve(options.home ?? homedir());
    const candidates = operationalFiles(agentDir, options.workspaceDir);
    const changes = candidates.flatMap((path) => {
        assertNoSymlinkPath(path);
        const before = readFileSync(path);
        let parsed: unknown;
        try {
            parsed = JSON.parse(before.toString("utf8"));
        } catch {
            throw new Error(`Invalid JSON: ${path}`);
        }
        const after = `${JSON.stringify(convertJsonValue(parsed, home), null, 2)}\n`;
        return after === before.toString("utf8")
            ? []
            : [{ path, before, after, mode: statSync(path).mode }];
    });

    if (!options.apply || changes.length === 0) {
        return { changedFiles: changes.map((change) => change.path) };
    }

    const backupDir = join(
        options.backupRoot ?? join(agentDir, ".portable-path-backups"),
        `${timestamp()}-${randomUUID()}`,
    );
    assertNoSymlinkPath(backupDir);
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    const backupPath = (path: string) =>
        join(
            backupDir,
            "files",
            createHash("sha256").update(path).digest("hex"),
        );
    const manifest = changes.map((change) => {
        const target = backupPath(change.path);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(change.path, target);
        return {
            path: change.path,
            backup: relative(backupDir, target),
            sha256: digest(change.before),
        };
    });
    writeFileSync(
        join(backupDir, "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
        { mode: 0o600, flag: "wx" },
    );

    try {
        for (const change of changes) {
            writeAtomically(change.path, change.after, change.mode);
            if (readFileSync(change.path, "utf8") !== change.after) {
                throw new Error(`Validation failed: ${change.path}`);
            }
        }
    } catch (error) {
        for (const change of changes) {
            const backup = backupPath(change.path);
            if (existsSync(backup)) copyFileSync(backup, change.path);
        }
        throw error;
    }

    return { changedFiles: changes.map((change) => change.path), backupDir };
}

if (import.meta.main) {
    const apply = process.argv.includes("--apply");
    const result = migrateOperationalState({
        agentDir: resolve(import.meta.dir, ".."),
        workspaceDir: resolve(import.meta.dir, "..", ".."),
        apply,
    });
    console.log(
        `${apply ? "Migrated" : "Would migrate"} ${result.changedFiles.length} file(s).`,
    );
    if (result.backupDir) console.log(`Backup: ${result.backupDir}`);
}
