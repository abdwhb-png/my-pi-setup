import { describe, expect, it } from "bun:test";
import { createHealthPoller, type HealthState } from "./health";

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createHealthPoller", () => {
    it("runs an immediate ping and reports up", async () => {
        const changes: HealthState[] = [];
        const poller = createHealthPoller({
            ping: async () => true,
            intervalMs: 1000,
            onHealthChange: (health) => changes.push(health),
        });

        await sleep(5);

        expect(poller.health).toBe("up");
        expect(changes).toEqual(["up"]);
        poller.stop();
    });

    it("reports down when the immediate ping fails", async () => {
        const poller = createHealthPoller({
            ping: async () => false,
            intervalMs: 1000,
            onHealthChange: () => {},
        });

        await sleep(5);

        expect(poller.health).toBe("down");
        poller.stop();
    });

    it("treats a throwing ping as down", async () => {
        const poller = createHealthPoller({
            ping: async () => {
                throw new Error("connection refused");
            },
            intervalMs: 1000,
            onHealthChange: () => {},
        });

        await sleep(5);

        expect(poller.health).toBe("down");
        poller.stop();
    });

    it("re-pings on the interval and fires only on transitions", async () => {
        let up = true;
        let pingCount = 0;
        const changes: HealthState[] = [];
        const poller = createHealthPoller({
            ping: async () => {
                pingCount += 1;
                return up;
            },
            intervalMs: 15,
            onHealthChange: (health) => changes.push(health),
        });

        await sleep(5);
        expect(poller.health).toBe("up");
        expect(changes).toEqual(["up"]);

        // Same state again: no duplicate change.
        await sleep(40);
        expect(changes).toEqual(["up"]);

        // State flip up → down: one transition.
        up = false;
        await sleep(40);
        expect(poller.health).toBe("down");
        expect(changes).toEqual(["up", "down"]);

        // Repeated down: no duplicate change.
        await sleep(40);
        expect(changes).toEqual(["up", "down"]);

        // Flip back up.
        up = true;
        await sleep(40);
        expect(poller.health).toBe("up");
        expect(changes).toEqual(["up", "down", "up"]);

        expect(pingCount).toBeGreaterThanOrEqual(5);
        poller.stop();
    });

    it("stops polling after stop()", async () => {
        let pingCount = 0;
        const poller = createHealthPoller({
            ping: async () => {
                pingCount += 1;
                return true;
            },
            intervalMs: 10,
            onHealthChange: () => {},
        });

        await sleep(5);
        poller.stop();
        const afterStop = pingCount;

        await sleep(60);

        expect(pingCount).toBe(afterStop);
    });
});