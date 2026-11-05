import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
    chmodSync,
    closeSync,
    constants,
    existsSync,
    fstatSync,
    lstatSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    realpathSync,
    renameSync,
    readlinkSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import {
    basename,
    dirname,
    isAbsolute,
    join,
    relative,
    resolve,
    sep,
} from "node:path";
import { readJsonObject } from "./json-object.ts";

export interface RuntimeProcessIdentity {
    pid: number;
    started: string;
    boot: string;
}
interface RuntimeUse extends RuntimeProcessIdentity {
    version: 1;
    paths: string[];
}
export interface RuntimeStorageLock {
    root: string;
    assertHeld(): void;
    release(): void;
}
export interface RuntimeCleanupEntry {
    path: string;
    action: "keep" | "remove";
    reason: string;
    bytes: number;
}
export interface RuntimeCleanupReport {
    dryRun: boolean;
    entries: RuntimeCleanupEntry[];
    reclaimedBytes: number;
    warnings: string[];
}
export interface RuntimeUsage {
    paths: Map<string, string>;
    legacyPi: boolean;
}
const PYTHON_EXECUTABLE = Bun.which("python3") ?? "python3";
const HELD_LOCKS = Symbol.for("pi.runtime-storage.held-descriptors");
const descriptorGlobals = globalThis as typeof globalThis & {
    [HELD_LOCKS]?: Set<number>;
};
const heldDescriptors = (descriptorGlobals[HELD_LOCKS] ??= new Set<number>());

/** Mutating children retain the lock if their waiting parent is interrupted. */
export function runtimeChildStdio(
    mode: "inherit" | "pipe",
): ("inherit" | "pipe" | number)[] {
    return [mode, mode, mode, ...heldDescriptors];
}

function canonicalInstallation(root: string): string {
    root = resolve(root);
    return existsSync(root)
        ? realpathSync(root)
        : join(realpathSync(dirname(root)), basename(root));
}

export function containsRuntimePath(parent: string, path: string): boolean {
    const rel = relative(resolve(parent), resolve(path));
    return (
        rel === "" ||
        (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
    );
}

function ownedDirectory(path: string): void {
    const stat = lstatSync(path);
    if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.uid !== process.getuid?.() ||
        stat.mode & 0o022
    )
        throw new Error(`Untrusted runtime storage directory: ${path}`);
    if (realpathSync(path) !== resolve(path))
        throw new Error(
            `Runtime storage redirects through a symbolic link: ${path}`,
        );
}

/** flock acts on the inherited open-file description, retained by this process. */
export function acquireRuntimeStorageLock(root: string): RuntimeStorageLock {
    root = canonicalInstallation(root);
    const path = `${root}.runtime.lock`;
    const fd = openSync(
        path,
        constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
    );
    let held = true;
    const release = () => {
        if (held) {
            held = false;
            heldDescriptors.delete(fd);
            closeSync(fd);
        }
    };
    try {
        const stat = fstatSync(fd);
        if (
            !stat.isFile() ||
            stat.uid !== process.getuid?.() ||
            stat.nlink !== 1 ||
            stat.mode & 0o077
        )
            throw new Error(`Untrusted runtime lock: ${path}`);
        const result = spawnSync(
            PYTHON_EXECUTABLE,
            [
                "-c",
                "import fcntl, sys\ntry: fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(73)",
            ],
            {
                stdio: ["ignore", "pipe", "pipe", fd],
                encoding: "utf8",
            },
        );
        if (result.error) throw result.error;
        if (result.status === 73)
            throw new Error(
                "Runtime storage is busy; wait for promotion or cleanup to finish.",
            );
        if (result.status !== 0)
            throw new Error(
                `Runtime locking helper failed (exit ${result.status}); Python 3 with fcntl is required.`,
            );
        heldDescriptors.add(fd);
        return {
            root,
            release,
            assertHeld: () => {
                if (!held) throw new Error("Runtime storage lock is closed");
            },
        };
    } catch (error) {
        release();
        throw error;
    }
}

export function runtimeProcessIdentity(
    pid = process.pid,
): RuntimeProcessIdentity | undefined {
    try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        if (!/^\d+$/.test(fields[19] ?? ""))
            throw new Error(`Invalid process identity: ${pid}`);
        return {
            pid,
            started: fields[19]!,
            boot: readFileSync(
                "/proc/sys/kernel/random/boot_id",
                "utf8",
            ).trim(),
        };
    } catch (error) {
        if (
            ["ENOENT", "ESRCH"].includes(
                (error as NodeJS.ErrnoException).code ?? "",
            )
        )
            return undefined;
        throw error;
    }
}

function releaseForPath(root: string, path: string): string | undefined {
    for (const store of [
        join(root, "runtime/pi-core/releases"),
        join(root, "runtimes/zerobox"),
    ]) {
        if (!containsRuntimePath(store, path) || resolve(path) === store)
            continue;
        const parts = relative(store, resolve(path)).split(sep);
        const name = parts[0]!;
        if (name === "recovery")
            return parts[1] && !parts[1].startsWith(".")
                ? join(store, name, parts[1])
                : undefined;
        if (name.startsWith(".")) continue;
        return join(store, name);
    }
    return undefined;
}

const EXIT_REFERENCES = Symbol.for("pi.runtime-storage.exit-references");
const processGlobals = globalThis as typeof globalThis & {
    [EXIT_REFERENCES]?: Set<string>;
};

/** Resolve and pin while GC is excluded, before the caller loads any runtime code. */
export function pinRuntimeEntry(
    root: string,
    resolveEntry: () => string,
): string {
    root = canonicalInstallation(root);
    const first = resolveEntry();
    if (!releaseForPath(root, realpathSync(first))) return first;
    const lock = acquireRuntimeStorageLock(root);
    try {
        const entry = resolveEntry();
        const release = releaseForPath(root, realpathSync(entry));
        if (!release)
            throw new Error(
                "Runtime changed outside its managed store while pinning",
            );
        ownedDirectory(release);
        const identity = runtimeProcessIdentity();
        if (!identity)
            throw new Error("Runtime process identity is unavailable");
        const users = `${root}.runtime-users`;
        mkdirSync(users, { recursive: true, mode: 0o700 });
        ownedDirectory(users);
        const file = join(users, `${identity.pid}-${identity.started}.json`);
        const previous = existsSync(file) ? readRuntimeUse(file) : undefined;
        const paths = previous?.boot === identity.boot ? previous.paths : [];
        const record: RuntimeUse = {
            version: 1,
            ...identity,
            paths: [...new Set([...paths, release])],
        };
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
            writeFileSync(temporary, JSON.stringify(record), {
                flag: "wx",
                mode: 0o600,
            });
            renameSync(temporary, file);
        } finally {
            rmSync(temporary, { force: true });
        }
        const references = (processGlobals[EXIT_REFERENCES] ??= new Set());
        if (!references.has(file)) {
            references.add(file);
            process.once("exit", () => {
                rmSync(file, { force: true });
                references.delete(file);
            });
        }
        return entry;
    } finally {
        lock.release();
    }
}

function readRuntimeUse(path: string): RuntimeUse {
    const stat = lstatSync(path);
    if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.uid !== process.getuid?.() ||
        stat.mode & 0o077
    )
        throw new Error(`Untrusted runtime usage record: ${path}`);
    const record = readJsonObject(path);
    if (
        record.version !== 1 ||
        typeof record.pid !== "number" ||
        !Number.isSafeInteger(record.pid) ||
        record.pid <= 0 ||
        typeof record.started !== "string" ||
        !/^\d+$/.test(record.started) ||
        typeof record.boot !== "string" ||
        !/^[a-f0-9-]{36}$/.test(record.boot) ||
        basename(path) !== `${record.pid}-${record.started}.json` ||
        !Array.isArray(record.paths)
    )
        throw new Error(`Invalid runtime usage record: ${path}`);
    const paths: string[] = [];
    for (const item of record.paths) {
        if (typeof item !== "string" || !isAbsolute(item))
            throw new Error(`Invalid runtime usage path: ${path}`);
        paths.push(item);
    }
    return {
        version: 1,
        pid: record.pid,
        started: record.started,
        boot: record.boot,
        paths,
    };
}

export function readRuntimeUsage(
    lock: RuntimeStorageLock,
    dryRun: boolean,
): RuntimeUsage {
    lock.assertHeld();
    const paths = new Map<string, string>();
    const live = new Set<number>();
    const retain = (record: RuntimeUse): boolean => {
        const owner = runtimeProcessIdentity(record.pid);
        if (owner?.started !== record.started || owner.boot !== record.boot)
            return false;
        live.add(record.pid);
        for (const ref of record.paths)
            paths.set(ref, `live session PID ${record.pid}`);
        return true;
    };
    const users = `${lock.root}.runtime-users`;
    if (existsSync(users)) {
        ownedDirectory(users);
        for (const name of readdirSync(users)) {
            const path = join(users, name);
            if (!/^\d+-\d+\.json$/.test(name))
                throw new Error(`Unexpected runtime usage resource: ${path}`);
            const record = readRuntimeUse(path);
            if (!retain(record) && !dryRun) rmSync(path);
        }
    }
    const processes = new Map<number, { parent: number; pi: boolean }>();
    for (const name of readdirSync("/proc").filter((name) =>
        /^\d+$/.test(name),
    )) {
        const pid = Number(name);
        try {
            if (lstatSync(`/proc/${name}`).uid !== process.getuid?.()) continue;
            const args = readFileSync(`/proc/${name}/cmdline`, "utf8").split(
                "\0",
            );
            const stat = readFileSync(`/proc/${name}/stat`, "utf8");
            const parent = Number(
                stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1],
            );
            const absolute = args
                .flatMap((arg) =>
                    arg.startsWith("--runtime-bundle=")
                        ? [arg.slice(17)]
                        : arg.startsWith("/")
                          ? [arg]
                          : [],
                )
                .map((path) => (existsSync(path) ? realpathSync(path) : path));
            for (const arg of absolute) {
                const release = releaseForPath(lock.root, arg);
                if (release) paths.set(release, `process PID ${pid}`);
            }
            try {
                const executable = readlinkSync(`/proc/${pid}/exe`).replace(
                    / \(deleted\)$/,
                    "",
                );
                const release = releaseForPath(lock.root, executable);
                if (release)
                    paths.set(release, `running executable PID ${pid}`);
            } catch (error) {
                const code = (error as NodeJS.ErrnoException).code ?? "";
                if (
                    !["ENOENT", "ESRCH"].includes(code) &&
                    (!["EACCES", "EPERM"].includes(code) ||
                        absolute.some((path) =>
                            releaseForPath(lock.root, path),
                        ))
                )
                    throw error;
            }
            const pi = absolute.some(
                (arg) =>
                    arg === join(lock.root, "bin/pi") ||
                    (arg.startsWith(`${lock.root}/runtime/pi-core/`) &&
                        /\/(cli\.js|pi)$/.test(arg)) ||
                    (arg.includes("/pi-coding-agent/") &&
                        /\/cli\.(js|ts)$/.test(arg)),
            );
            // A modern Pi process may pin its runtimes in another installation.
            // Infer only recognized layouts, then require its secure identity-bound record.
            for (const arg of absolute) {
                const match = arg.match(
                    /^(.*)\/(?:runtime\/pi-core\/releases\/.*\/(?:cli\.js|pi)|agent\/.*\/pi-coding-agent\/.*\/cli\.(?:js|ts)|bin\/pi)$/,
                );
                if (!match || match[1] === lock.root) continue;
                const identity = runtimeProcessIdentity(pid);
                if (!identity) continue;
                const foreignUsers = `${match[1]}.runtime-users`;
                const file = join(
                    foreignUsers,
                    `${pid}-${identity.started}.json`,
                );
                if (!existsSync(file)) continue;
                ownedDirectory(foreignUsers);
                const record = readRuntimeUse(file);
                if (record.paths.some((ref) => releaseForPath(match[1]!, ref)))
                    retain(record);
            }
            processes.set(pid, { parent, pi });
        } catch (error) {
            if (
                ["ENOENT", "ESRCH"].includes(
                    (error as NodeJS.ErrnoException).code ?? "",
                )
            )
                continue;
            throw new Error(
                `Cannot inspect process ${pid} for runtime retention`,
                { cause: error },
            );
        }
    }
    const covered = (pid: number): boolean => {
        const seen = new Set<number>();
        while (pid > 0 && !seen.has(pid)) {
            if (live.has(pid)) return true;
            seen.add(pid);
            pid = processes.get(pid)?.parent ?? 0;
        }
        return false;
    };
    const packagePath = join(lock.root, "agent/package.json");
    if (existsSync(packagePath)) {
        const visit = (value: unknown): void => {
            if (typeof value === "string" && value.startsWith("file:"))
                paths.set(
                    resolve(dirname(packagePath), value.slice(5)),
                    "installed package pin",
                );
            else if (value && typeof value === "object")
                for (const child of Object.values(value)) visit(child);
        };
        visit(JSON.parse(readFileSync(packagePath, "utf8")));
    }
    const packageLinks = (directory: string): void => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            if (entry.name === ".git") continue;
            const path = join(directory, entry.name);
            if (entry.isSymbolicLink()) {
                const target = resolve(directory, readlinkSync(path));
                const release = releaseForPath(lock.root, target);
                if (release) paths.set(release, "installed package link");
            } else if (entry.isDirectory()) packageLinks(path);
        }
    };
    for (const path of ["agent/node_modules", "agent/npm", "agent/git"]) {
        const directory = join(lock.root, path);
        if (existsSync(directory)) {
            const stat = lstatSync(directory);
            if (stat.isSymbolicLink()) {
                const release = releaseForPath(
                    lock.root,
                    realpathSync(directory),
                );
                if (release) paths.set(release, "installed package root");
            } else if (stat.isDirectory()) packageLinks(directory);
        }
    }
    const installation = join(lock.root, ".pi-setup-state.json");
    if (existsSync(installation)) {
        const state = readJsonObject(installation);
        if (
            (state.schemaVersion !== 1 &&
                state.schemaVersion !== 2 &&
                state.schemaVersion !== 3) ||
            !state.managed ||
            typeof state.managed !== "object" ||
            Array.isArray(state.managed)
        )
            throw new Error(
                "Cannot determine runtime references from the setup installation state",
            );
        for (const path of Object.keys(state.managed)) {
            if (!path.startsWith("runtime/") && !path.startsWith("runtimes/"))
                continue;
            const target = resolve(lock.root, path);
            if (!containsRuntimePath(lock.root, target))
                throw new Error(
                    "Setup runtime reference escapes its installation",
                );
            paths.set(target, "managed setup snapshot");
        }
    }
    return {
        paths,
        legacyPi: [...processes].some(
            ([pid, record]) => record.pi && !covered(pid),
        ),
    };
}

function filesIn(path: string): string[] {
    const result = [path];
    if (lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink())
        for (const name of readdirSync(path))
            result.push(...filesIn(join(path, name)));
    return result;
}

export async function pruneRuntimeDirectories(options: {
    lock: RuntimeStorageLock;
    store: string;
    keep: Map<string, string>;
    usage: RuntimeUsage;
    dryRun: boolean;
    validate: (path: string) => void | Promise<void>;
    blocked?: string;
    skip?: string[];
}): Promise<RuntimeCleanupReport> {
    options.lock.assertHeld();
    const report: RuntimeCleanupReport = {
        dryRun: options.dryRun,
        entries: [],
        reclaimedBytes: 0,
        warnings: [],
    };
    if (!existsSync(options.store)) return report;
    ownedDirectory(options.store);
    if (options.blocked)
        report.warnings.push(`Runtime cleanup deferred: ${options.blocked}`);
    for (const name of readdirSync(options.store).sort()) {
        if (options.skip?.includes(name)) continue;
        const path = join(options.store, name),
            stat = lstatSync(path);
        if (
            name.startsWith(".") ||
            !stat.isDirectory() ||
            stat.isSymbolicLink() ||
            stat.uid !== process.getuid?.()
        ) {
            report.warnings.push(
                `Unmanaged runtime resource retained: ${path}`,
            );
            continue;
        }
        let reason = options.keep.get(path) ?? options.blocked;
        for (const [ref, owner] of options.usage.paths)
            if (containsRuntimePath(path, ref)) reason ??= owner;
        try {
            await options.validate(path);
        } catch {
            reason ??= "unrecognized runtime metadata";
        }
        const bytes = filesIn(path).reduce(
            (sum, file) => sum + lstatSync(file).blocks * 512,
            0,
        );
        report.entries.push({
            path,
            bytes,
            action: reason ? "keep" : "remove",
            reason: reason ?? "unreferenced managed runtime",
        });
    }
    const inodes = new Map<
        string,
        { count: number; links: number; bytes: number; directory: boolean }
    >();
    for (const entry of report.entries.filter(
        (entry) => entry.action === "remove",
    )) {
        for (const file of filesIn(entry.path)) {
            const stat = lstatSync(file),
                key = `${stat.dev}:${stat.ino}`;
            const previous = inodes.get(key);
            inodes.set(key, {
                count: (previous?.count ?? 0) + 1,
                links: stat.nlink,
                bytes: stat.blocks * 512,
                directory: stat.isDirectory(),
            });
        }
    }
    report.reclaimedBytes = [...inodes.values()].reduce(
        (sum, item) =>
            sum + (item.directory || item.count >= item.links ? item.bytes : 0),
        0,
    );
    if (!options.dryRun)
        for (const entry of report.entries.filter(
            (entry) => entry.action === "remove",
        )) {
            for (const path of filesIn(entry.path))
                if (
                    lstatSync(path).isDirectory() &&
                    !lstatSync(path).isSymbolicLink()
                )
                    chmodSync(path, 0o700);
            rmSync(entry.path, { recursive: true });
        }
    return report;
}
