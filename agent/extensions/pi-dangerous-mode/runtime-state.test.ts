import { describe, expect, it } from "bun:test";
import type { YoloConfig } from "./config.ts";
import {
    getRuntimeStatus,
    isAutopilotEnabled,
    isDangerousEnabled,
    setAutopilotOverride,
    setDangerousOverride,
    startRuntimeSession,
} from "./runtime-state.ts";

function defaultConfig(): YoloConfig {
    return { protectedTools: [], protectedExtensions: [] };
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
});
