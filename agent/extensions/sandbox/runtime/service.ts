import {
    SandboxExecutionError,
    type PrivateTempLease,
    type SandboxBackend,
    type SandboxCapabilities,
    type SandboxCommand,
    type SandboxSpawnSpec,
} from "./contracts.ts";
import {
    createAnalysisPolicy,
    createBashPolicy,
    type PiSandboxConfig,
} from "./policies.ts";
import {
    createPrivateTempLease,
    recoverStalePrivateTempLeases,
} from "./private-temp.ts";

export interface SandboxExecutionHandle {
    spawn: SandboxSpawnSpec;
    dispose(): Promise<void>;
}

export interface SandboxService {
    probe(): Promise<SandboxCapabilities>;
    startBashSession(cwd: string): Promise<void>;
    prepareBash(command: SandboxCommand): Promise<SandboxSpawnSpec>;
    prepareAnalysis(
        command: SandboxCommand,
        readablePaths: string[],
    ): Promise<SandboxExecutionHandle>;
    shutdown(): Promise<void>;
}

export interface SandboxServiceOptions {
    backend: SandboxBackend;
    config: PiSandboxConfig;
    createLease?: () => Promise<PrivateTempLease>;
    recoverStaleLeases?: () => Promise<void>;
    hostEnv?: NodeJS.ProcessEnv;
}

function attachCleanup(primary: unknown, cleanup: unknown): void {
    const detail =
        cleanup instanceof SandboxExecutionError
            ? (cleanup.getCause() ?? cleanup)
            : cleanup;
    if (primary instanceof SandboxExecutionError) {
        primary.attachCleanupError(detail);
    } else if (primary instanceof Error) {
        Object.defineProperty(primary, "cleanupError", {
            configurable: true,
            enumerable: false,
            value: detail,
            writable: true,
        });
    }
}

class DefaultSandboxService implements SandboxService {
    readonly #backend: SandboxBackend;
    readonly #config: PiSandboxConfig;
    readonly #createLease: () => Promise<PrivateTempLease>;
    readonly #hostEnv: NodeJS.ProcessEnv;
    readonly #recoverStaleLeases: () => Promise<void>;
    readonly #analysisHandles = new Set<SandboxExecutionHandle>();
    readonly #orphanLeases = new Set<PrivateTempLease>();
    #bashLease?: PrivateTempLease;
    #bashCwd?: string;
    #closed = false;
    #lifecycle: Promise<void> = Promise.resolve();
    #recovery?: Promise<void>;
    #shutdown?: Promise<void>;

    constructor(options: SandboxServiceOptions) {
        this.#backend = options.backend;
        this.#config = options.config;
        this.#createLease =
            options.createLease ?? (() => createPrivateTempLease());
        this.#recoverStaleLeases =
            options.recoverStaleLeases ??
            (async () => {
                await recoverStalePrivateTempLeases();
            });
        this.#hostEnv = options.hostEnv ?? process.env;
    }

    #recoverOnce(): Promise<void> {
        this.#recovery ??= this.#recoverStaleLeases();
        return this.#recovery;
    }

    probe(): Promise<SandboxCapabilities> {
        return this.#backend.probe();
    }

    #serialize<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.#lifecycle.then(operation, operation);
        this.#lifecycle = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    #assertOpen(): void {
        if (this.#closed) throw new SandboxExecutionError("setup-failed");
    }

    startBashSession(cwd: string): Promise<void> {
        return this.#serialize(async () => {
            this.#assertOpen();
            await this.probe();
            await this.#recoverOnce();
            if (this.#bashLease && this.#bashCwd === cwd) return;
            const previous = this.#bashLease;
            if (previous) {
                await previous.dispose();
                if (this.#bashLease === previous) {
                    this.#bashLease = undefined;
                    this.#bashCwd = undefined;
                }
            }
            const lease = await this.#createLease();
            try {
                createBashPolicy({
                    cwd,
                    lease,
                    config: this.#config,
                    hostEnv: this.#hostEnv,
                });
            } catch (error) {
                try {
                    await lease.dispose();
                } catch (cleanup) {
                    this.#orphanLeases.add(lease);
                    attachCleanup(error, cleanup);
                }
                throw error;
            }
            this.#bashLease = lease;
            this.#bashCwd = cwd;
        });
    }

    prepareBash(command: SandboxCommand): Promise<SandboxSpawnSpec> {
        return this.#serialize(async () => {
            this.#assertOpen();
            const lease = this.#bashLease;
            if (!lease || this.#bashCwd !== command.cwd) {
                throw new SandboxExecutionError("setup-failed");
            }
            const policy = createBashPolicy({
                cwd: command.cwd,
                lease,
                config: this.#config,
                hostEnv: this.#hostEnv,
            });
            const spawn = await this.#backend.prepare(command, policy, lease);
            return {
                ...spawn,
                beforeSpawn: () => {
                    this.#assertOpen();
                    spawn.beforeSpawn?.();
                },
            };
        });
    }

    prepareAnalysis(
        command: SandboxCommand,
        readablePaths: string[],
    ): Promise<SandboxExecutionHandle> {
        return this.#serialize(async () => {
            this.#assertOpen();
            await this.probe();
            await this.#recoverOnce();
            const lease = await this.#createLease();
            const policy = createAnalysisPolicy({
                cwd: command.cwd,
                lease,
                readablePaths,
            });
            let spawn: SandboxSpawnSpec;
            try {
                spawn = await this.#backend.prepare(command, policy, lease);
            } catch (error) {
                try {
                    await lease.dispose();
                } catch (cleanup) {
                    this.#orphanLeases.add(lease);
                    attachCleanup(error, cleanup);
                }
                throw error;
            }

            let disposal: Promise<void> | undefined;
            const handle: SandboxExecutionHandle = {
                spawn,
                dispose: () => {
                    disposal ??= lease
                        .dispose()
                        .then(() => {
                            this.#analysisHandles.delete(handle);
                        })
                        .catch((error) => {
                            disposal = undefined;
                            throw error;
                        });
                    return disposal;
                },
            };
            this.#analysisHandles.add(handle);
            return handle;
        });
    }

    shutdown(): Promise<void> {
        this.#closed = true;
        this.#shutdown ??= this.#serialize(() => this.#shutdownOnce()).finally(
            () => {
                this.#shutdown = undefined;
            },
        );
        return this.#shutdown;
    }

    async #shutdownOnce(): Promise<void> {
        const bashLease = this.#bashLease;
        const handles = [...this.#analysisHandles];
        let primary: unknown;
        const disposals: Array<{
            dispose: () => Promise<void>;
            success: () => void;
        }> = [
            ...(bashLease
                ? [
                      {
                          dispose: () => bashLease.dispose(),
                          success: () => {
                              if (this.#bashLease === bashLease) {
                                  this.#bashLease = undefined;
                                  this.#bashCwd = undefined;
                              }
                          },
                      },
                  ]
                : []),
            ...handles.map((handle) => ({
                dispose: () => handle.dispose(),
                success: () => undefined,
            })),
            ...[...this.#orphanLeases].map((lease) => ({
                dispose: () => lease.dispose(),
                success: () => this.#orphanLeases.delete(lease),
            })),
        ];
        for (const { dispose, success } of disposals) {
            try {
                await dispose();
                success();
            } catch (error) {
                if (primary === undefined) primary = error;
                else attachCleanup(primary, error);
            }
        }
        if (primary !== undefined) throw primary;
    }
}

export function createSandboxService(
    options: SandboxServiceOptions,
): SandboxService {
    return new DefaultSandboxService(options);
}
