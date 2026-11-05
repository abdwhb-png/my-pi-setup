/** Serializes review lifetimes, including approved file application. */
export class ReviewQueue {
    private tail: Promise<void> = Promise.resolve();
    private controllers = new Set<AbortController>();

    cancel(): void {
        for (const controller of this.controllers) controller.abort();
    }

    idle(): Promise<void> {
        return this.tail;
    }

    run<T>(
        signal: AbortSignal | undefined,
        task: (signal: AbortSignal) => Promise<T>,
    ): Promise<T> {
        const controller = new AbortController();
        this.controllers.add(controller);
        const abort = () => controller.abort();
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        const result = this.tail.then(async () => {
            controller.signal.throwIfAborted();
            return task(controller.signal);
        });
        this.tail = result.then(
            () => {},
            () => {},
        );
        return result.finally(() => {
            signal?.removeEventListener("abort", abort);
            this.controllers.delete(controller);
        });
    }
}
