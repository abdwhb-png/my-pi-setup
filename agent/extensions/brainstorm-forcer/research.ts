export const BRAINSTORM_RESEARCH_DOMAINS = ["local-code", "external"] as const;

export type BrainstormResearchDomain =
    (typeof BRAINSTORM_RESEARCH_DOMAINS)[number];

export type BrainstormResearchInput = Readonly<{
    domain: BrainstormResearchDomain;
    question: string;
    sources: readonly string[];
}>;

export type BrainstormResearchResult = Readonly<{
    summary: string;
    findings: readonly Readonly<{
        finding: string;
        sourceRefs: readonly string[];
    }>[];
    gaps: readonly string[];
}>;

const RESEARCH_ROUTING: Readonly<Record<BrainstormResearchDomain, string>> = {
    "local-code": "brainstorm-scout",
    external: "factual-researcher",
};

export const BRAINSTORM_RESEARCH_OUTPUT_SCHEMA = {
    type: "object",
    properties: {
        summary: { type: "string", minLength: 1, maxLength: 2_000 },
        findings: {
            type: "array",
            minItems: 1,
            maxItems: 12,
            items: {
                type: "object",
                properties: {
                    finding: {
                        type: "string",
                        minLength: 1,
                        maxLength: 1_000,
                    },
                    sourceRefs: {
                        type: "array",
                        minItems: 1,
                        maxItems: 8,
                        items: {
                            type: "string",
                            minLength: 1,
                            maxLength: 256,
                        },
                    },
                },
                required: ["finding", "sourceRefs"],
                additionalProperties: false,
            },
        },
        gaps: {
            type: "array",
            maxItems: 12,
            items: { type: "string", minLength: 1, maxLength: 500 },
        },
    },
    required: ["summary", "findings", "gaps"],
    additionalProperties: false,
} as const satisfies Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(
    value: Record<string, unknown>,
    allowed: readonly string[],
): boolean {
    const allowedKeys = new Set(allowed);
    return Object.keys(value).every((key) => allowedKeys.has(key));
}

function boundedStrings(
    value: unknown,
    minItems: number,
    maxItems: number,
    maxLength: number,
): value is string[] {
    return (
        Array.isArray(value) &&
        value.length >= minItems &&
        value.length <= maxItems &&
        value.every(
            (item) =>
                typeof item === "string" &&
                item.trim().length > 0 &&
                item.length <= maxLength,
        )
    );
}

export function validateResearchResult(value: unknown): {
    ok: boolean;
    blockers: string[];
} {
    const result = isRecord(value) ? value : undefined;
    const blockers: string[] = [];
    if (result && !hasOnlyKeys(result, ["summary", "findings", "gaps"])) {
        blockers.push("Research result contains unsupported fields.");
    }
    if (
        result &&
        Array.isArray(result.findings) &&
        result.findings.some(
            (item) =>
                isRecord(item) && !hasOnlyKeys(item, ["finding", "sourceRefs"]),
        )
    ) {
        blockers.push("Research finding contains unsupported fields.");
    }
    if (
        !result ||
        typeof result.summary !== "string" ||
        !result.summary.trim() ||
        result.summary.length > 2_000
    ) {
        blockers.push("Research result requires a bounded summary.");
    }
    if (
        !result ||
        !Array.isArray(result.findings) ||
        !result.findings.length ||
        result.findings.length > 12
    ) {
        blockers.push("Research result requires between one and 12 findings.");
    } else if (
        result.findings.some((item) => {
            const finding = isRecord(item) ? item : undefined;
            return !(
                finding &&
                typeof finding.finding === "string" &&
                finding.finding.trim() &&
                finding.finding.length <= 1_000
            );
        })
    ) {
        blockers.push("Each research finding requires bounded text.");
    }
    if (
        result &&
        Array.isArray(result.findings) &&
        result.findings.some((item) => {
            const finding = isRecord(item) ? item : undefined;
            return !boundedStrings(finding?.sourceRefs, 1, 8, 256);
        })
    ) {
        blockers.push(
            "Each research finding requires at least one source reference.",
        );
    }
    if (!result || !boundedStrings(result.gaps, 0, 12, 500)) {
        blockers.push("Research result requires a bounded gaps list.");
    }
    return { ok: blockers.length === 0, blockers };
}

export function parseResearchResult(value: unknown): BrainstormResearchResult {
    const validation = validateResearchResult(value);
    if (!validation.ok)
        throw new Error(
            `Malformed brainstorm research result: ${validation.blockers.join(" ")}`,
        );
    if (
        !isRecord(value) ||
        typeof value.summary !== "string" ||
        !Array.isArray(value.findings) ||
        !boundedStrings(value.gaps, 0, 12, 500)
    ) {
        throw new Error("Malformed brainstorm research result.");
    }
    const findings = value.findings.map((item) => {
        if (
            !isRecord(item) ||
            typeof item.finding !== "string" ||
            !boundedStrings(item.sourceRefs, 1, 8, 256)
        ) {
            throw new Error("Malformed brainstorm research finding.");
        }
        return {
            finding: item.finding,
            sourceRefs: [...item.sourceRefs],
        };
    });
    return {
        summary: value.summary,
        findings,
        gaps: [...value.gaps],
    };
}

export function buildResearchDelegation(input: BrainstormResearchInput) {
    const agent = RESEARCH_ROUTING[input.domain];
    if (!agent)
        throw new Error(
            `Unsupported brainstorm research domain: ${input.domain}.`,
        );
    return {
        agent,
        context: "fresh" as const,
        schema: BRAINSTORM_RESEARCH_OUTPUT_SCHEMA,
        task: [
            `Research question: ${input.question}`,
            `Requested sources/scope: ${input.sources.join(", ") || "not specified"}`,
            "Inspect only this question and its directly relevant evidence.",
            "Return observed findings with precise source references and unresolved gaps. Do not propose implementation, modify files, or delegate.",
        ].join("\n"),
    };
}
