import { describe, expect, it } from "bun:test";
import {
    getRuntimeStatus,
    isDangerousEnabled,
    isUnattendedEnabled,
    setUnattendedOverride,
    startRuntimeSession,
} from "./runtime-state.ts";

const config = { protectedTools: [], protectedExtensions: [] };

describe("pi-dangerous-mode unattended state", () => {
    it("is independent from Dangerous and resets only for a new session", () => {
        startRuntimeSession({
            isReload: false,
            dangerousFlag: false,
            config,
        });
        expect(setUnattendedOverride(true)).toBe(true);
        expect(isUnattendedEnabled()).toBe(true);
        expect(isDangerousEnabled()).toBe(false);

        startRuntimeSession({
            isReload: true,
            dangerousFlag: false,
            config,
        });
        expect(getRuntimeStatus().unattended).toMatchObject({
            override: true,
            effective: true,
        });

        startRuntimeSession({
            isReload: false,
            dangerousFlag: false,
            config,
        });
        expect(isUnattendedEnabled()).toBe(false);
    });
});
