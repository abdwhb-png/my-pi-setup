import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    readFileSync,
    realpathSync,
    renameSync,
    rmSync,
    closeSync,
    writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { IsolatedWorkspace } from "./state-machine.ts";

export interface GitWorkspaceManagerOptions {
    readonly stateHome?: string;
    readonly onPreparationCheckpoint?: (
        checkpoint: "ledger-written" | "worktree-created",
    ) => void;
    readonly onDeliveryCheckpoint?: (
        checkpoint: "delivery-intent-recorded" | "source-patched",
    ) => void;
}

export interface SddWorkspaceDelivery {
    readonly patchDigest: string;
}

export interface SddWorkspaceExecution {
    resolveExecutionCwd(
        workspace: IsolatedWorkspace,
        sourceCwd: string,
    ): string;
}

interface SourceRepository {
    readonly root: string;
    readonly head: string;
}

interface PatchArtifact {
    readonly directory: string;
    readonly path: string;
    readonly digest: string;
}

interface WorkspaceLedger {
    readonly version: 1;
    readonly runId: string;
    readonly state: "preparing" | "ready";
    readonly preparedAt: string;
    readonly workspace: IsolatedWorkspace;
    readonly delivery?: WorkspaceLedgerDelivery;
}

interface WorkspaceLedgerDelivery {
    readonly status: "pending" | "applying" | "applied";
    readonly patchDigest?: string;
    readonly appliedAt?: string;
}

const CLEAN_WORKTREE_ERROR = "SDD writer runs require a clean Git worktree.";
const APPLY_CLEAN_WORKTREE_ERROR =
    "SDD apply requires the recorded source worktree to be clean.";
const FLOCK_RETRY_COUNT = 20;
const FLOCK_RETRY_DELAY_MS = 25;
const FLOCK_HELD_EXIT_CODE = 75;
const FLOCK_INHERITED_DESCRIPTOR = 3;

class WorkspaceLockHeldError extends Error {
    constructor(lockPath: string) {
        super(`SDD workspace lock is already held: ${lockPath}.`);
    }
}

function lockInheritedDescriptor(descriptor: number, lockPath: string): void {
    const result = spawnSync(
        "flock",
        [
            "-n",
            "-E",
            String(FLOCK_HELD_EXIT_CODE),
            String(FLOCK_INHERITED_DESCRIPTOR),
        ],
        { stdio: ["ignore", "ignore", "pipe", descriptor] },
    );
    if (result.error) {
        throw new Error(`SDD workspace lock command failed: ${lockPath}.`, {
            cause: result.error,
        });
    }
    if (result.status === FLOCK_HELD_EXIT_CODE) {
        throw new WorkspaceLockHeldError(lockPath);
    }
    if (result.status !== 0) {
        const details = result.stderr?.toString().trim();
        throw new Error(
            `SDD workspace lock command failed: ${lockPath}${details ? `: ${details}` : "."}`,
        );
    }
}

export function resolveSddStateHome(): string {
    const configured = process.env.XDG_STATE_HOME?.trim();
    if (configured && isAbsolute(configured)) return configured;
    return join(homedir(), ".local", "state");
}

function canonicalPath(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        throw new Error(`SDD Git worktree path does not exist: ${path}.`);
    }
}

function isValidRunId(runId: string): boolean {
    return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWorkspaceLedger(
    value: unknown,
    runId: string,
): value is WorkspaceLedger {
    if (!isRecord(value) || value.version !== 1 || value.runId !== runId) {
        return false;
    }
    if (value.state !== "preparing" && value.state !== "ready") return false;
    if (typeof value.preparedAt !== "string" || !isRecord(value.workspace)) {
        return false;
    }
    const workspace = value.workspace;
    const workspaceIsValid =
        workspace.mode === "isolated" &&
        typeof workspace.sourceRoot === "string" &&
        typeof workspace.baseCommit === "string" &&
        typeof workspace.worktreePath === "string" &&
        isRecord(workspace.delivery) &&
        (workspace.delivery.status === "pending" ||
            workspace.delivery.status === "applied");
    if (!workspaceIsValid) return false;
    return (
        value.delivery === undefined ||
        isWorkspaceLedgerDelivery(value.delivery)
    );
}

function isWorkspaceLedgerDelivery(
    value: unknown,
): value is WorkspaceLedgerDelivery {
    if (!isRecord(value)) return false;
    if (
        value.status !== "pending" &&
        value.status !== "applying" &&
        value.status !== "applied"
    ) {
        return false;
    }
    return (
        (value.patchDigest === undefined ||
            typeof value.patchDigest === "string") &&
        (value.appliedAt === undefined || typeof value.appliedAt === "string")
    );
}

/**
 * Owns SDD's Git boundary. Every Git invocation uses execFileSync arguments,
 * so user-controlled paths are never interpreted by a shell.
 */
export class GitWorkspaceManager implements SddWorkspaceExecution {
    private readonly stateHome: string;
    private readonly onPreparationCheckpoint?: GitWorkspaceManagerOptions["onPreparationCheckpoint"];
    private readonly onDeliveryCheckpoint?: GitWorkspaceManagerOptions["onDeliveryCheckpoint"];

    constructor(
        private readonly agentDir: string,
        options: GitWorkspaceManagerOptions = {},
    ) {
        this.stateHome =
            options.stateHome && isAbsolute(options.stateHome)
                ? options.stateHome
                : resolveSddStateHome();
        this.onPreparationCheckpoint = options.onPreparationCheckpoint;
        this.onDeliveryCheckpoint = options.onDeliveryCheckpoint;
    }

    async prepare(
        runId: string,
        sourceCwd: string,
    ): Promise<IsolatedWorkspace> {
        if (!isValidRunId(runId)) {
            throw new Error(`Invalid SDD run id for Git worktree: ${runId}.`);
        }
        return this.withRunLock(runId, () =>
            this.prepareLocked(runId, sourceCwd),
        );
    }

    private prepareLocked(runId: string, sourceCwd: string): IsolatedWorkspace {
        const source = this.requireCleanSource(sourceCwd, CLEAN_WORKTREE_ERROR);
        const existing = this.readLedger(runId);
        if (existing) {
            if (
                existing.workspace.sourceRoot !== source.root ||
                existing.workspace.baseCommit !== source.head
            ) {
                throw new Error(
                    `SDD workspace preparation conflict for ${runId}.`,
                );
            }
            return this.finishPreparation(existing, source);
        }

        const workspace: IsolatedWorkspace = {
            mode: "isolated",
            sourceRoot: source.root,
            baseCommit: source.head,
            worktreePath: this.worktreePath(source.root, runId),
            delivery: { status: "pending" },
        };
        this.writeLedger({
            version: 1,
            runId,
            state: "preparing",
            preparedAt: new Date().toISOString(),
            workspace,
            delivery: { status: "pending" },
        });
        this.onPreparationCheckpoint?.("ledger-written");
        return this.finishPreparation(
            {
                version: 1,
                runId,
                state: "preparing",
                preparedAt: new Date().toISOString(),
                workspace,
                delivery: { status: "pending" },
            },
            source,
        );
    }

    private finishPreparation(
        ledger: WorkspaceLedger,
        source: SourceRepository,
    ): IsolatedWorkspace {
        const { workspace } = ledger;
        if (!existsSync(workspace.worktreePath)) {
            if (ledger.state === "ready") {
                throw new Error(
                    `SDD isolated worktree is missing: ${workspace.worktreePath}.`,
                );
            }
            mkdirSync(dirname(workspace.worktreePath), { recursive: true });
            this.git(source.root, [
                "worktree",
                "add",
                "--detach",
                workspace.worktreePath,
                source.head,
            ]);
            this.onPreparationCheckpoint?.("worktree-created");
        }
        this.resolveExecutionCwd(workspace, source.root);
        if (ledger.state !== "ready") {
            this.writeLedger({ ...ledger, state: "ready" });
        }
        return workspace;
    }

    resolveExecutionCwd(
        workspace: IsolatedWorkspace,
        sourceCwd: string,
    ): string {
        const sourceRoot = this.requireSource(sourceCwd).root;
        if (sourceRoot !== workspace.sourceRoot) {
            throw new Error(
                `SDD workspace source root changed: expected ${workspace.sourceRoot}, received ${sourceRoot}.`,
            );
        }
        if (!existsSync(workspace.worktreePath)) {
            throw new Error(
                `SDD isolated worktree is missing: ${workspace.worktreePath}.`,
            );
        }
        const worktreeRoot = canonicalPath(workspace.worktreePath);
        const gitRoot = canonicalPath(
            this.git(worktreeRoot, ["rev-parse", "--show-toplevel"]).trim(),
        );
        if (gitRoot !== worktreeRoot) {
            throw new Error(
                `SDD isolated worktree root changed: expected ${worktreeRoot}, received ${gitRoot}.`,
            );
        }
        const head = this.git(worktreeRoot, ["rev-parse", "HEAD"]).trim();
        if (head !== workspace.baseCommit) {
            throw new Error(
                `SDD isolated worktree HEAD changed: expected ${workspace.baseCommit}, received ${head}.`,
            );
        }
        return worktreeRoot;
    }

    async apply(
        workspace: IsolatedWorkspace,
        sourceCwd: string,
    ): Promise<SddWorkspaceDelivery> {
        const runId = this.workspaceRunId(workspace);
        return this.withRunLock(runId, () =>
            this.applyLocked(workspace, sourceCwd),
        );
    }

    private applyLocked(
        workspace: IsolatedWorkspace,
        sourceCwd: string,
    ): SddWorkspaceDelivery {
        const source = this.requireSource(sourceCwd);
        if (source.root !== workspace.sourceRoot) {
            throw new Error(
                `SDD apply source root changed: expected ${workspace.sourceRoot}, received ${source.root}.`,
            );
        }
        if (source.head !== workspace.baseCommit) {
            throw new Error(
                `SDD apply source HEAD changed: expected ${workspace.baseCommit}, received ${source.head}.`,
            );
        }
        const executionCwd = this.resolveExecutionCwd(workspace, source.root);
        const ledger = this.requireWorkspaceLedger(workspace);
        const patch = this.createPatch(executionCwd, workspace.baseCommit);
        try {
            const delivery = this.ledgerDelivery(ledger);
            if (delivery.status !== "pending") {
                if (delivery.patchDigest !== patch.digest) {
                    throw new Error(
                        `SDD apply delivery journal differs from the isolated workspace: ${workspace.worktreePath}.`,
                    );
                }
                const sourcePatch = this.createPatch(
                    source.root,
                    workspace.baseCommit,
                );
                try {
                    if (sourcePatch.digest === patch.digest) {
                        this.writeLedger({
                            ...ledger,
                            delivery: {
                                status: "applied",
                                patchDigest: patch.digest,
                                appliedAt:
                                    delivery.appliedAt ??
                                    new Date().toISOString(),
                            },
                        });
                        return { patchDigest: patch.digest };
                    }
                } finally {
                    rmSync(sourcePatch.directory, {
                        recursive: true,
                        force: true,
                    });
                }
                if (delivery.status === "applied") {
                    throw new Error(
                        `SDD apply delivery journal does not match the source worktree: ${source.root}.`,
                    );
                }
            }
            this.requireCleanSource(source.root, APPLY_CLEAN_WORKTREE_ERROR);
            const applyingLedger: WorkspaceLedger = {
                ...ledger,
                delivery: { status: "applying", patchDigest: patch.digest },
            };
            this.writeLedger(applyingLedger);
            this.onDeliveryCheckpoint?.("delivery-intent-recorded");
            this.git(source.root, ["apply", "--check", "--binary", patch.path]);
            const rechecked = this.requireCleanSource(
                source.root,
                APPLY_CLEAN_WORKTREE_ERROR,
            );
            if (rechecked.head !== workspace.baseCommit) {
                throw new Error(
                    `SDD apply source HEAD changed: expected ${workspace.baseCommit}, received ${rechecked.head}.`,
                );
            }
            this.git(source.root, ["apply", "--binary", patch.path]);
            this.onDeliveryCheckpoint?.("source-patched");
            this.writeLedger({
                ...applyingLedger,
                delivery: {
                    status: "applied",
                    patchDigest: patch.digest,
                    appliedAt: new Date().toISOString(),
                },
            });
            return { patchDigest: patch.digest };
        } finally {
            rmSync(patch.directory, { recursive: true, force: true });
        }
    }

    private requireCleanSource(
        sourceCwd: string,
        errorMessage: string,
    ): SourceRepository {
        const source = this.requireSource(sourceCwd);
        if (
            this.git(source.root, [
                "status",
                "--porcelain=v1",
                "--untracked-files=all",
            ]).length > 0
        ) {
            throw new Error(errorMessage);
        }
        return source;
    }

    private requireSource(sourceCwd: string): SourceRepository {
        const cwd = canonicalPath(sourceCwd);
        if (
            this.git(cwd, ["rev-parse", "--is-inside-work-tree"]).trim() !==
            "true"
        ) {
            throw new Error(`SDD source is not a Git worktree: ${cwd}.`);
        }
        if (
            this.git(cwd, ["rev-parse", "--is-bare-repository"]).trim() !==
            "false"
        ) {
            throw new Error(
                `SDD source must be a non-bare Git worktree: ${cwd}.`,
            );
        }
        const root = canonicalPath(
            this.git(cwd, ["rev-parse", "--show-toplevel"]).trim(),
        );
        return {
            root,
            head: this.git(root, ["rev-parse", "HEAD"]).trim(),
        };
    }

    private createPatch(
        worktreePath: string,
        baseCommit: string,
    ): PatchArtifact {
        const directory = mkdtempSync(join(tmpdir(), "sdd-patch-"));
        const indexPath = join(directory, "index");
        const path = join(directory, "changes.patch");
        const env = { ...process.env, GIT_INDEX_FILE: indexPath };
        try {
            this.git(worktreePath, ["read-tree", "HEAD"], undefined, env);
            this.git(worktreePath, ["add", "--all"], undefined, env);
            this.gitToFile(
                worktreePath,
                [
                    "diff",
                    "--cached",
                    "--binary",
                    "--full-index",
                    baseCommit,
                    "--",
                ],
                path,
                env,
            );
            return {
                directory,
                path,
                digest: createHash("sha256")
                    .update(readFileSync(path))
                    .digest("hex"),
            };
        } catch (error) {
            rmSync(directory, { recursive: true, force: true });
            throw error;
        }
    }

    private gitToFile(
        cwd: string,
        args: readonly string[],
        outputPath: string,
        env?: NodeJS.ProcessEnv,
    ): void {
        const output = openSync(outputPath, "w");
        try {
            execFileSync("git", args, {
                cwd,
                ...(env === undefined ? {} : { env }),
                stdio: ["ignore", output, "pipe"],
            });
        } catch (error) {
            throw this.gitError(args, error);
        } finally {
            closeSync(output);
        }
    }

    private worktreePath(sourceRoot: string, runId: string): string {
        const sourceKey = createHash("sha256")
            .update(sourceRoot)
            .digest("hex")
            .slice(0, 16);
        return join(
            this.stateHome,
            "pi",
            "sdd-orchestrator",
            "worktrees",
            sourceKey,
            runId,
        );
    }

    private ledgerPath(runId: string): string {
        return join(this.agentDir, ".sdd", "workspaces", `${runId}.json`);
    }

    private workspaceLockPath(runId: string): string {
        return join(
            this.agentDir,
            ".sdd",
            "workspaces",
            `${runId}.kernel-lock`,
        );
    }

    private async withRunLock<T>(
        runId: string,
        action: () => T | Promise<T>,
    ): Promise<T> {
        const lockPath = this.workspaceLockPath(runId);
        mkdirSync(dirname(lockPath), { recursive: true });
        const lock = await this.acquireRunLock(lockPath);
        try {
            return await action();
        } finally {
            await lock.release();
        }
    }

    private async acquireRunLock(
        lockPath: string,
    ): Promise<{ release(): Promise<void> }> {
        let lastError: WorkspaceLockHeldError | undefined;
        for (let attempt = 0; attempt < FLOCK_RETRY_COUNT; attempt += 1) {
            try {
                return this.acquireRunLockOnce(lockPath);
            } catch (error) {
                if (!(error instanceof WorkspaceLockHeldError)) throw error;
                lastError = error;
                if (attempt < FLOCK_RETRY_COUNT - 1) {
                    // Wait briefly for an adjacent sdd_apply caller to persist its result.
                    // oxlint-disable-next-line no-await-in-loop -- each retry needs the prior lock attempt to finish.
                    await new Promise<void>((resolve) => {
                        setTimeout(resolve, FLOCK_RETRY_DELAY_MS);
                    });
                }
            }
        }
        throw lastError ?? new WorkspaceLockHeldError(lockPath);
    }

    private acquireRunLockOnce(lockPath: string): { release(): Promise<void> } {
        let descriptor: number;
        try {
            descriptor = openSync(lockPath, "a");
        } catch (error) {
            throw new Error(
                `SDD workspace lock file could not open: ${lockPath}.`,
                {
                    cause: error,
                },
            );
        }
        try {
            lockInheritedDescriptor(descriptor, lockPath);
        } catch (error) {
            closeSync(descriptor);
            throw error;
        }
        // `flock` locks the inherited open-file description. The short-lived
        // helper exits immediately; Pi retains this descriptor for the action,
        // so the kernel lock cannot outlive Pi or disappear while Pi continues.
        let released = false;
        return {
            async release(): Promise<void> {
                if (released) return;
                released = true;
                closeSync(descriptor);
            },
        };
    }

    private workspaceRunId(workspace: IsolatedWorkspace): string {
        const runId = basename(workspace.worktreePath);
        if (!isValidRunId(runId)) {
            throw new Error(
                `Invalid SDD workspace path for delivery journal: ${workspace.worktreePath}.`,
            );
        }
        return runId;
    }

    private requireWorkspaceLedger(
        workspace: IsolatedWorkspace,
    ): WorkspaceLedger {
        const runId = this.workspaceRunId(workspace);
        const ledger = this.readLedger(runId);
        if (!ledger) {
            throw new Error(
                `SDD workspace delivery journal is missing: ${this.ledgerPath(runId)}.`,
            );
        }
        const recorded = ledger.workspace;
        if (
            recorded.sourceRoot !== workspace.sourceRoot ||
            recorded.baseCommit !== workspace.baseCommit ||
            recorded.worktreePath !== workspace.worktreePath
        ) {
            throw new Error(
                `SDD workspace delivery journal does not match: ${workspace.worktreePath}.`,
            );
        }
        return ledger;
    }

    private ledgerDelivery(ledger: WorkspaceLedger): WorkspaceLedgerDelivery {
        if (ledger.delivery) return ledger.delivery;
        if (ledger.workspace.delivery.status === "applied") {
            return {
                status: "applied",
                patchDigest: ledger.workspace.delivery.patchDigest,
                appliedAt: ledger.workspace.delivery.appliedAt,
            };
        }
        return { status: "pending" };
    }

    private readLedger(runId: string): WorkspaceLedger | null {
        const path = this.ledgerPath(runId);
        if (!existsSync(path)) return null;
        try {
            const value: unknown = JSON.parse(readFileSync(path, "utf8"));
            if (!isWorkspaceLedger(value, runId))
                throw new Error("invalid ledger");
            return value;
        } catch (error) {
            throw new Error(`Invalid SDD workspace ledger: ${path}.`, {
                cause: error,
            });
        }
    }

    private writeLedger(ledger: WorkspaceLedger): void {
        const path = this.ledgerPath(ledger.runId);
        mkdirSync(dirname(path), { recursive: true });
        const temporaryPath = `${path}.${randomUUID()}.tmp`;
        writeFileSync(temporaryPath, `${JSON.stringify(ledger)}\n`, "utf8");
        renameSync(temporaryPath, path);
    }

    private git(
        cwd: string,
        args: readonly string[],
        input?: string,
        env?: NodeJS.ProcessEnv,
    ): string {
        try {
            return execFileSync("git", args, {
                cwd,
                encoding: "utf8",
                ...(input === undefined ? {} : { input }),
                ...(env === undefined ? {} : { env }),
                stdio: ["pipe", "pipe", "pipe"],
            });
        } catch (error) {
            throw this.gitError(args, error);
        }
    }

    private gitError(args: readonly string[], error: unknown): Error {
        const details =
            error && typeof error === "object" && "stderr" in error
                ? String(error.stderr).trim().slice(0, 500)
                : "";
        return new Error(
            `SDD Git command failed: git ${args.join(" ")}${details ? `: ${details}` : "."}`,
            { cause: error },
        );
    }
}
