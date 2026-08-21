/**
 * Backend health polling for the compressor widget.
 *
 * The widget is observation-driven and deliberately never probes the backend
 * during normal rendering. This module adds the missing probe: a small poller
 * that pings the backend on an interval and reports only state transitions, so
 * a stopped Docker service surfaces as `offline` instead of a neutral
 * "no calls yet" line.
 */

export type HealthState = "unknown" | "up" | "down";

const DEFAULT_HEALTH_INTERVAL_MS = 30_000;

export interface HealthPollerOptions {
    ping: () => Promise<boolean>;
    intervalMs?: number;
    onHealthChange: (health: HealthState) => void;
}

export interface HealthPoller {
    readonly health: HealthState;
    stop(): void;
}

/**
 * Create a health poller: pings immediately, then on the interval, and calls
 * `onHealthChange` only when the state flips. `stop()` clears the timer; a
 * pending in-flight check is ignored once stopped.
 */
export function createHealthPoller(options: HealthPollerOptions): HealthPoller {
    let health: HealthState = "unknown";
    let stopped = false;
    let timer: Timer | undefined;
    const intervalMs = options.intervalMs ?? DEFAULT_HEALTH_INTERVAL_MS;

    const setHealth = (next: HealthState): void => {
        if (next === health) return;
        health = next;
        options.onHealthChange(next);
    };

    const check = async (): Promise<void> => {
        if (stopped) return;
        let up = false;
        try {
            up = await options.ping();
        } catch {
            up = false;
        }
        setHealth(up ? "up" : "down");
    };

    void check();
    // Bun and Node expose overlapping timer globals; tsc verifies the handle type,
    // but Oxlint treats the resolved setInterval return value as error-typed here.
    // oxlint-disable-next-line typescript/no-unsafe-assignment
    timer = setInterval(() => void check(), intervalMs);

    return {
        get health() {
            return health;
        },
        stop() {
            stopped = true;
            if (timer !== undefined) clearInterval(timer);
        },
    };
}
