import { describe, expect, it } from "bun:test";
import {
    DEFAULT_AUTOPILOT,
    type AutopilotConfig,
    type DangerousModeConfig,
} from "./config.ts";
import {
    budgetStopReason,
    completeAutopilot,
    getRuntimeStatus,
    isAutopilotEnabled,
    isDangerousEnabled,
    recordAutopilotTurn,
    setAutopilotOverride,
    setDangerousOverride,
    startRuntimeSession,
} from "./runtime-state.ts";

function defaultConfig(
    autopilot: Partial<AutopilotConfig> = {},
): DangerousModeConfig {
    return {
        protectedTools: [],
        protectedExtensions: [],
        autopilot: {
            ...DEFAULT_AUTOPILOT,
            guardedTools: [...DEFAULT_AUTOPILOT.guardedTools],
            guardedCommands: [...DEFAULT_AUTOPILOT.guardedCommands],
            ...autopilot,
        },
    };
}

function startAutopilot(
    autopilot: Partial<AutopilotConfig> = {},
): void {
    startRuntimeSession({
        isReload: false,
        dangerousFlag: false,
        autopilotFlag: true,
        config: defaultConfig(autopilot),
        now: 1_000,
    });
}

describe("pi-dangerous-mode runtime state", () => {
    it("keeps Dangerous effective while Autopilot owns one activation source", () => {
        startRuntimeSession({
            isReload: false,
            dangerousFlag: false,
            autopilotFlag: true,
            config: defaultConfig(),
            now: 1_000,
        });

        expect(getRuntimeStatus().dangerous).toMatchObject({
            inducedByAutopilot: true,
            effective: true,
        });
        expect(isAutopilotEnabled()).toBe(true);

        expect(setDangerousOverride(false)).toBe(true);
        expect(isDangerousEnabled()).toBe(true);

        expect(setAutopilotOverride(false, 2_000)).toBe(true);
        expect(isAutopilotEnabled()).toBe(false);
        expect(isDangerousEnabled()).toBe(false);
    });

    it("preserves an explicit Autopilot override through reload", () => {
        startRuntimeSession({
            isReload: false,
            dangerousFlag: false,
            autopilotFlag: false,
            config: defaultConfig(),
            now: 1_000,
        });
        expect(setAutopilotOverride(true, 2_000)).toBe(true);

        startRuntimeSession({
            isReload: true,
            dangerousFlag: false,
            autopilotFlag: false,
            config: defaultConfig(),
            now: 3_000,
        });

        expect(isAutopilotEnabled()).toBe(true);
        expect(getRuntimeStatus().autopilot.override).toBe(true);
    });

    it("resets the Autopilot override for a new session", () => {
        startRuntimeSession({
            isReload: false,
            dangerousFlag: false,
            autopilotFlag: false,
            config: defaultConfig(),
            now: 1_000,
        });
        expect(setAutopilotOverride(true, 2_000)).toBe(true);

        startRuntimeSession({
            isReload: false,
            dangerousFlag: false,
            autopilotFlag: false,
            config: defaultConfig(),
            now: 3_000,
        });

        expect(isAutopilotEnabled()).toBe(false);
        expect(getRuntimeStatus().autopilot.override).toBeUndefined();
    });

    it("records turns and increments retries only for error turns", () => {
        startAutopilot();

        recordAutopilotTurn({ hadError: false, now: 1_100 });
        recordAutopilotTurn({ hadError: true, now: 1_200 });

        expect(getRuntimeStatus().autopilot).toMatchObject({
            phase: "running",
            turnsUsed: 2,
            retriesUsed: 1,
        });
    });

    it("completes with explicit completed or blocked outcomes", () => {
        startAutopilot();
        completeAutopilot({ outcome: "completed", reason: "validated" });
        expect(getRuntimeStatus().autopilot).toMatchObject({
            phase: "completed",
            effective: false,
            stopReason: "validated",
        });

        startAutopilot();
        completeAutopilot({ outcome: "blocked", reason: "protected action" });
        expect(getRuntimeStatus().autopilot).toMatchObject({
            phase: "blocked",
            effective: false,
            stopReason: "protected action",
        });
    });

    it("stops at turn budget", () => {
        startAutopilot({ maxTurns: 2 });

        recordAutopilotTurn({ hadError: false, now: 1_100 });
        recordAutopilotTurn({ hadError: false, now: 1_200 });

        expect(budgetStopReason(1_200)).toBe("turn_budget");
        expect(getRuntimeStatus().autopilot).toMatchObject({
            phase: "budget_exhausted",
            turnsUsed: 2,
            stopReason: "turn_budget",
        });
    });

    it("stops when configured error-turn retry budget is consumed", () => {
        startAutopilot({ maxTurns: 10, maxRetries: 2 });

        recordAutopilotTurn({ hadError: true, now: 1_100 });
        expect(budgetStopReason(1_100)).toBeUndefined();
        recordAutopilotTurn({ hadError: true, now: 1_200 });

        expect(budgetStopReason(1_200)).toBe("retry_budget");
        expect(getRuntimeStatus().autopilot).toMatchObject({
            phase: "budget_exhausted",
            retriesUsed: 2,
            stopReason: "retry_budget",
        });
    });

    it("stops at elapsed-time budget", () => {
        startAutopilot({ maxDurationMs: 100 });

        recordAutopilotTurn({ hadError: false, now: 1_101 });

        expect(budgetStopReason(1_101)).toBe("time_budget");
        expect(getRuntimeStatus().autopilot).toMatchObject({
            phase: "budget_exhausted",
            stopReason: "time_budget",
        });
    });

    it("ignores turn and completion transitions after a terminal phase", () => {
        startAutopilot();
        completeAutopilot({ outcome: "completed", reason: "done" });

        recordAutopilotTurn({ hadError: true, now: 1_200 });
        completeAutopilot({ outcome: "blocked", reason: "late" });

        expect(getRuntimeStatus().autopilot).toMatchObject({
            phase: "completed",
            turnsUsed: 0,
            retriesUsed: 0,
            stopReason: "done",
        });
    });
});
