import type { ExecutionTimings } from "../execution-provenance/types.ts";

/** One monotonic budget shared by preparation, admission and the child process. */
export class ExecutionDeadline {
    readonly #controller = new AbortController();
    #failure?: Error;
    readonly #external?: AbortSignal;
    readonly #onExternalAbort = () => this.cancel(new Error("aborted"));
    readonly #timer?: ReturnType<typeof setTimeout>;
    readonly deadlineMs?: number;
    readonly timeout?: number;
    readonly timingsMs: ExecutionTimings = {};

    constructor(timeout?: number, signal?: AbortSignal) {
        this.timeout = timeout;
        this.#external = signal;
        if (signal?.aborted) this.#onExternalAbort();
        else
            signal?.addEventListener("abort", this.#onExternalAbort, {
                once: true,
            });
        if (timeout !== undefined && timeout > 0 && Number.isFinite(timeout)) {
            this.deadlineMs = performance.now() + timeout * 1000;
            this.#timer = setTimeout(
                () => this.cancel(new Error(`timeout:${timeout}`)),
                timeout * 1000,
            );
        }
    }

    get signal(): AbortSignal {
        return this.#controller.signal;
    }

    cancel(reason: Error): void {
        if (this.signal.aborted) return;
        this.#failure = reason;
        this.#controller.abort(reason);
    }

    get interruptionOutcome(): "timed-out" | "aborted" | undefined {
        return this.#failure
            ? this.#failure.message.startsWith("timeout:")
                ? "timed-out"
                : "aborted"
            : undefined;
    }

    async measure<T>(
        phase: keyof ExecutionDeadline["timingsMs"],
        operation: () => Promise<T>,
    ): Promise<T> {
        this.check();
        const start = performance.now();
        try {
            return await this.wait(operation());
        } finally {
            this.timingsMs[phase] =
                (this.timingsMs[phase] ?? 0) + performance.now() - start;
        }
    }

    check(): void {
        if (
            !this.signal.aborted &&
            this.deadlineMs !== undefined &&
            performance.now() >= this.deadlineMs
        )
            this.cancel(new Error(`timeout:${this.timeout}`));
        if (this.signal.aborted) throw this.#failure;
    }

    wait<T>(
        pending: Promise<T>,
        onLate?: (value: T) => void | Promise<void>,
        onCleanupError?: (error: unknown) => void,
    ): Promise<T> {
        return new Promise((resolve, reject) => {
            let cancelled = false;
            const abort = () => {
                cancelled = true;
                reject(this.#failure);
            };
            pending.then(
                (value) => {
                    this.signal.removeEventListener("abort", abort);
                    if (cancelled) {
                        if (onLate)
                            void Promise.resolve()
                                .then(() => onLate(value))
                                .catch((error) => {
                                    Object.defineProperty(
                                        this.#failure!,
                                        "cleanupError",
                                        { value: error, configurable: true },
                                    );
                                    onCleanupError?.(error);
                                });
                    } else resolve(value);
                },
                (error) => {
                    this.signal.removeEventListener("abort", abort);
                    reject(error);
                },
            );
            try {
                this.check();
            } catch {
                abort();
                return;
            }
            this.signal.addEventListener("abort", abort, { once: true });
        });
    }

    dispose(): void {
        if (this.#timer !== undefined) clearTimeout(this.#timer);
        this.#external?.removeEventListener("abort", this.#onExternalAbort);
    }
}
