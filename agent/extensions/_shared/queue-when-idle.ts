const MAX_ATTEMPTS = 200;
const RETRY_DELAY_MS = 50;

export type IdleTaskScheduler = (callback: () => void, delayMs: number) => void;

export interface LatestIdleTaskScheduler {
    schedule(task: () => void | Promise<void>, isIdle?: () => boolean): void;
    invalidate(): void;
}

/** Run a task in a fresh top-level turn context once Pi is idle. */
export function queueWhenIdle(
    task: () => void | Promise<void>,
    isIdle: () => boolean = () => true,
    schedule: IdleTaskScheduler = (callback, delayMs) => {
        setTimeout(callback, delayMs);
    },
): void {
    let attempts = 0;

    const retry = (): void => {
        attempts += 1;
        if (attempts <= MAX_ATTEMPTS) {
            schedule(run, RETRY_DELAY_MS);
        }
    };

    const run = (): void => {
        if (!isIdle()) {
            retry();
            return;
        }

        try {
            Promise.resolve(task()).catch(retry);
        } catch {
            retry();
        }
    };

    schedule(run, 0);
}

/** Queue at most the latest logical task, invalidating older pending work. */
export function createLatestIdleTaskScheduler(
    schedule?: IdleTaskScheduler,
): LatestIdleTaskScheduler {
    let generation = 0;

    return {
        schedule(task, isIdle = () => true): void {
            const taskGeneration = ++generation;
            queueWhenIdle(
                () => {
                    if (taskGeneration !== generation) return;
                    return task();
                },
                () => taskGeneration !== generation || isIdle(),
                schedule,
            );
        },
        invalidate(): void {
            generation += 1;
        },
    };
}
