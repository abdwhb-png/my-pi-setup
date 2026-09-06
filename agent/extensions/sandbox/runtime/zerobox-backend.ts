import { createHash, randomBytes } from "node:crypto";
import {
    chmod,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rename,
    rm,
    writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import {
    SANDBOX_CAPABILITIES,
    SandboxExecutionError,
    type PrivateTempLease,
    type SandboxBackend,
    type SandboxCapabilities,
    type SandboxCommand,
    type SandboxDockerPolicy,
    type SandboxPolicy,
    type SandboxSpawnSpec,
} from "./contracts.ts";
import { assertPrivateRootDirectory } from "./private-temp.ts";
import { createZeroboxStatusChannel } from "./status-channel.ts";

interface ZeroboxProvenance {
    version: string;
    binarySha256: string;
}

export interface ZeroboxCommandResult {
    exitCode: number | null;
    stdout: string;
    stderr: string;
}

export interface ZeroboxBackendOptions {
    binaryPath?: string;
    platform?: NodeJS.Platform;
    probeRoot?: string;
    hashFile?: (path: string) => Promise<string>;
    runCommand?: (
        file: string,
        args: string[],
        options: { cwd: string; env: Record<string, string> },
    ) => ZeroboxCommandResult;
    expectedProvenance?: ZeroboxProvenance;
    createStatusChannel?: typeof createZeroboxStatusChannel;
}

interface ZeroboxProfile {
    description: string;
    strict_sandbox: true;
    allow_read: string[];
    deny_read?: string[];
    deny_read_globs?: string[];
    allow_write: string[];
    deny_write?: string[];
    deny_write_globs?: string[];
    allow_net?: string[];
    deny_net?: string[];
    allow_env?: string[];
    deny_env?: string[];
    set_env: Record<string, string>;
    docker?: SandboxDockerPolicy;
}

const PROVENANCE_URL = new URL("./zerobox-provenance.json", import.meta.url);

async function loadProvenance(): Promise<ZeroboxProvenance> {
    const value: unknown = JSON.parse(await readFile(PROVENANCE_URL, "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new SandboxExecutionError("provenance-mismatch");
    }
    const record = value as Record<string, unknown>;
    if (
        typeof record.version !== "string" ||
        typeof record.binarySha256 !== "string"
    ) {
        throw new SandboxExecutionError("provenance-mismatch");
    }
    return {
        version: record.version,
        binarySha256: record.binarySha256,
    };
}

async function defaultHashFile(path: string): Promise<string> {
    return createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
}

function defaultRunCommand(
    file: string,
    args: string[],
    options: { cwd: string; env: Record<string, string> },
): ZeroboxCommandResult {
    const result = Bun.spawnSync([file, ...args], {
        cwd: options.cwd,
        env: options.env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
    });
    return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
    };
}

function compileProfile(policy: SandboxPolicy): ZeroboxProfile {
    const profile: ZeroboxProfile = {
        description: `Pi private ${policy.name} sandbox policy`,
        strict_sandbox: true,
        allow_read: policy.filesystem.allowRead,
        allow_write: policy.filesystem.allowWrite,
        set_env: policy.environment.set,
    };
    if (policy.filesystem.denyRead.length > 0) {
        profile.deny_read = policy.filesystem.denyRead;
    }
    if (policy.filesystem.denyReadGlobs.length > 0) {
        profile.deny_read_globs = policy.filesystem.denyReadGlobs;
    }
    if (policy.filesystem.denyWrite.length > 0) {
        profile.deny_write = policy.filesystem.denyWrite;
    }
    if (policy.filesystem.denyWriteGlobs.length > 0) {
        profile.deny_write_globs = policy.filesystem.denyWriteGlobs;
    }
    if (policy.network.mode === "domain-allowlist") {
        profile.allow_net = policy.network.allow;
        if (policy.network.deny.length > 0)
            profile.deny_net = policy.network.deny;
    }
    if (policy.environment.inherit.length > 0) {
        profile.allow_env = policy.environment.inherit;
    }
    if (policy.environment.deny.length > 0) {
        profile.deny_env = policy.environment.deny;
    }
    if (policy.docker.mode !== "disabled") {
        profile.docker = policy.docker;
    }
    return profile;
}

function launcherEnvironment(lease: PrivateTempLease): Record<string, string> {
    return { ZEROBOX_HOME: lease.zeroboxHome };
}

function isEqualOrDescendant(path: string, parent: string): boolean {
    return path === parent || path.startsWith(`${parent}/`);
}

async function materializePotentialPath(path: string): Promise<string> {
    let ancestor = resolve(path);
    const suffix: string[] = [];
    while (true) {
        try {
            return resolve(await realpath(ancestor), ...suffix);
        } catch (error) {
            if (
                typeof error !== "object" ||
                error === null ||
                !("code" in error) ||
                (error.code !== "ENOENT" && error.code !== "ENOTDIR")
            ) {
                throw error;
            }
            const parent = dirname(ancestor);
            if (parent === ancestor) throw error;
            suffix.unshift(basename(ancestor));
            ancestor = parent;
        }
    }
}

async function assertAndMaterializeFilesystemPolicy(
    policy: SandboxPolicy,
    lease: PrivateTempLease,
): Promise<SandboxPolicy> {
    const [leaseParent, homeDir, tmpDir, proxyRunsDir, allowRead, allowWrite] =
        await Promise.all([
            materializePotentialPath(dirname(lease.root)),
            materializePotentialPath(lease.homeDir),
            materializePotentialPath(lease.tmpDir),
            materializePotentialPath(lease.proxyRunsDir),
            Promise.all(
                policy.filesystem.allowRead.map(materializePotentialPath),
            ),
            Promise.all(
                policy.filesystem.allowWrite.map(materializePotentialPath),
            ),
        ]);
    const materializedDenyRead = await Promise.all(
        policy.filesystem.denyRead
            .filter((path) => path !== "/proc/1/root")
            .map(materializePotentialPath),
    );
    const materializedDenyWrite = await Promise.all(
        policy.filesystem.denyWrite
            .filter((path) => path !== "/proc/1/root")
            .map(materializePotentialPath),
    );
    const isPrivateReadableRoot = (path: string) =>
        path === homeDir || path === tmpDir || path === proxyRunsDir;
    const isPrivateWritableRoot = (path: string) =>
        path === homeDir || path === tmpDir;
    const assertSafeAllow = (
        path: string,
        denies: string[],
        isPrivateRoot: (candidate: string) => boolean,
    ) => {
        if (isEqualOrDescendant(path, leaseParent) && !isPrivateRoot(path)) {
            throw new SandboxExecutionError("invalid-policy", {
                cause: new Error("Allowed path reopens lease control data"),
            });
        }
        if (
            !isPrivateRoot(path) &&
            denies.some((deny) => isEqualOrDescendant(path, deny))
        ) {
            throw new SandboxExecutionError("invalid-policy", {
                cause: new Error("Allowed path overrides denied data"),
            });
        }
    };
    for (const path of allowRead) {
        assertSafeAllow(path, materializedDenyRead, isPrivateReadableRoot);
    }
    for (const path of allowWrite) {
        assertSafeAllow(
            path,
            [...materializedDenyRead, ...materializedDenyWrite],
            isPrivateWritableRoot,
        );
    }
    return {
        ...policy,
        filesystem: {
            ...policy.filesystem,
            allowRead: [...new Set(allowRead)],
            allowWrite: [...new Set(allowWrite)],
        },
    };
}

async function writePrivateProfile(
    lease: PrivateTempLease,
    policy: SandboxPolicy,
): Promise<{ name: string; path: string }> {
    for (const path of [lease.root, lease.zeroboxHome, lease.profilesDir]) {
        const stat = await lstat(path);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new Error("Private profile directory was replaced");
        }
    }
    const profileName = `${policy.name}-${randomBytes(12).toString("hex")}`;
    const profilePath = join(lease.profilesDir, `${profileName}.json`);
    const temporaryPath = join(
        lease.profilesDir,
        `.${policy.name}-${randomBytes(6).toString("hex")}.tmp`,
    );
    try {
        await writeFile(
            temporaryPath,
            `${JSON.stringify(compileProfile(policy), null, 2)}\n`,
            { encoding: "utf8", flag: "wx", mode: 0o600 },
        );
        await chmod(temporaryPath, 0o600);
        await rename(temporaryPath, profilePath);
        return { name: profileName, path: profilePath };
    } catch (error) {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
        throw error;
    }
}

class ZeroboxBackend implements SandboxBackend {
    readonly #binaryPath: string;
    readonly #platform: NodeJS.Platform;
    readonly #probeRoot: string;
    readonly #hashFile: (path: string) => Promise<string>;
    readonly #runCommand: ZeroboxBackendOptions["runCommand"] & {};
    readonly #expectedProvenance?: ZeroboxProvenance;
    readonly #createStatusChannel: typeof createZeroboxStatusChannel;
    #probePromise?: Promise<SandboxCapabilities>;

    constructor(options: ZeroboxBackendOptions) {
        this.#binaryPath =
            options.binaryPath ?? join(homedir(), ".pi", "bin", "zerobox");
        this.#platform = options.platform ?? process.platform;
        this.#probeRoot =
            options.probeRoot ??
            (options.binaryPath
                ? dirname(options.binaryPath)
                : join(homedir(), ".pi", "zbx"));
        this.#hashFile = options.hashFile ?? defaultHashFile;
        this.#runCommand = options.runCommand ?? defaultRunCommand;
        this.#expectedProvenance = options.expectedProvenance;
        this.#createStatusChannel =
            options.createStatusChannel ?? createZeroboxStatusChannel;
    }

    probe(): Promise<SandboxCapabilities> {
        this.#probePromise ??= this.#probe();
        return this.#probePromise;
    }

    async #probe(): Promise<SandboxCapabilities> {
        if (this.#platform !== "linux") {
            throw new SandboxExecutionError("unsupported-platform");
        }
        try {
            const stat = await lstat(this.#binaryPath);
            if (!stat.isFile() || (stat.mode & 0o111) === 0) {
                throw new SandboxExecutionError("backend-unavailable");
            }
        } catch (error) {
            if (error instanceof SandboxExecutionError) throw error;
            throw new SandboxExecutionError("backend-unavailable", {
                cause: error,
            });
        }

        const expected = this.#expectedProvenance ?? (await loadProvenance());
        let hash: string;
        try {
            hash = await this.#hashFile(this.#binaryPath);
        } catch (error) {
            throw new SandboxExecutionError("backend-unavailable", {
                cause: error,
            });
        }
        if (hash !== expected.binarySha256) {
            throw new SandboxExecutionError("provenance-mismatch");
        }

        let version: ZeroboxCommandResult;
        try {
            version = this.#runCommand(this.#binaryPath, ["--version"], {
                cwd: homedir(),
                env: { HOME: homedir(), PATH: "/usr/local/bin:/usr/bin:/bin" },
            });
        } catch (error) {
            throw new SandboxExecutionError("spawn-failed", { cause: error });
        }
        if (
            version.exitCode !== 0 ||
            version.stdout.trim() !== `zerobox ${expected.version}`
        ) {
            throw new SandboxExecutionError("provenance-mismatch");
        }

        await mkdir(this.#probeRoot, { recursive: true, mode: 0o700 });
        await assertPrivateRootDirectory(this.#probeRoot);
        const probeHome = await mkdtemp(join(this.#probeRoot, ".probe-"));
        try {
            await mkdir(join(probeHome, "tmp"), { mode: 0o700 });
            let strict: ZeroboxCommandResult;
            try {
                strict = this.#runCommand(
                    this.#binaryPath,
                    [
                        "--profile=analysis-strict",
                        "--strict-sandbox",
                        "--",
                        "/bin/true",
                    ],
                    {
                        cwd: homedir(),
                        env: {
                            HOME: probeHome,
                            TMPDIR: join(probeHome, "tmp"),
                            ZEROBOX_HOME: probeHome,
                            PATH: "/usr/local/bin:/usr/bin:/bin",
                        },
                    },
                );
            } catch (error) {
                throw new SandboxExecutionError("spawn-failed", {
                    cause: error,
                });
            }
            if (strict.exitCode !== 0) {
                throw new SandboxExecutionError("strict-unavailable");
            }
        } finally {
            await rm(probeHome, { recursive: true, force: true });
        }
        return SANDBOX_CAPABILITIES;
    }

    async prepare(
        command: SandboxCommand,
        policy: SandboxPolicy,
        lease: PrivateTempLease,
    ): Promise<SandboxSpawnSpec> {
        await this.probe();
        if (!policy.strict) {
            throw new SandboxExecutionError("strict-unavailable");
        }
        const materializedPolicy = await assertAndMaterializeFilesystemPolicy(
            policy,
            lease,
        );
        try {
            const profile = await writePrivateProfile(
                lease,
                materializedPolicy,
            );
            let statusChannel: Awaited<
                ReturnType<typeof createZeroboxStatusChannel>
            >;
            try {
                statusChannel = await this.#createStatusChannel(lease);
            } catch (error) {
                await rm(profile.path, { force: true }).catch(() => undefined);
                throw error;
            }
            return {
                file: this.#binaryPath,
                args: [
                    `--profile=${profile.name}`,
                    "--strict-sandbox",
                    "--status-fd=3",
                    "-C",
                    command.cwd,
                    "--",
                    command.file,
                    ...command.args,
                ],
                cwd: command.cwd,
                env: launcherEnvironment(lease),
                statusProtocol: { fd: 3, version: 1 },
                extraStdio: [statusChannel.childStdio],
                supervise() {
                    return statusChannel.supervise();
                },
                async cleanup() {
                    const failures: unknown[] = [];
                    for (const cleanup of [
                        () => statusChannel.dispose(),
                        () => rm(profile.path, { force: true }),
                    ]) {
                        try {
                            await cleanup();
                        } catch (error) {
                            failures.push(error);
                        }
                    }
                    if (failures.length === 1) throw failures[0];
                    if (failures.length > 1) {
                        throw new AggregateError(
                            failures,
                            "Failed to clean Zerobox spawn resources",
                        );
                    }
                },
            };
        } catch (error) {
            if (error instanceof SandboxExecutionError) throw error;
            throw new SandboxExecutionError("setup-failed", { cause: error });
        }
    }
}

export function createZeroboxBackend(
    options: ZeroboxBackendOptions = {},
): SandboxBackend {
    return new ZeroboxBackend(options);
}
