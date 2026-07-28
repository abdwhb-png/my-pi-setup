import { createHash } from "node:crypto";
import { homedir } from "node:os";

type EvidenceCapture = {
    toolCallId: string;
    toolName: string;
    input: Record<string, unknown>;
    content: unknown[];
    details: unknown;
    isError: boolean;
};

type LedgerOptions = {
    runId: string;
    now?: () => string;
    homeDir?: string;
    initialRecords?: readonly ExplorationRecord[];
};

export type ClaimClassification =
    | "empirical"
    | "design-choice"
    | "future-contingency";
export type ClaimVerdict = "verified" | "falsified" | "unresolved";
export type EvidenceSourceKind =
    | "direct"
    | "indexed"
    | "reviewer"
    | "secondary";
export type EvidenceStaleness = "fresh" | "stale" | "unknown";

export type EvidenceRecord = Readonly<{
    id: string;
    kind: "evidence";
    runId: string;
    phase: "exploring";
    sequence: number;
    toolName: string;
    status: "success" | "error";
    timestamp: string;
    sourceRefs: readonly string[];
    inputHash: string;
    outputHash: string;
    nativeRef: string;
    sourceKind: EvidenceSourceKind;
    staleness: EvidenceStaleness;
    reviewer?: Readonly<{
        agent: string;
        context?: "fresh" | "fork";
        exitCode?: number;
        referencedClaimIds: readonly string[];
        referencedEvidenceIds: readonly string[];
    }>;
}>;

export type ClaimRecord = Readonly<{
    id: string;
    kind: "claim";
    runId: string;
    phase: "exploring";
    sequence: number;
    timestamp: string;
    assertion: string;
    classification: ClaimClassification;
    critical: boolean;
    verdict: ClaimVerdict;
    evidenceIds: readonly string[];
    contradictoryEvidenceIds: readonly string[];
    impact: string;
    mitigation: string;
    supersedesClaimId?: string;
}>;

export type RecordClaimInput = {
    assertion: string;
    classification: ClaimClassification;
    critical: boolean;
    verdict: ClaimVerdict;
    evidenceIds: string[];
    contradictoryEvidenceIds: string[];
    impact: string;
    mitigation: string;
    supersedesClaimId?: string;
};

export type ReviewRecord = Readonly<{
    id: string;
    kind: "review";
    runId: string;
    phase: "exploring";
    sequence: number;
    timestamp: string;
    reviewerEvidenceId: string;
    claimIds: readonly string[];
    primaryEvidenceIds: readonly string[];
    summary: string;
}>;

export type RecordReviewInput = {
    reviewerEvidenceId: string;
    claimIds: string[];
    primaryEvidenceIds: string[];
    summary: string;
};

export type WaiverRecord = Readonly<{
    id: string;
    kind: "waiver";
    runId: string;
    phase: "exploring";
    sequence: number;
    timestamp: string;
    claimId: string;
    reason: string;
    impact: string;
    mitigation: string;
    reevaluateWhen: string;
}>;

export type RecordWaiverInput = {
    claimId: string;
    reason: string;
    impact: string;
    mitigation: string;
    reevaluateWhen: string;
};

export type OverrideRecord = Readonly<{
    id: string;
    kind: "override";
    runId: string;
    phase: "exploring";
    sequence: number;
    timestamp: string;
    command: string;
    blockers: readonly string[];
    reason: string;
    fromPhase: string;
    toPhase: string;
}>;

export type RecordOverrideInput = {
    command: string;
    blockers: string[];
    reason: string;
    fromPhase: string;
    toPhase: string;
};

export type ExplorationRecord =
    | EvidenceRecord
    | ClaimRecord
    | ReviewRecord
    | WaiverRecord
    | OverrideRecord;

export function isExplorationRecord(
    value: unknown,
): value is ExplorationRecord {
    const record = asRecord(value);
    return (
        record !== undefined &&
        typeof record.id === "string" &&
        typeof record.runId === "string" &&
        record.phase === "exploring" &&
        typeof record.sequence === "number" &&
        typeof record.timestamp === "string" &&
        typeof record.kind === "string" &&
        ["evidence", "claim", "review", "waiver", "override"].includes(
            record.kind,
        )
    );
}

export type GateSubmission = {
    approachClaimIds: string[][];
    recommendationClaimIds: string[];
    userChoice: string;
};

export type ExplorationApproach = {
    title: string;
    summary: string;
    tradeoffs: string[];
    claimIds: string[];
    failureConditions: string[];
};

export type RenderExplorationInput = {
    approaches: ExplorationApproach[];
    recommendation: string;
    recommendationClaimIds: string[];
    userChoice: string;
};

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
        Object.entries(value)
            .toSorted(([left], [right]) => left.localeCompare(right))
            .map(([key, child]) => [key, canonicalize(child)]),
    );
}

function sha256(value: unknown): string {
    return createHash("sha256")
        .update(JSON.stringify(canonicalize(value)) ?? "undefined")
        .digest("hex");
}

function normalizePath(path: string, homeDir: string): string {
    return path === homeDir
        ? "~"
        : path.startsWith(`${homeDir}/`)
          ? `~/${path.slice(homeDir.length + 1)}`
          : path;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : undefined;
}

function sanitizeUrl(value: string): string {
    try {
        const url = new URL(value);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.toString().replace(/\/$/, "");
    } catch {
        return value.slice(0, 256);
    }
}

function extractSourceRefs(
    input: Record<string, unknown>,
    homeDir: string,
): string[] {
    const refs: string[] = [];
    const pathKeys = new Set([
        "path",
        "paths",
        "filePath",
        "sessionPath",
        "cwd",
    ]);
    const urlKeys = new Set(["url", "urls"]);
    const labelKeys = new Set(["source", "sources", "responseId"]);
    const add = (value: string, kind: "path" | "url" | "label") => {
        const sanitized =
            kind === "path"
                ? normalizePath(value, homeDir)
                : kind === "url"
                  ? sanitizeUrl(value)
                  : value.slice(0, 256);
        if (sanitized && !refs.includes(sanitized) && refs.length < 8)
            refs.push(sanitized);
    };
    const visit = (value: unknown, depth: number): void => {
        if (depth > 4 || refs.length >= 8) return;
        if (Array.isArray(value)) {
            for (const item of value) visit(item, depth + 1);
            return;
        }
        const record = asRecord(value);
        if (!record) return;
        for (const [key, child] of Object.entries(record)) {
            const values = Array.isArray(child) ? child : [child];
            const kind = pathKeys.has(key)
                ? "path"
                : urlKeys.has(key)
                  ? "url"
                  : labelKeys.has(key)
                    ? "label"
                    : undefined;
            if (kind) {
                for (const item of values) {
                    if (typeof item === "string") add(item, kind);
                }
            }
            if (typeof child === "object") visit(child, depth + 1);
        }
    };
    visit(input, 0);
    return refs;
}

function textContent(content: readonly unknown[]): string {
    return content
        .flatMap((item) => {
            const record = asRecord(item);
            return record && typeof record.text === "string"
                ? [record.text]
                : [];
        })
        .join("\n");
}

function recordIds(text: string, prefix: "CL" | "EV"): string[] {
    return [...new Set(text.match(new RegExp(`${prefix}-\\d+`, "g")) ?? [])];
}

function markdownBullets(items: readonly string[]): string[] {
    return items.length > 0 ? items.map((item) => `- ${item}`) : ["- None."];
}

function formatClaimLine(claim: ClaimRecord): string {
    return `${claim.id} [${claim.classification}; ${claim.critical ? "critical" : "non-critical"}; ${claim.verdict}] ${claim.assertion} — evidence: ${claim.evidenceIds.join(", ") || "none"}; impact: ${claim.impact}; mitigation: ${claim.mitigation}`;
}

function deriveActiveClaims(claims: readonly ClaimRecord[]): ClaimRecord[] {
    const superseded = new Set(
        claims.flatMap((claim) =>
            claim.supersedesClaimId ? [claim.supersedesClaimId] : [],
        ),
    );
    return claims.filter((claim) => !superseded.has(claim.id));
}

export function createExplorationLedger(options: LedgerOptions) {
    const now = options.now ?? (() => new Date().toISOString());
    const homeDir = options.homeDir ?? homedir();
    let evidenceCount = 0;
    let claimCount = 0;
    let reviewCount = 0;
    let waiverCount = 0;
    let overrideCount = 0;
    let sequence = 0;
    const evidenceRecords: EvidenceRecord[] = [];
    const claimRecords: ClaimRecord[] = [];
    const reviewRecords: ReviewRecord[] = [];
    const waiverRecords: WaiverRecord[] = [];
    const overrideRecords: OverrideRecord[] = [];

    for (const record of structuredClone(options.initialRecords ?? [])) {
        if (record.runId !== options.runId) continue;
        sequence = Math.max(sequence, record.sequence);
        const number = Number(record.id.slice(3));
        switch (record.kind) {
            case "evidence":
                evidenceCount = Math.max(evidenceCount, number);
                evidenceRecords.push(record);
                break;
            case "claim":
                claimCount = Math.max(claimCount, number);
                claimRecords.push(record);
                break;
            case "review":
                reviewCount = Math.max(reviewCount, number);
                reviewRecords.push(record);
                break;
            case "waiver":
                waiverCount = Math.max(waiverCount, number);
                waiverRecords.push(record);
                break;
            case "override":
                overrideCount = Math.max(overrideCount, number);
                overrideRecords.push(record);
                break;
        }
    }

    return {
        captureEvidence(capture: EvidenceCapture) {
            evidenceCount += 1;
            const sourceRefs = extractSourceRefs(capture.input, homeDir);
            const details = asRecord(capture.details);
            const result = Array.isArray(details?.results)
                ? asRecord(details.results[0])
                : undefined;
            const isReviewer =
                capture.toolName === "subagent" &&
                capture.input.agent === "reviewer";
            const sourceKind =
                capture.toolName === "ctx_search"
                    ? ("indexed" as const)
                    : isReviewer
                      ? ("reviewer" as const)
                      : [
                              "web_search",
                              "pi_session_search",
                              "pi_session_query",
                              "memory_search",
                          ].includes(capture.toolName)
                        ? ("secondary" as const)
                        : ("direct" as const);
            const outputText = textContent(capture.content);
            const reviewerContext: "fresh" | "fork" | undefined =
                capture.input.context === "fresh" ||
                capture.input.context === "fork"
                    ? capture.input.context
                    : undefined;
            const reviewer = isReviewer
                ? {
                      agent:
                          typeof result?.agent === "string"
                              ? result.agent
                              : "reviewer",
                      context: reviewerContext,
                      exitCode:
                          typeof result?.exitCode === "number"
                              ? result.exitCode
                              : undefined,
                      referencedClaimIds: recordIds(outputText, "CL"),
                      referencedEvidenceIds: recordIds(outputText, "EV"),
                  }
                : undefined;
            const evidence: EvidenceRecord = {
                id: `EV-${String(evidenceCount).padStart(3, "0")}`,
                kind: "evidence",
                runId: options.runId,
                phase: "exploring",
                sequence: ++sequence,
                toolName: capture.toolName,
                status: capture.isError ? "error" : "success",
                timestamp: now(),
                sourceRefs,
                inputHash: sha256(capture.input),
                outputHash: sha256(capture.content),
                nativeRef: `session:tool-result:${capture.toolCallId}`,
                sourceKind,
                staleness:
                    details?.stale === true
                        ? "stale"
                        : details?.stale === false
                          ? "fresh"
                          : sourceKind === "indexed"
                            ? "unknown"
                            : "fresh",
                ...(reviewer ? { reviewer } : {}),
            };
            evidenceRecords.push(evidence);
            return structuredClone(evidence);
        },
        recordClaim(input: RecordClaimInput): ClaimRecord {
            const evidence = input.evidenceIds.map((id) => {
                const record = evidenceRecords.find((item) => item.id === id);
                if (!record) throw new Error(`Unknown evidence record: ${id}.`);
                return record;
            });
            if (input.classification === "empirical" && evidence.length === 0)
                throw new Error(
                    "Empirical claims require at least one EV-* record.",
                );
            if (
                input.classification !== "empirical" &&
                input.verdict !== "unresolved"
            )
                throw new Error(
                    `${input.classification} claims must remain unresolved.`,
                );
            if (
                input.verdict !== "unresolved" &&
                !evidence.some(
                    (item) =>
                        item.status === "success" &&
                        item.staleness !== "stale" &&
                        item.sourceKind !== "reviewer",
                )
            )
                throw new Error(
                    `${input.verdict} claims require successful eligible evidence.`,
                );
            if (
                input.critical &&
                input.classification === "empirical" &&
                input.verdict !== "unresolved" &&
                !evidence.some(
                    (item) =>
                        item.status === "success" &&
                        item.staleness === "fresh" &&
                        item.sourceKind === "direct",
                )
            )
                throw new Error(
                    "Critical empirical claims require direct corroborating evidence.",
                );
            for (const id of input.contradictoryEvidenceIds) {
                if (!input.evidenceIds.includes(id))
                    throw new Error(
                        `Contradictory evidence ${id} must also appear in evidenceIds.`,
                    );
            }
            if (
                input.supersedesClaimId &&
                !deriveActiveClaims(claimRecords).some(
                    (claim) => claim.id === input.supersedesClaimId,
                )
            )
                throw new Error(
                    `Unknown active claim: ${input.supersedesClaimId}.`,
                );
            claimCount += 1;
            const claim: ClaimRecord = {
                id: `CL-${String(claimCount).padStart(3, "0")}`,
                kind: "claim",
                runId: options.runId,
                phase: "exploring",
                sequence: ++sequence,
                timestamp: now(),
                assertion: input.assertion,
                classification: input.classification,
                critical: input.critical,
                verdict: input.verdict,
                evidenceIds: [...input.evidenceIds],
                contradictoryEvidenceIds: [...input.contradictoryEvidenceIds],
                impact: input.impact,
                mitigation: input.mitigation,
                ...(input.supersedesClaimId
                    ? { supersedesClaimId: input.supersedesClaimId }
                    : {}),
            };
            claimRecords.push(claim);
            return structuredClone(claim);
        },
        recordReview(input: RecordReviewInput): ReviewRecord {
            const reviewerEvidence = evidenceRecords.find(
                (item) => item.id === input.reviewerEvidenceId,
            );
            if (
                !reviewerEvidence ||
                reviewerEvidence.status !== "success" ||
                reviewerEvidence.sourceKind !== "reviewer" ||
                reviewerEvidence.reviewer?.agent !== "reviewer" ||
                reviewerEvidence.reviewer.context !== "fresh" ||
                reviewerEvidence.reviewer.exitCode !== 0
            )
                throw new Error(
                    "Review requires successful fresh reviewer evidence.",
                );
            const activeClaims = deriveActiveClaims(claimRecords);
            const claims = input.claimIds.map((id) => {
                const claim = activeClaims.find((item) => item.id === id);
                if (!claim) throw new Error(`Unknown active claim: ${id}.`);
                return claim;
            });
            const primaryEvidence = input.primaryEvidenceIds.map((id) => {
                const evidence = evidenceRecords.find((item) => item.id === id);
                if (!evidence)
                    throw new Error(`Unknown evidence record: ${id}.`);
                if (
                    evidence.sourceKind !== "direct" ||
                    evidence.staleness !== "fresh"
                )
                    throw new Error(
                        `Review evidence ${id} is not direct and fresh.`,
                    );
                return evidence;
            });
            if (
                !input.claimIds.every((id) =>
                    reviewerEvidence.reviewer?.referencedClaimIds.includes(id),
                ) ||
                !input.primaryEvidenceIds.every((id) =>
                    reviewerEvidence.reviewer?.referencedEvidenceIds.includes(
                        id,
                    ),
                )
            )
                throw new Error(
                    "Reviewer output must reference every submitted CL-* and EV-* record.",
                );
            if (
                claims.some(
                    (claim) =>
                        claim.classification === "empirical" &&
                        !primaryEvidence.some((evidence) =>
                            claim.evidenceIds.includes(evidence.id),
                        ),
                )
            )
                throw new Error(
                    "Each empirical review claim requires cited primary evidence.",
                );

            reviewCount += 1;
            const review: ReviewRecord = {
                id: `RV-${String(reviewCount).padStart(3, "0")}`,
                kind: "review",
                runId: options.runId,
                phase: "exploring",
                sequence: ++sequence,
                timestamp: now(),
                reviewerEvidenceId: input.reviewerEvidenceId,
                claimIds: [...input.claimIds],
                primaryEvidenceIds: [...input.primaryEvidenceIds],
                summary: input.summary,
            };
            reviewRecords.push(review);
            return structuredClone(review);
        },
        recordWaiver(input: RecordWaiverInput): WaiverRecord {
            const claim = deriveActiveClaims(claimRecords).find(
                (item) => item.id === input.claimId,
            );
            if (!claim)
                throw new Error(`Unknown active claim: ${input.claimId}.`);
            if (!claim.critical || claim.verdict !== "unresolved")
                throw new Error(
                    "Waivers apply only to active unresolved critical claims.",
                );
            waiverCount += 1;
            const waiver: WaiverRecord = {
                id: `WV-${String(waiverCount).padStart(3, "0")}`,
                kind: "waiver",
                runId: options.runId,
                phase: "exploring",
                sequence: ++sequence,
                timestamp: now(),
                claimId: input.claimId,
                reason: input.reason,
                impact: input.impact,
                mitigation: input.mitigation,
                reevaluateWhen: input.reevaluateWhen,
            };
            waiverRecords.push(waiver);
            return structuredClone(waiver);
        },
        getGateBlockers(submission: GateSubmission): string[] {
            const blockers: string[] = [];
            const activeClaims = deriveActiveClaims(claimRecords);
            const activeIds = new Set(activeClaims.map((claim) => claim.id));
            for (const claimIds of submission.approachClaimIds) {
                if (claimIds.length === 0)
                    blockers.push(
                        "Every approach must reference at least one active claim.",
                    );
                for (const id of claimIds) {
                    if (!activeIds.has(id))
                        blockers.push(
                            `Approach references unknown active claim ${id}.`,
                        );
                }
            }
            if (submission.recommendationClaimIds.length === 0)
                blockers.push(
                    "Recommendation must cite at least one active claim.",
                );
            for (const id of submission.recommendationClaimIds) {
                const claim = activeClaims.find((item) => item.id === id);
                if (!claim) {
                    blockers.push(
                        `Recommendation references unknown active claim ${id}.`,
                    );
                    continue;
                }
                if (
                    claim.classification === "empirical" &&
                    claim.verdict === "unresolved"
                )
                    blockers.push(
                        `Recommendation cannot cite unresolved empirical claim ${id}.`,
                    );
            }
            if (!submission.userChoice.trim())
                blockers.push("User choice must be explicit.");

            for (const claim of activeClaims) {
                const waiver = waiverRecords.findLast(
                    (item) => item.claimId === claim.id,
                );
                if (
                    claim.critical &&
                    claim.verdict === "unresolved" &&
                    !waiver
                ) {
                    blockers.push(
                        `${claim.id} requires a user-approved waiver.`,
                    );
                    continue;
                }
                const reviewRequired =
                    (claim.critical && claim.classification === "empirical") ||
                    claim.contradictoryEvidenceIds.length > 0 ||
                    waiver !== undefined;
                if (!reviewRequired) continue;
                const review = reviewRecords.find(
                    (item) =>
                        item.claimIds.includes(claim.id) &&
                        item.sequence > claim.sequence &&
                        (!waiver || item.sequence > waiver.sequence),
                );
                if (!review)
                    blockers.push(
                        `${claim.id} requires a fresh completed review.`,
                    );
            }
            return [...new Set(blockers)];
        },
        renderExplorationMarkdown(input: RenderExplorationInput): string {
            const activeClaims = deriveActiveClaims(claimRecords);
            const evidenceLines = evidenceRecords.map(
                (evidence) =>
                    `${evidence.id} — ${evidence.toolName} — ${evidence.status} — ${evidence.sourceKind}/${evidence.staleness} — sources: ${evidence.sourceRefs.join(", ") || "none"} — input ${evidence.inputHash} — output ${evidence.outputHash} — ${evidence.nativeRef}`,
            );
            const waiverLines = waiverRecords.map(
                (waiver) =>
                    `${waiver.id} for ${waiver.claimId} — reason: ${waiver.reason}; impact: ${waiver.impact}; mitigation: ${waiver.mitigation}; re-evaluate when: ${waiver.reevaluateWhen}`,
            );
            const residualLines = [
                ...activeClaims
                    .filter((claim) => claim.verdict === "unresolved")
                    .map(formatClaimLine),
                ...waiverLines,
            ];
            const approachLines = input.approaches.flatMap(
                (approach, index) => [
                    `### Approach ${index + 1}: ${approach.title}`,
                    "",
                    approach.summary,
                    "",
                    "#### Claims",
                    "",
                    ...markdownBullets(approach.claimIds),
                    "",
                    "#### Trade-offs",
                    "",
                    ...markdownBullets(approach.tradeoffs),
                    "",
                    "#### Conditions for Failure",
                    "",
                    ...markdownBullets(approach.failureConditions),
                    "",
                ],
            );
            const reviewLines = reviewRecords.map(
                (review) =>
                    `${review.id} — reviewer ${review.reviewerEvidenceId}; claims: ${review.claimIds.join(", ")}; primary evidence: ${review.primaryEvidenceIds.join(", ")} — ${review.summary}`,
            );
            const overrideLines = overrideRecords.map(
                (override) =>
                    `${override.id} — ${override.command} — ${override.fromPhase} → ${override.toPhase} — reason: ${override.reason}; blockers: ${override.blockers.join(" | ") || "none"}`,
            );
            return [
                "# Exploring Approaches",
                "",
                "## Assumption Register",
                "",
                ...markdownBullets(activeClaims.map(formatClaimLine)),
                "",
                "## Evidence Index",
                "",
                ...markdownBullets(evidenceLines),
                "",
                "## Verified Findings",
                "",
                ...markdownBullets(
                    activeClaims
                        .filter((claim) => claim.verdict === "verified")
                        .map(formatClaimLine),
                ),
                "",
                "## Falsified Findings",
                "",
                ...markdownBullets(
                    activeClaims
                        .filter((claim) => claim.verdict === "falsified")
                        .map(formatClaimLine),
                ),
                "",
                "## Design Choices",
                "",
                ...markdownBullets(
                    activeClaims
                        .filter(
                            (claim) => claim.classification === "design-choice",
                        )
                        .map(formatClaimLine),
                ),
                "",
                "## Residual Unknowns and Waivers",
                "",
                ...markdownBullets(residualLines),
                "",
                "## Approach Comparison",
                "",
                ...approachLines,
                "## Evidence-backed Recommendation",
                "",
                input.recommendation,
                "",
                `Claims: ${input.recommendationClaimIds.join(", ") || "none"}`,
                "",
                "## Review Record",
                "",
                ...markdownBullets(reviewLines),
                "",
                "## Overrides",
                "",
                ...markdownBullets(overrideLines),
                "",
                "## User Choice",
                "",
                input.userChoice,
            ].join("\n");
        },
        recordOverride(input: RecordOverrideInput): OverrideRecord {
            overrideCount += 1;
            const override: OverrideRecord = {
                id: `OV-${String(overrideCount).padStart(3, "0")}`,
                kind: "override",
                runId: options.runId,
                phase: "exploring",
                sequence: ++sequence,
                timestamp: now(),
                command: input.command,
                blockers: [...input.blockers],
                reason: input.reason,
                fromPhase: input.fromPhase,
                toPhase: input.toPhase,
            };
            overrideRecords.push(override);
            return structuredClone(override);
        },
        getRecords(): ExplorationRecord[] {
            return structuredClone(
                [
                    ...evidenceRecords,
                    ...claimRecords,
                    ...reviewRecords,
                    ...waiverRecords,
                    ...overrideRecords,
                ].toSorted((left, right) => left.sequence - right.sequence),
            );
        },
        getActiveClaims(): ClaimRecord[] {
            return structuredClone(deriveActiveClaims(claimRecords));
        },
    };
}
