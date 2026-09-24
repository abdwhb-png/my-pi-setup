import { describe, it, expect } from "bun:test";
import {
    isZaiGlm52,
    isZaiPeakModel,
    computePeakStatus,
    PEAK_MODEL_IDS,
    OFF_PEAK_BENEFIT_END_MS,
} from "./peak-hours.ts";

type Model = { provider: string; id: string };

describe("isZaiGlm52", () => {
    it("matches built-in zai/glm-5.2", () => {
        expect(isZaiGlm52({ provider: "zai", id: "glm-5.2" })).toBe(true);
    });

    it("matches CPA zai-coding route", () => {
        expect(
            isZaiGlm52({ provider: "cpa", id: "zai-coding/glm-5.2" }),
        ).toBe(true);
    });

    it("rejects CPA OpenCode Go route", () => {
        expect(isZaiGlm52({ provider: "cpa", id: "ocg/go-glm-5.2" })).toBe(
            false,
        );
    });

    it("rejects GLM-5-Turbo", () => {
        expect(isZaiGlm52({ provider: "zai", id: "glm-5-turbo" })).toBe(false);
    });

    it("rejects GLM-4.7", () => {
        expect(isZaiGlm52({ provider: "zai", id: "glm-4.7" })).toBe(false);
    });

    it("rejects undefined and unrelated models", () => {
        expect(isZaiGlm52(undefined)).toBe(false);
        expect(isZaiGlm52(null)).toBe(false);
        expect(isZaiGlm52({ provider: "anthropic", id: "claude" })).toBe(false);
    });
});

describe("isZaiPeakModel", () => {
    it("matches GLM-5.2 on both routes", () => {
        expect(isZaiPeakModel({ provider: "zai", id: "glm-5.2" })).toBe(true);
        expect(
            isZaiPeakModel({ provider: "cpa", id: "zai-coding/glm-5.2" }),
        ).toBe(true);
    });

    it("matches GLM-5-Turbo on both routes", () => {
        expect(isZaiPeakModel({ provider: "zai", id: "glm-5-turbo" })).toBe(
            true,
        );
        expect(
            isZaiPeakModel({ provider: "cpa", id: "zai-coding/glm-5-turbo" }),
        ).toBe(true);
    });

    it("rejects GLM-4.7 (no peak multiplier)", () => {
        expect(isZaiPeakModel({ provider: "zai", id: "glm-4.7" })).toBe(false);
        expect(
            isZaiPeakModel({ provider: "cpa", id: "zai-coding/glm-4.7" }),
        ).toBe(false);
    });

    it("rejects non-z.ai and CPA ocg route", () => {
        expect(isZaiPeakModel({ provider: "cpa", id: "ocg/go-glm-5.2" })).toBe(
            false,
        );
        expect(isZaiPeakModel({ provider: "openai", id: "gpt-5" })).toBe(
            false,
        );
    });

    it("rejects undefined/null", () => {
        expect(isZaiPeakModel(undefined)).toBe(false);
        expect(isZaiPeakModel(null)).toBe(false);
    });
});

describe("PEAK_MODEL_IDS", () => {
    it("contains the two quota-consuming base ids", () => {
        expect(PEAK_MODEL_IDS.has("glm-5.2")).toBe(true);
        expect(PEAK_MODEL_IDS.has("glm-5-turbo")).toBe(true);
        expect(PEAK_MODEL_IDS.has("glm-4.7")).toBe(false);
    });
});

describe("computePeakStatus", () => {
    // Peak window is 14:00-18:00 UTC+8 → 06:00-10:00 UTC.
    it("flags peak at 07:00 UTC (15:00 UTC+8)", () => {
        const s = computePeakStatus(new Date("2026-07-15T07:00:00Z"));
        expect(s.isPeak).toBe(true);
        expect(s.multiplier).toBe(3);
        expect(s.severity).toBe("error");
    });

    it("flags peak at boundary 06:00 UTC (14:00 UTC+8)", () => {
        const s = computePeakStatus(new Date("2026-07-15T06:00:00Z"));
        expect(s.isPeak).toBe(true);
        expect(s.multiplier).toBe(3);
    });

    it("flags off-peak at boundary 10:00 UTC (18:00 UTC+8)", () => {
        const s = computePeakStatus(new Date("2026-07-15T10:00:00Z"));
        expect(s.isPeak).toBe(false);
    });

    it("returns 1x off-peak during the limited-time benefit (Jul 2026)", () => {
        const s = computePeakStatus(new Date("2026-07-15T03:00:00Z"));
        expect(s.isPeak).toBe(false);
        expect(s.multiplier).toBe(1);
        expect(s.severity).toBe("success");
    });

    it("returns 2x off-peak after the benefit ends (Oct 2026)", () => {
        const s = computePeakStatus(new Date("2026-10-15T03:00:00Z"));
        expect(s.isPeak).toBe(false);
        expect(s.multiplier).toBe(2);
        expect(s.severity).toBe("warning");
    });

    it("treats the benefit end boundary as still 1x", () => {
        const s = computePeakStatus(new Date(OFF_PEAK_BENEFIT_END_MS));
        expect(s.isPeak).toBe(false);
        expect(s.multiplier).toBe(1);
    });

    it("uses real current time by default", () => {
        const s = computePeakStatus();
        expect([1, 2, 3]).toContain(s.multiplier);
    });
});
