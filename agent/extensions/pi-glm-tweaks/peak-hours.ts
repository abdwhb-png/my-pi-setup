/**
 * Pure model-detection and peak-hours math for pi-glm-tweaks.
 *
 * Kept separate from {@link ./index.ts} so it can be unit-tested without
 * booting the Pi runtime. Wire-level tweaks (clear_thinking, zai
 * thinkingFormat, baseUrl re-registration) stay gated on {@link isZaiGlm52};
 * the fancy-footer widget + peak indicator is gated on the broader
 * {@link isZaiPeakModel}.
 *
 * Peak/quota rules (per Z.AI / cliproxy config):
 *   - GLM-5.2 and GLM-5-Turbo consume quota at 3× during peak hours and 2×
 *     during off-peak hours.
 *   - Limited-time benefit: off-peak is charged at only 1× through the end
 *     of September 2026.
 *   - Peak hours: 14:00–18:00 daily (UTC+8) → 06:00–10:00 UTC.
 *   - GLM-4.7 is unaffected (no peak multiplier).
 *
 * Routes covered:
 *   - built-in:  `zai/glm-5.2`, `zai/glm-5-turbo`
 *   - CPA (ai-providers) z.ai coding route: `cpa/zai-coding/glm-5.2`,
 *     `cpa/zai-coding/glm-5-turbo` — both hit the z.ai coding endpoint.
 *   - Excluded: `cpa/ocg/go-glm-5.2` (OpenCode Go route, different upstream;
 *     zai wire tweaks do not apply there).
 */

/** Base model ids that consume quota at the peak rate. */
export const PEAK_MODEL_IDS: ReadonlySet<string> = new Set([
    "glm-5.2",
    "glm-5-turbo",
]);

/**
 * End of the limited-time off-peak 1× benefit: 2026-09-30 23:59:59 UTC.
 * After this instant off-peak reverts to the standard 2× multiplier.
 *
 * ponytail: single hardcoded cutoff — bump if Z.AI extends the promo.
 */
export const OFF_PEAK_BENEFIT_END_MS = Date.UTC(2026, 8, 30, 23, 59, 59); // month 8 = September

export interface ModelRef {
    provider: string;
    id: string;
}

export type PeakSeverity = "success" | "warning" | "error";

export interface PeakStatus {
    isPeak: boolean;
    multiplier: 1 | 2 | 3;
    label: string;
    severity: PeakSeverity;
}

/**
 * Strip the model id down to its Z.AI base name. Returns `null` when the
 * model is not reachable through a Z.AI route.
 *
 *   `zai/glm-5.2`              → `glm-5.2`
 *   `cpa/zai-coding/glm-5.2`   → `glm-5.2`
 *   `cpa/ocg/go-glm-5.2`       → `null`  (OpenCode Go route, excluded)
 */
function zaiBaseId(model: ModelRef | undefined | null): string | null {
    if (!model) return null;
    if (model.provider === "zai") return model.id;
    if (model.provider === "cpa" && model.id.startsWith("zai-coding/")) {
        return model.id.slice("zai-coding/".length);
    }
    return null;
}

/**
 * Whether `model` is GLM-5.2 reachable through a Z.AI coding route.
 *
 * Gates the Z.AI-specific wire tweaks (clear_thinking, thinkingFormat,
 * coding-endpoint baseUrl) in {@link ./index.ts}.
 */
export function isZaiGlm52(model: ModelRef | undefined | null): boolean {
    return zaiBaseId(model) === "glm-5.2";
}

/**
 * Whether `model` is one of the two quota-consuming Z.AI models (GLM-5.2 or
 * GLM-5-Turbo) on any Z.AI route. Gates the fancy-footer widget + peak
 * indicator. Excludes GLM-4.7 and all non-Z.AI routes.
 */
export function isZaiPeakModel(model: ModelRef | undefined | null): boolean {
    const base = zaiBaseId(model);
    return base !== null && PEAK_MODEL_IDS.has(base);
}

/**
 * Compute the Z.AI peak/quota status for a given instant.
 *
 * Peak window: 14:00–18:00 UTC+8 (= 06:00–10:00 UTC). During peak, quota is
 * consumed at 3× regardless of the benefit. Off-peak is 1× while the
 * limited-time benefit is active, 2× afterwards.
 *
 * @param now - defaults to the current wall clock; injectable for tests.
 */
export function computePeakStatus(now: Date = new Date()): PeakStatus {
    const utcHour = now.getUTCHours();
    const isPeak = utcHour >= 6 && utcHour < 10;

    if (isPeak) {
        return {
            isPeak: true,
            multiplier: 3,
            label: "PEAK 3×",
            severity: "error",
        };
    }

    const benefitActive = now.getTime() <= OFF_PEAK_BENEFIT_END_MS;
    if (benefitActive) {
        return {
            isPeak: false,
            multiplier: 1,
            label: "OFF-PEAK 1×",
            severity: "success",
        };
    }
    return {
        isPeak: false,
        multiplier: 2,
        label: "OFF-PEAK 2×",
        severity: "warning",
    };
}
