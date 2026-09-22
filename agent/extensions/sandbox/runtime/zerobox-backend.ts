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
    createAdmittedSandboxExecutionContext,
    type SandboxExecutionContext,
} from "../../_shared/sandbox-runtime/execution-context.ts";
import { assertAdmissionMatchesPolicy } from "./admission.ts";
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
import {
    resolvePrivateRuntime,
    readPrivateRuntimeEntry,
    type RuntimeProvenance,
    type PrivateRuntimeBundle,
} from "./runtime-bundle.ts";
import { PRIVATE_SHELL_PATH } from "./shell-baseline.ts";
import {
    createZeroboxStatusChannel,
    createZeroboxAdmissionChannel,
} from "./status-channel.ts";

const ZEROBOX_LAUNCHER_PATH =
    "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

type ZeroboxProvenance = RuntimeProvenance;

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
    createAdmissionChannel?: typeof createZeroboxAdmissionChannel;
    runtimeBundlePath?: string;
    resolveRuntime?: typeof resolvePrivateRuntime;
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
    allow_host_net?: string[];
    deny_net?: string[];
    allow_env?: string[];
    deny_env?: string[];
    set_env: Record<string, string>;
    docker?: SandboxDockerPolicy;
}

const PROVENANCE_URL = new URL("./zerobox-provenance.json", import.meta.url);

function assertRuntimeProvenance(
    runtime: PrivateRuntimeBundle,
    expected: RuntimeProvenance,
): void {
    if (
        (expected.runtimeManifestSha256 &&
            expected.runtimeManifestSha256 !== runtime.manifestSha256) ||
        (expected.helperSha256 &&
            expected.helperSha256 !== runtime.helperSha256)
    )
        throw new SandboxExecutionError("provenance-mismatch");
}

/** Distribution inspection only: no engine probe or command execution. */
export async function inspectManagedPrivateRuntime(
    options: ZeroboxBackendOptions = {},
): Promise<PrivateRuntimeBundle> {
    const entry = options.binaryPath ?? join(homedir(), ".pi/bin/zerobox");
    const pinned = options.expectedProvenance
        ? { binaryPath: entry, provenance: options.expectedProvenance }
        : await readPrivateRuntimeEntry(entry, PROVENANCE_URL);
    const runtime = await (options.resolveRuntime ?? resolvePrivateRuntime)({
        binaryPath: pinned.binaryPath,
        expectedBinarySha256: pinned.provenance.binarySha256,
        bundlePath: options.runtimeBundlePath,
    });
    assertRuntimeProvenance(runtime, pinned.provenance);
    return runtime;
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
        if (policy.network.allow.length > 0) {
            profile.allow_net = policy.network.allow;
        }
        if (policy.network.allowHost.length > 0) {
            profile.allow_host_net = policy.network.allowHost;
        }
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
    return {
        ZEROBOX_HOME: lease.zeroboxHome,
        PATH: ZEROBOX_LAUNCHER_PATH,
    };
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
    const prepareDenies = async (
        paths: string[],
        inherited: string[] = [],
        writeOnly = false,
    ) => {
        const exact: string[] = [];
        const dynamic: string[] = [];
        for (const path of new Set(paths)) {
            if (path === "/proc/1/root") {
                exact.push(path);
                continue;
            }
            // An ancestor deny already covers this path. Avoid redundant mounts
            // below an inaccessible directory without relaxing the policy.
            if (
                [...paths, ...inherited].some(
                    (parent) =>
                        parent !== path && isEqualOrDescendant(path, parent),
                )
            )
                continue;
            try {
                const stat = await lstat(path);
                if (stat.isSymbolicLink()) {
                    // Mounting a mask through a symlink can target a directory
                    // hidden by another deny (for example WSL home links).
                    const target = await materializePotentialPath(path);
                    // Read-only aliases need no FUSE overlay on their parent.
                    // Retain the canonical deny and use an alias mask whenever
                    // either its lexical or real path overlaps writable data.
                    const writableAlias = [
                        ...allowWrite,
                        ...policy.filesystem.allowWrite,
                    ].some((root) =>
                        [path, target].some(
                            (candidate) =>
                                isEqualOrDescendant(candidate, root) ||
                                isEqualOrDescendant(root, candidate),
                        ),
                    );
                    if (!writeOnly || writableAlias) {
                        const pattern = path.replace(/[\\*?[\]{}]/g, "\\$&");
                        dynamic.push(pattern);
                    }
                    if (
                        ![...paths, ...inherited].some((parent) =>
                            isEqualOrDescendant(target, parent),
                        )
                    )
                        exact.push(target);
                } else exact.push(path);
            } catch (error) {
                if (
                    !(error instanceof Error) ||
                    !("code" in error) ||
                    (error.code !== "ENOENT" && error.code !== "ENOTDIR")
                )
                    throw error;
                // Keep future paths denied through the existing FUSE contract.
                // Never create missing paths on the host merely to mask them.
                const pattern = path.replace(/[\\*?[\]{}]/g, "\\$&");
                dynamic.push(pattern);
            }
        }
        return { exact, dynamic };
    };
    const [readDenies, writeDenies] = await Promise.all([
        prepareDenies(policy.filesystem.denyRead),
        prepareDenies(
            policy.filesystem.denyWrite,
            policy.filesystem.denyRead,
            true,
        ),
    ]);
    return {
        ...policy,
        filesystem: {
            ...policy.filesystem,
            // Keep explicitly requested aliases after validating their canonical
            // targets. The engine recreates only those path aliases, without
            // exposing the host directories that contain them. An alias already
            // visible through a writable parent needs no separate read mount:
            // keep the canonical read-only target and its alias write mask.
            allowRead: [
                ...new Set([
                    ...allowRead,
                    ...policy.filesystem.allowRead.filter(
                        (path, index) =>
                            path === allowRead[index] ||
                            !policy.filesystem.allowWrite.some((root) =>
                                isEqualOrDescendant(path, root),
                            ),
                    ),
                ]),
            ],
            allowWrite: [...new Set(allowWrite)],
            denyRead: readDenies.exact,
            denyWrite: writeDenies.exact,
            denyReadGlobs: [
                ...new Set([
                    ...policy.filesystem.denyReadGlobs,
                    ...readDenies.dynamic,
                ]),
            ],
            denyWriteGlobs: [
                ...new Set([
                    ...policy.filesystem.denyWriteGlobs,
                    ...writeDenies.dynamic,
                ]),
            ],
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
    #binaryPath: string;
    readonly #platform: NodeJS.Platform;
    readonly #probeRoot: string;
    readonly #hashFile: (path: string) => Promise<string>;
    readonly #runCommand: ZeroboxBackendOptions["runCommand"] & {};
    readonly #expectedProvenance?: ZeroboxProvenance;
    readonly #createStatusChannel: typeof createZeroboxStatusChannel;
    readonly #createAdmissionChannel: typeof createZeroboxAdmissionChannel;
    readonly #resolveRuntime: typeof resolvePrivateRuntime;
    readonly #runtimeBundlePath?: string;
    #runtime?: PrivateRuntimeBundle;
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
        this.#createAdmissionChannel =
            options.createAdmissionChannel ?? createZeroboxAdmissionChannel;
        this.#resolveRuntime = options.resolveRuntime ?? resolvePrivateRuntime;
        this.#runtimeBundlePath = options.runtimeBundlePath;
    }

    probe(): Promise<SandboxCapabilities> {
        this.#probePromise ??= this.#probe();
        return this.#probePromise;
    }

    async #probe(): Promise<SandboxCapabilities> {
        if (this.#platform !== "linux" || process.arch !== "x64") {
            throw new SandboxExecutionError("unsupported-platform");
        }
        try {
            const stat = await lstat(this.#binaryPath);
            if (
                (!stat.isFile() && !stat.isSymbolicLink()) ||
                (stat.isFile() && (stat.mode & 0o111) === 0)
            ) {
                throw new SandboxExecutionError("backend-unavailable");
            }
        } catch (error) {
            if (error instanceof SandboxExecutionError) throw error;
            throw new SandboxExecutionError("backend-unavailable", {
                cause: error,
            });
        }

        const pinned = this.#expectedProvenance
            ? {
                  binaryPath: this.#binaryPath,
                  provenance: this.#expectedProvenance,
              }
            : await readPrivateRuntimeEntry(this.#binaryPath, PROVENANCE_URL);
        this.#binaryPath = pinned.binaryPath;
        const expected = pinned.provenance;
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
        this.#runtime = await this.#resolveRuntime({
            binaryPath: this.#binaryPath,
            expectedBinarySha256: expected.binarySha256,
            bundlePath: this.#runtimeBundlePath,
        });
        this.#binaryPath = this.#runtime.binaryPath;
        assertRuntimeProvenance(this.#runtime, expected);

        let version: ZeroboxCommandResult;
        try {
            version = this.#runCommand(this.#binaryPath, ["--version"], {
                cwd: homedir(),
                env: { HOME: homedir(), PATH: ZEROBOX_LAUNCHER_PATH },
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
            await mkdir(join(probeHome, "home"), { mode: 0o700 });
            let strict: ZeroboxCommandResult;
            try {
                strict = this.#runCommand(
                    this.#binaryPath,
                    [
                        "--strict-sandbox",
                        `--runtime-bundle=${this.#runtime.root}`,
                        "--runtime-component=shell",
                        `--private-tmp=${join(probeHome, "tmp")}`,
                        `--private-home=${join(probeHome, "home")}`,
                        `--allow-read=${probeHome}`,
                        "-C",
                        probeHome,
                        "--",
                        `${PRIVATE_SHELL_PATH}/true`,
                    ],
                    {
                        cwd: homedir(),
                        env: {
                            HOME: probeHome,
                            TMPDIR: join(probeHome, "tmp"),
                            ZEROBOX_HOME: probeHome,
                            PATH: ZEROBOX_LAUNCHER_PATH,
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
        let help: ZeroboxCommandResult;
        try {
            help = this.#runCommand(this.#binaryPath, ["--help"], {
                cwd: homedir(),
                env: { HOME: homedir(), PATH: ZEROBOX_LAUNCHER_PATH },
            });
        } catch (error) {
            throw new SandboxExecutionError("spawn-failed", { cause: error });
        }
        return {
            ...SANDBOX_CAPABILITIES,
            mediatedDirectTcp:
                help.exitCode === 0 &&
                help.stdout.includes("--mediated-direct-tcp-port"),
            inboundBinding:
                help.exitCode === 0 && help.stdout.includes("--publish-tcp"),
            arbitraryUnixSockets:
                help.exitCode === 0 &&
                help.stdout.includes("--allow-unix-socket"),
        };
    }

    async prepare(
        command: SandboxCommand,
        policy: SandboxPolicy,
        lease: PrivateTempLease,
    ): Promise<SandboxSpawnSpec> {
        const capabilities = await this.probe();
        const runtime = this.#runtime;
        if (!runtime) throw new SandboxExecutionError("provenance-mismatch");
        const component =
            policy.name === "analysis-strict" ? "analysis" : "shell";
        if (!policy.strict) {
            throw new SandboxExecutionError("strict-unavailable");
        }
        if (
            policy.network.mediatedDirectTcp &&
            !capabilities.mediatedDirectTcp
        ) {
            throw new SandboxExecutionError("unsupported-capability", {
                cause: new Error("Zerobox lacks mediated direct TCP support"),
            });
        }
        if (
            policy.resources &&
            ((policy.resources.unixSockets.length > 0 &&
                !capabilities.arbitraryUnixSockets) ||
                (policy.resources.tcpPublications.length > 0 &&
                    !capabilities.inboundBinding))
        ) {
            throw new SandboxExecutionError("unsupported-capability", {
                cause: new Error(
                    "Zerobox lacks the requested resource controls",
                ),
            });
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
            let statusChannel:
                | Awaited<ReturnType<typeof createZeroboxStatusChannel>>
                | undefined;
            let admissionChannel: Awaited<
                ReturnType<typeof createZeroboxAdmissionChannel>
            >;
            try {
                statusChannel = await this.#createStatusChannel(lease);
                admissionChannel = await this.#createAdmissionChannel(lease);
            } catch (error) {
                const cleanup = await Promise.allSettled([
                    statusChannel?.dispose(),
                    rm(profile.path, { force: true }),
                ]);
                const failures: unknown[] = [];
                for (const result of cleanup) {
                    if (result.status === "rejected")
                        failures.push(result.reason);
                }
                if (failures.length)
                    throw new AggregateError(
                        [error, ...failures],
                        "Sandbox channel preparation and cleanup failed",
                    );
                throw error;
            }
            const preparedStatusChannel = statusChannel;
            let admittedContext: SandboxExecutionContext | undefined;
            return {
                file: this.#binaryPath,
                getSandboxContext: () => admittedContext,
                execution: {
                    status: "unknown",
                    profile: policy.name,
                    backend: "zerobox",
                    tmpNamespace: policy.tmpNamespace,
                    phase: "setup",
                    outcome: "pending",
                },
                args: [
                    `--profile=${profile.name}`,
                    "--strict-sandbox",
                    "--status-fd=3",
                    "--status-version=2",
                    "--admission-fd=4",
                    "--admission-ack-fd=5",
                    `--runtime-bundle=${runtime.root}`,
                    `--runtime-component=${component}`,
                    ...(policy.tmpNamespace === "lease-private"
                        ? [`--private-tmp=${lease.tmpDir}`]
                        : ["--host-tmp"]),
                    `--private-home=${lease.homeDir}`,
                    ...(policy.network.allowLocalBinding
                        ? ["--allow-local-binding"]
                        : []),
                    ...(policy.network.mediatedDirectTcp?.ports ?? []).map(
                        (port) => `--mediated-direct-tcp-port=${port}`,
                    ),
                    ...(policy.resources?.unixSockets ?? []).map(
                        (socket) => `--allow-unix-socket=${socket}`,
                    ),
                    ...(policy.resources?.tcpPublications ?? []).map(
                        (publication) =>
                            `--publish-tcp=${publication.scope}@${publication.listen}->${publication.target}`,
                    ),
                    "-C",
                    command.cwd,
                    "--",
                    command.file,
                    ...command.args,
                ],
                cwd:
                    policy.name === "analysis-strict"
                        ? lease.root
                        : command.cwd,
                env: launcherEnvironment(lease),
                statusProtocol: { fd: 3, version: 2 },
                extraStdio: [
                    preparedStatusChannel.childStdio,
                    admissionChannel.childStdio,
                    admissionChannel.childAckStdio,
                ],
                supervise() {
                    const admission = admissionChannel.read();
                    // The status stream may fail before a receipt is produced.
                    void admission.catch(() => undefined);
                    const status = preparedStatusChannel.supervise({
                        version: 2,
                        onAdmitted: async (sha256) => {
                            const receipt = await admission;
                            if (receipt.sha256 !== sha256)
                                throw new SandboxExecutionError(
                                    "protocol-error",
                                    {
                                        diagnostic:
                                            "Admission digest differs from the status proof",
                                    },
                                );
                            assertAdmissionMatchesPolicy(
                                receipt,
                                materializedPolicy,
                                {
                                    manifestSha256: runtime.manifestSha256,
                                    helperSha256: runtime.helperSha256,
                                    version: runtime.version,
                                    target: runtime.target,
                                    component,
                                    shellRoot: runtime.components.shell.root,
                                    analysisRoot:
                                        runtime.components.analysis.root,
                                },
                            );
                            await admissionChannel.acknowledge(receipt.sha256);
                            admittedContext =
                                createAdmittedSandboxExecutionContext(
                                    receipt,
                                    policy.name,
                                    lease,
                                    { homeDir: homedir() },
                                );
                        },
                    });
                    return {
                        ready: status.ready,
                        settled: Promise.all([status.settled, admission]).then(
                            () => undefined,
                        ),
                    };
                },
                async cleanup() {
                    const failures: unknown[] = [];
                    for (const cleanup of [
                        () => preparedStatusChannel.dispose(),
                        () => admissionChannel.dispose(),
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
