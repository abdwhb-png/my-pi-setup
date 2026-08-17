import { CRITICAL_SIGNALS, type TaskAssessment } from "./assessment.ts";
import { PROFILES, type Profile } from "./types.ts";

const rank = { direct: 0, light: 1, standard: 2, critical: 3 } as const;
const STANDARD_BOUNDARY_SIGNALS = [
    "multi_module",
    "public_contract",
    "external_integration",
] as const;

export interface ClassificationResult {
    minimum: Profile;
    rules: string[];
}

export function classifyTask(input: TaskAssessment): ClassificationResult {
    const rules: string[] = [];
    let minimum: Profile = "direct";
    if (
        CRITICAL_SIGNALS.some((criticalSignal) =>
            input.signals.includes(criticalSignal),
        )
    ) {
        minimum = "critical";
        rules.push("critical-signal");
    } else if (
        STANDARD_BOUNDARY_SIGNALS.some((boundarySignal) =>
            input.signals.includes(boundarySignal),
        )
    ) {
        minimum = "standard";
        rules.push("standard-boundary");
    } else if (
        input.signals.includes("weak_test_coverage") &&
        input.signals.includes("requirements_uncertainty")
    ) {
        minimum = "standard";
        rules.push("standard-uncertainty-plus-weak-tests");
    } else if (
        input.signals.includes("isolated_scope") &&
        input.signals.includes("clear_requirements")
    ) {
        minimum = "light";
        rules.push("light-positive-scope");
    }
    if (input.confidence === "low" && minimum !== "critical") {
        const escalated = PROFILES[rank[minimum] + 1];
        if (escalated) minimum = escalated;
        rules.push("low-confidence-escalation");
    }
    return { minimum, rules };
}

export function effectiveProfile(
    global: Profile,
    result: ClassificationResult,
    assessment: TaskAssessment,
): Profile {
    if (rank[result.minimum] >= rank[global]) return result.minimum;
    const provenLowRisk =
        assessment.signals.includes("isolated_scope") &&
        assessment.signals.includes("clear_requirements") &&
        assessment.signals.includes("existing_test_pattern") &&
        assessment.confidence === "high";
    return provenLowRisk ? result.minimum : global;
}
