import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
    createHealthPoller,
    type HealthPoller,
    type HealthPollerOptions,
    type HealthState,
} from "./health";

const activePollers: HealthPoller[] = [];

function startPoller(options: HealthPollerOptions): HealthPoller {
    const poller = createHealthPoller(options);
    activePollers.push(poller);
    return poller;
}

async function settleChecks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

async function advance(ms: number): Promise<void> {
    vi.advanceTimersByTime(ms);
    await settleChecks();
}

describe("createHealthPoller", () => {
    beforeEach(() => vi.useFakeTimers());

    afterEach(() => {
        for (const poller of activePollers.splice(0)) poller.stop();
        vi.useRealTimers();
    });

    it("runs an immediate ping and reports up", async () => {
        const changes: HealthState[] = [];
        const poller = startPoller({
            ping: async () => true,
            intervalMs: 1000,
            onHealthChange: (health) => changes.push(health),
        });

        await settleChecks();

        expect(poller.health).toBe("up");
        expect(changes).toEqual(["up"]);
        poller.stop();
    });

    it("reports down after the configured consecutive failures", async () => {
        let up = true;
        const changes: HealthState[] = [];
        const poller = startPoller({
            ping: async () => up,
            intervalMs: 15,
            consecutiveFailuresBeforeDown: 3,
            onHealthChange: (health) => changes.push(health),
        });

        await settleChecks();
        expect(poller.health).toBe("up");

        up = false;
        await advance(15);
        // One failed probe is not enough to declare the backend down.
        expect(poller.health).toBe("up");
        expect(changes).toEqual(["up"]);

        await advance(15);
        // Second failure still under the threshold.
        expect(poller.health).toBe("up");

        await advance(15);
        // Third consecutive failure flips to down.
        expect(poller.health).toBe("down");
        expect(changes).toEqual(["up", "down"]);
        poller.stop();
    });

    it("recovers to up on the first successful probe after failures", async () => {
        let up = true;
        const changes: HealthState[] = [];
        const poller = startPoller({
            ping: async () => up,
            intervalMs: 15,
            consecutiveFailuresBeforeDown: 2,
            onHealthChange: (health) => changes.push(health),
        });

        // Down after two consecutive failures.
        up = false;
        await settleChecks();
        await advance(30);
        expect(poller.health).toBe("down");

        // Single success resets the streak and restores up immediately.
        up = true;
        await advance(15);
        expect(poller.health).toBe("up");
        expect(changes).toEqual(["up", "down", "up"]);
        poller.stop();
    });

    it("defaults to two consecutive failures before down", async () => {
        let up = true;
        const changes: HealthState[] = [];
        const poller = startPoller({
            ping: async () => up,
            intervalMs: 15,
            onHealthChange: (health) => changes.push(health),
        });

        await settleChecks();
        expect(poller.health).toBe("up");

        up = false;
        await advance(15);
        expect(poller.health).toBe("up");

        await advance(15);
        expect(poller.health).toBe("down");
        expect(changes).toEqual(["up", "down"]);
        poller.stop();
    });

    it("treats a throwing ping as a failure counted toward the threshold", async () => {
        let shouldThrow = true;
        const poller = startPoller({
            ping: async () => {
                if (shouldThrow) throw new Error("connection refused");
                return true;
            },
            intervalMs: 15,
            consecutiveFailuresBeforeDown: 2,
            onHealthChange: () => {},
        });

        await settleChecks();
        await advance(15);
        expect(poller.health).toBe("down");

        shouldThrow = false;
        await advance(15);
        expect(poller.health).toBe("up");
        poller.stop();
    });

    it("re-pings on the interval and fires only on transitions", async () => {
        let up = true;
        let pingCount = 0;
        const changes: HealthState[] = [];
        const poller = startPoller({
            ping: async () => {
                pingCount += 1;
                return up;
            },
            intervalMs: 15,
            onHealthChange: (health) => changes.push(health),
        });

        await settleChecks();
        expect(poller.health).toBe("up");
        expect(changes).toEqual(["up"]);

        // Same state again: no duplicate change.
        await advance(45);
        expect(changes).toEqual(["up"]);

        // State flip up → down: one transition after two consecutive failures.
        up = false;
        await advance(30);
        expect(changes).toEqual(["up", "down"]);

        // Repeated down: no duplicate change.
        await advance(45);
        expect(poller.health).toBe("down");
        expect(changes).toEqual(["up", "down"]);

        // Flip back up. One success suffices.
        up = true;
        await advance(15);
        expect(changes).toEqual(["up", "down", "up"]);

        expect(pingCount).toBeGreaterThanOrEqual(5);
        poller.stop();
    });

    it("stops polling after stop()", async () => {
        let pingCount = 0;
        const poller = startPoller({
            ping: async () => {
                pingCount += 1;
                return true;
            },
            intervalMs: 10,
            onHealthChange: () => {},
        });

        await settleChecks();
        poller.stop();
        const afterStop = pingCount;

        await advance(60);

        expect(pingCount).toBe(afterStop);
    });
});
