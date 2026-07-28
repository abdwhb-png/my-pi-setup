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
export type ReviewOutcome = "supported" | "rejected" | "unresolved";
export type EvidenceSourceKind =
    | "direct"
    | "indexed"
    | "reviewer"
    | "secondary"
    | "derived"
    | "ineligible";
export type EvidenceStaleness = "fresh" | "stale" | "unknown";

const DIRECT_EVIDENCE_TOOLS = new Set([
    "read",
    "grep",
    "find",
    "ls",
    "lsp_diagnostics",
    "lens_diagnostics",
    "symbol_search",
    "module_report",
    "read_symbol",
    "read_enclosing",
    "ast_grep_search",
    "ast_grep_outline",
    "ast_grep_dump",
    "lsp_navigation",
    "fetch_content",
]);

const DERIVED_EVIDENCE_TOOLS = new Set(["ctx_execute", "ctx_batch_execute"]);

const SECONDARY_EVIDENCE_TOOLS = new Set([
    "web_search",
    "source_check",
    "context7_query-docs",
    "deepwiki_ask_question",
    "deepwiki_read_wiki_contents",
    "deepwiki_read_wiki_structure",
    "pi_session_search",
    "pi_session_query",
    "session_search",
    "memory_search",
    "get_search_content",
]);

function classifyEvidenceSource(
    toolName: string,
    sourceRefs: readonly string[],
    reviewer: boolean,
): EvidenceSourceKind {
    if (toolName === "ctx_search") return "indexed";
    if (reviewer) return "reviewer";
    if (toolName === "subagent" || SECONDARY_EVIDENCE_TOOLS.has(toolName))
        return "secondary";
    if (DERIVED_EVIDENCE_TOOLS.has(toolName)) return "derived";
    if (toolName === "ctx_execute_file")
        return sourceRefs.length > 0 ? "direct" : "derived";
    return DIRECT_EVIDENCE_TOOLS.has(toolName) ? "direct" : "ineligible";
}

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
    userChoiceQuestionHash?: string;
    userResponseHashes?: readonly string[];
    reviewer?: Readonly<{
        agent: string;
        context?: "fresh" | "fork";
        exitCode?: number;
        outcome?: ReviewOutcome;
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
    outcome: ReviewOutcome;
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

function isStringArray(
    value: unknown,
    pattern?: RegExp,
    maxLength = 64,
): value is string[] {
    return (
        Array.isArray(value) &&
        value.length <= maxLength &&
        value.every(
            (item) =>
                typeof item === "string" && (!pattern || pattern.test(item)),
        )
    );
}

function hasRecordBase(
    record: Record<string, unknown>,
    kind: ExplorationRecord["kind"],
    prefix: "EV" | "CL" | "RV" | "WV" | "OV",
): boolean {
    if (
        record.kind !== kind ||
        typeof record.id !== "string" ||
        !new RegExp(`^${prefix}-\\d+$`).test(record.id) ||
        typeof record.runId !== "string" ||
        !record.runId.trim() ||
        record.phase !== "exploring" ||
        !Number.isSafeInteger(record.sequence) ||
        Number(record.sequence) <= 0 ||
        typeof record.timestamp !== "string" ||
        !record.timestamp.trim()
    )
        return false;
    const idNumber = Number(record.id.slice(3));
    return Number.isSafeInteger(idNumber) && idNumber > 0;
}

function isReviewerMetadata(value: unknown): boolean {
    const reviewer = asRecord(value);
    return (
        reviewer !== undefined &&
        reviewer.agent === "reviewer" &&
        (reviewer.context === "fresh" || reviewer.context === "fork") &&
        (reviewer.exitCode === undefined ||
            Number.isSafeInteger(reviewer.exitCode)) &&
        (reviewer.outcome === undefined ||
            reviewOutcome(reviewer.outcome) !== undefined) &&
        isStringArray(reviewer.referencedClaimIds, /^CL-\d+$/) &&
        isStringArray(reviewer.referencedEvidenceIds, /^EV-\d+$/)
    );
}

export function isExplorationRecord(
    value: unknown,
): value is ExplorationRecord {
    const record = asRecord(value);
    if (!record || typeof record.kind !== "string") return false;
    switch (record.kind) {
        case "evidence":
            return (
                hasRecordBase(record, "evidence", "EV") &&
                typeof record.toolName === "string" &&
                Boolean(record.toolName.trim()) &&
                (record.status === "success" || record.status === "error") &&
                isStringArray(record.sourceRefs, undefined, 8) &&
                typeof record.inputHash === "string" &&
                /^[a-f0-9]{64}$/.test(record.inputHash) &&
                typeof record.outputHash === "string" &&
                /^[a-f0-9]{64}$/.test(record.outputHash) &&
                typeof record.nativeRef === "string" &&
                Boolean(record.nativeRef.trim()) &&
                [
                    "direct",
                    "indexed",
                    "reviewer",
                    "secondary",
                    "derived",
                    "ineligible",
                ].includes(String(record.sourceKind)) &&
                ["fresh", "stale", "unknown"].includes(
                    String(record.staleness),
                ) &&
                ((record.userChoiceQuestionHash === undefined &&
                    record.userResponseHashes === undefined) ||
                    (typeof record.userChoiceQuestionHash === "string" &&
                        /^[a-f0-9]{64}$/.test(record.userChoiceQuestionHash) &&
                        isStringArray(
                            record.userResponseHashes,
                            /^[a-f0-9]{64}$/,
                            8,
                        ) &&
                        record.userResponseHashes.length > 0)) &&
                (record.reviewer === undefined ||
                    isReviewerMetadata(record.reviewer))
            );
        case "claim":
            return (
                hasRecordBase(record, "claim", "CL") &&
                typeof record.assertion === "string" &&
                Boolean(record.assertion.trim()) &&
                ["empirical", "design-choice", "future-contingency"].includes(
                    String(record.classification),
                ) &&
                typeof record.critical === "boolean" &&
                ["verified", "falsified", "unresolved"].includes(
                    String(record.verdict),
                ) &&
                isStringArray(record.evidenceIds, /^EV-\d+$/) &&
                isStringArray(record.contradictoryEvidenceIds, /^EV-\d+$/) &&
                typeof record.impact === "string" &&
                Boolean(record.impact.trim()) &&
                typeof record.mitigation === "string" &&
                Boolean(record.mitigation.trim()) &&
                (record.supersedesClaimId === undefined ||
                    (typeof record.supersedesClaimId === "string" &&
                        /^CL-\d+$/.test(record.supersedesClaimId)))
            );
        case "review":
            return (
                hasRecordBase(record, "review", "RV") &&
                typeof record.reviewerEvidenceId === "string" &&
                /^EV-\d+$/.test(record.reviewerEvidenceId) &&
                reviewOutcome(record.outcome) !== undefined &&
                isStringArray(record.claimIds, /^CL-\d+$/) &&
                record.claimIds.length > 0 &&
                isStringArray(record.primaryEvidenceIds, /^EV-\d+$/) &&
                record.primaryEvidenceIds.length > 0 &&
                typeof record.summary === "string" &&
                Boolean(record.summary.trim())
            );
        case "waiver":
            return (
                hasRecordBase(record, "waiver", "WV") &&
                typeof record.claimId === "string" &&
                /^CL-\d+$/.test(record.claimId) &&
                [
                    record.reason,
                    record.impact,
                    record.mitigation,
                    record.reevaluateWhen,
                ].every(
                    (item) => typeof item === "string" && Boolean(item.trim()),
                )
            );
        case "override":
            return (
                hasRecordBase(record, "override", "OV") &&
                typeof record.command === "string" &&
                Boolean(record.command.trim()) &&
                isStringArray(record.blockers) &&
                typeof record.reason === "string" &&
                Boolean(record.reason.trim()) &&
                typeof record.fromPhase === "string" &&
                Boolean(record.fromPhase.trim()) &&
                typeof record.toPhase === "string" &&
                Boolean(record.toPhase.trim())
            );
        default:
            return false;
    }
}

export type GateSubmission = {
    approachClaimIds: string[][];
    recommendationClaimIds: string[];
    userChoice: string;
    userChoiceEvidenceId?: string;
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
    userChoiceEvidenceId?: string;
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

function reviewerChainStep(
    input: Record<string, unknown>,
): Record<string, unknown> | undefined {
    if (
        input.async !== false ||
        input.context !== "fresh" ||
        !Array.isArray(input.chain) ||
        input.chain.length !== 1
    )
        return undefined;
    const step = asRecord(input.chain[0]);
    return step?.agent === "reviewer" &&
        typeof step.task === "string" &&
        step.task.trim() &&
        step.outputSchema !== null &&
        typeof step.outputSchema === "object" &&
        !Array.isArray(step.outputSchema)
        ? step
        : undefined;
}

function hashSourceRef(value: string): string {
    return `sha256:${sha256(value).slice(0, 12)}`;
}

function containsSensitiveSource(value: string): boolean {
    return (
        /(?:^|[^a-z0-9])(bearer|password|passwd|secret|token|api[_-]?key|authorization)(?:[^a-z0-9]|$)/i.test(
            value,
        ) ||
        /\b(?:sk|ghp|github_pat|glpat|xox[baprs])[-_][a-z0-9_-]{6,}/i.test(
            value,
        ) ||
        value
            .split(/[/:]/)
            .some(
                (segment) =>
                    segment.length >= 24 &&
                    /[a-z]/i.test(segment) &&
                    /\d/.test(segment) &&
                    /^[a-z0-9._-]+$/i.test(segment),
            )
    );
}

function sanitizeUrl(value: string): string {
    try {
        const url = new URL(value);
        if (url.protocol !== "http:" && url.protocol !== "https:")
            return hashSourceRef(value);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        if (containsSensitiveSource(url.pathname))
            url.pathname = `/${hashSourceRef(url.pathname)}`;
        return url.toString().replace(/\/$/, "");
    } catch {
        return hashSourceRef(value);
    }
}

function sanitizeSourceRef(
    value: string,
    kind: "path" | "url" | "label" | "identifier",
    homeDir: string,
): string {
    const bounded = value.trim().slice(0, 256);
    if (!bounded) return "";
    if (kind === "identifier") return hashSourceRef(bounded);
    if (kind === "url") return sanitizeUrl(bounded);
    if (/[\r\n]/.test(bounded) || containsSensitiveSource(bounded))
        return hashSourceRef(bounded);
    if (kind === "label" && !/^[\p{L}\p{N} ._:/-]+$/u.test(bounded))
        return hashSourceRef(bounded);
    return kind === "path" ? normalizePath(bounded, homeDir) : bounded;
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
    const labelKeys = new Set(["source", "sources"]);
    const identifierKeys = new Set(["responseId"]);
    const add = (
        value: string,
        kind: "path" | "url" | "label" | "identifier",
    ) => {
        const sanitized = sanitizeSourceRef(value, kind, homeDir);
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
                    : identifierKeys.has(key)
                      ? "identifier"
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

function normalizedResponseHash(value: string): string | undefined {
    const normalized = value
        .normalize("NFKC")
        .trim()
        .replace(/\s+/g, " ")
        .toLowerCase();
    return normalized ? sha256(normalized) : undefined;
}

function userChoiceProvenance(
    input: Record<string, unknown>,
    details: unknown,
): { questionHash: string; responseHashes: string[] } | undefined {
    const result = asRecord(details);
    if (
        !Array.isArray(input.questions) ||
        input.questions.length !== 1 ||
        result?.cancelled !== false ||
        !Array.isArray(result.answers) ||
        result.answers.length !== 1
    )
        return undefined;
    const question = asRecord(input.questions[0]);
    const answer = asRecord(result.answers[0]);
    const questionHash =
        question && typeof question.question === "string"
            ? normalizedResponseHash(question.question)
            : undefined;
    if (
        !questionHash ||
        !answer ||
        typeof answer.question !== "string" ||
        questionHash !== normalizedResponseHash(answer.question) ||
        answer.questionIndex !== 0
    )
        return undefined;
    const hashes: string[] = [];
    const add = (value: string) => {
        const hash = normalizedResponseHash(value);
        if (hash && !hashes.includes(hash) && hashes.length < 8)
            hashes.push(hash);
    };
    if (typeof answer.answer === "string") add(answer.answer);
    if (Array.isArray(answer.selected)) {
        const selected = answer.selected.filter(
            (value): value is string => typeof value === "string",
        );
        for (const value of selected) add(value);
        if (selected.length > 0) add(selected.join(", "));
    }
    return hashes.length > 0
        ? { questionHash, responseHashes: hashes }
        : undefined;
}

function structuredIds(value: unknown, prefix: "CL" | "EV"): string[] {
    if (!Array.isArray(value)) return [];
    const pattern = new RegExp(`^${prefix}-\\d+$`);
    return [
        ...new Set(
            value.filter(
                (item): item is string =>
                    typeof item === "string" && pattern.test(item),
            ),
        ),
    ];
}

function reviewOutcome(value: unknown): ReviewOutcome | undefined {
    switch (value) {
        case "supported":
        case "rejected":
        case "unresolved":
            return value;
        default:
            return undefined;
    }
}

function expectedReviewOutcome(verdict: ClaimVerdict): ReviewOutcome {
    return verdict === "verified"
        ? "supported"
        : verdict === "falsified"
          ? "rejected"
          : "unresolved";
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

type ClaimQualification = Pick<
    ClaimRecord,
    | "classification"
    | "critical"
    | "verdict"
    | "evidenceIds"
    | "contradictoryEvidenceIds"
>;

function claimQualificationError(
    input: ClaimQualification,
    evidence: readonly EvidenceRecord[],
): string | undefined {
    if (input.classification === "empirical" && evidence.length === 0)
        return "Empirical claims require at least one EV-* record.";
    if (input.classification !== "empirical" && input.verdict !== "unresolved")
        return `${input.classification} claims must remain unresolved.`;
    if (
        input.verdict !== "unresolved" &&
        !evidence.some(
            (item) =>
                item.status === "success" &&
                item.staleness !== "stale" &&
                item.sourceKind !== "reviewer" &&
                item.sourceKind !== "ineligible",
        )
    )
        return `${input.verdict} claims require successful eligible evidence.`;
    if (
        input.verdict !== "unresolved" &&
        evidence.some((item) => item.sourceKind === "derived") &&
        !evidence.some(
            (item) =>
                item.status === "success" &&
                item.staleness === "fresh" &&
                item.sourceKind === "direct",
        )
    )
        return "Derived execution evidence requires associated direct evidence.";
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
        return "Critical empirical claims require direct corroborating evidence.";
    const unlinkedContradiction = input.contradictoryEvidenceIds.find(
        (id) => !input.evidenceIds.includes(id),
    );
    return unlinkedContradiction
        ? `Contradictory evidence ${unlinkedContradiction} must also appear in evidenceIds.`
        : undefined;
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
    const restoredIds = new Set<string>();
    const restoredSequences = new Set<number>();

    for (const candidate of structuredClone(options.initialRecords ?? [])) {
        if (
            !isExplorationRecord(candidate) ||
            candidate.runId !== options.runId ||
            restoredIds.has(candidate.id) ||
            restoredSequences.has(candidate.sequence)
        )
            continue;
        const record: ExplorationRecord =
            candidate.kind === "evidence"
                ? {
                      ...candidate,
                      sourceKind: classifyEvidenceSource(
                          candidate.toolName,
                          candidate.sourceRefs,
                          candidate.reviewer?.agent === "reviewer",
                      ),
                  }
                : candidate;
        restoredIds.add(record.id);
        restoredSequences.add(record.sequence);
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

    const restorationBlockers: string[] = [];
    const addRestorationBlocker = (message: string): void => {
        if (!restorationBlockers.includes(message))
            restorationBlockers.push(message);
    };
    const restoredEvidenceById = new Map(
        evidenceRecords.map((record) => [record.id, record]),
    );
    const restoredClaimsById = new Map(
        claimRecords.map((record) => [record.id, record]),
    );
    for (const evidence of evidenceRecords) {
        if (!evidence.reviewer) continue;
        for (const claimId of evidence.reviewer.referencedClaimIds) {
            const claim = restoredClaimsById.get(claimId);
            if (!claim)
                addRestorationBlocker(
                    `Restored reviewer evidence ${evidence.id} references unknown claim ${claimId}.`,
                );
            else if (claim.sequence >= evidence.sequence)
                addRestorationBlocker(
                    `Restored reviewer evidence ${evidence.id} references non-prior claim ${claimId}.`,
                );
        }
        for (const evidenceId of evidence.reviewer.referencedEvidenceIds) {
            const referenced = restoredEvidenceById.get(evidenceId);
            if (!referenced)
                addRestorationBlocker(
                    `Restored reviewer evidence ${evidence.id} references unknown evidence ${evidenceId}.`,
                );
            else if (referenced.sequence >= evidence.sequence)
                addRestorationBlocker(
                    `Restored reviewer evidence ${evidence.id} references non-prior evidence ${evidenceId}.`,
                );
        }
    }
    for (const claim of claimRecords) {
        for (const evidenceId of claim.evidenceIds) {
            const evidence = restoredEvidenceById.get(evidenceId);
            if (!evidence)
                addRestorationBlocker(
                    `Restored claim ${claim.id} references unknown evidence ${evidenceId}.`,
                );
            else if (evidence.sequence >= claim.sequence)
                addRestorationBlocker(
                    `Restored claim ${claim.id} references non-prior evidence ${evidenceId}.`,
                );
        }
        for (const evidenceId of claim.contradictoryEvidenceIds) {
            if (!claim.evidenceIds.includes(evidenceId))
                addRestorationBlocker(
                    `Restored claim ${claim.id} has unlinked contradictory evidence ${evidenceId}.`,
                );
        }
        const restoredEvidence = claim.evidenceIds.flatMap((evidenceId) => {
            const evidence = restoredEvidenceById.get(evidenceId);
            return evidence ? [evidence] : [];
        });
        if (restoredEvidence.length === claim.evidenceIds.length) {
            const qualificationError = claimQualificationError(
                claim,
                restoredEvidence,
            );
            if (qualificationError)
                addRestorationBlocker(
                    `Restored claim ${claim.id} is invalid: ${qualificationError}`,
                );
        }
        if (claim.supersedesClaimId) {
            const superseded = restoredClaimsById.get(claim.supersedesClaimId);
            if (!superseded)
                addRestorationBlocker(
                    `Restored claim ${claim.id} supersedes unknown claim ${claim.supersedesClaimId}.`,
                );
            else if (superseded.sequence >= claim.sequence)
                addRestorationBlocker(
                    `Restored claim ${claim.id} supersedes non-prior claim ${claim.supersedesClaimId}.`,
                );
        }
    }
    for (const review of reviewRecords) {
        const reviewerEvidence = restoredEvidenceById.get(
            review.reviewerEvidenceId,
        );
        if (!reviewerEvidence)
            addRestorationBlocker(
                `Restored review ${review.id} references unknown reviewer evidence ${review.reviewerEvidenceId}.`,
            );
        else if (reviewerEvidence.sequence >= review.sequence)
            addRestorationBlocker(
                `Restored review ${review.id} references non-prior reviewer evidence ${review.reviewerEvidenceId}.`,
            );
        for (const claimId of review.claimIds) {
            const claim = restoredClaimsById.get(claimId);
            if (!claim)
                addRestorationBlocker(
                    `Restored review ${review.id} references unknown claim ${claimId}.`,
                );
            else if (claim.sequence >= review.sequence)
                addRestorationBlocker(
                    `Restored review ${review.id} references non-prior claim ${claimId}.`,
                );
        }
        for (const evidenceId of review.primaryEvidenceIds) {
            const evidence = restoredEvidenceById.get(evidenceId);
            if (!evidence)
                addRestorationBlocker(
                    `Restored review ${review.id} references unknown primary evidence ${evidenceId}.`,
                );
            else if (evidence.sequence >= review.sequence)
                addRestorationBlocker(
                    `Restored review ${review.id} references non-prior primary evidence ${evidenceId}.`,
                );
        }
    }
    for (const waiver of waiverRecords) {
        const claim = restoredClaimsById.get(waiver.claimId);
        if (!claim)
            addRestorationBlocker(
                `Restored waiver ${waiver.id} references unknown claim ${waiver.claimId}.`,
            );
        else if (claim.sequence >= waiver.sequence)
            addRestorationBlocker(
                `Restored waiver ${waiver.id} references non-prior claim ${waiver.claimId}.`,
            );
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
                reviewerChainStep(capture.input) !== undefined;
            const sourceKind = classifyEvidenceSource(
                capture.toolName,
                sourceRefs,
                isReviewer,
            );
            const structuredOutput = asRecord(result?.structuredOutput);
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
                      outcome: reviewOutcome(structuredOutput?.outcome),
                      referencedClaimIds: structuredIds(
                          structuredOutput?.claimIds,
                          "CL",
                      ),
                      referencedEvidenceIds: structuredIds(
                          structuredOutput?.evidenceIds,
                          "EV",
                      ),
                  }
                : undefined;
            const choiceProvenance =
                capture.toolName === "ask_user_question"
                    ? userChoiceProvenance(capture.input, capture.details)
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
                ...(choiceProvenance
                    ? {
                          userChoiceQuestionHash: choiceProvenance.questionHash,
                          userResponseHashes: choiceProvenance.responseHashes,
                      }
                    : {}),
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
            const qualificationError = claimQualificationError(input, evidence);
            if (qualificationError) throw new Error(qualificationError);
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
            const outcome = reviewerEvidence.reviewer?.outcome;
            if (!outcome)
                throw new Error(
                    "Reviewer evidence requires a structured outcome.",
                );
            if (
                claims.some(
                    (claim) => expectedReviewOutcome(claim.verdict) !== outcome,
                )
            )
                throw new Error(
                    `Reviewer outcome does not support the submitted claim verdicts: ${outcome}.`,
                );
            const primaryEvidence = input.primaryEvidenceIds.map((id) => {
                const evidence = evidenceRecords.find((item) => item.id === id);
                if (!evidence)
                    throw new Error(`Unknown evidence record: ${id}.`);
                if (
                    evidence.sourceKind !== "direct" ||
                    evidence.staleness !== "fresh" ||
                    (outcome !== "unresolved" && evidence.status !== "success")
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
            const uncoveredContradictions = claims
                .flatMap((claim) => claim.contradictoryEvidenceIds)
                .filter(
                    (id) =>
                        !reviewerEvidence.reviewer?.referencedEvidenceIds.includes(
                            id,
                        ),
                );
            if (uncoveredContradictions.length > 0)
                throw new Error(
                    `Reviewer output must cover every contradictory evidence record: ${uncoveredContradictions.join(", ")}.`,
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
                outcome,
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
            for (const [field, value] of Object.entries({
                reason: input.reason,
                impact: input.impact,
                mitigation: input.mitigation,
                reevaluateWhen: input.reevaluateWhen,
            })) {
                if (!value.trim())
                    throw new Error(`Waiver ${field} must be non-empty.`);
            }
            waiverCount += 1;
            const waiver: WaiverRecord = {
                id: `WV-${String(waiverCount).padStart(3, "0")}`,
                kind: "waiver",
                runId: options.runId,
                phase: "exploring",
                sequence: ++sequence,
                timestamp: now(),
                claimId: input.claimId,
                reason: input.reason.trim(),
                impact: input.impact.trim(),
                mitigation: input.mitigation.trim(),
                reevaluateWhen: input.reevaluateWhen.trim(),
            };
            waiverRecords.push(waiver);
            return structuredClone(waiver);
        },
        getGateBlockers(submission: GateSubmission): string[] {
            const blockers: string[] = [...restorationBlockers];
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
            const userChoiceEvidence = evidenceRecords.find(
                (item) => item.id === submission.userChoiceEvidenceId,
            );
            if (
                !userChoiceEvidence ||
                userChoiceEvidence.toolName !== "ask_user_question" ||
                userChoiceEvidence.status !== "success"
            )
                blockers.push(
                    "User choice must come from ask_user_question evidence.",
                );
            else if (
                !userChoiceEvidence.userChoiceQuestionHash ||
                !userChoiceEvidence.userResponseHashes?.length
            )
                blockers.push(
                    "User choice evidence must contain exactly one question and answer.",
                );
            else {
                const choiceHash = normalizedResponseHash(
                    submission.userChoice,
                );
                if (
                    !choiceHash ||
                    !userChoiceEvidence.userResponseHashes.includes(choiceHash)
                )
                    blockers.push(
                        "User choice does not match the recorded answer.",
                    );
            }

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
                const review = reviewRecords.find((item) => {
                    const reviewerEvidence = evidenceRecords.find(
                        (evidence) => evidence.id === item.reviewerEvidenceId,
                    );
                    const primaryEvidence = item.primaryEvidenceIds.flatMap(
                        (id) => {
                            const evidence = evidenceRecords.find(
                                (candidate) => candidate.id === id,
                            );
                            return evidence ? [evidence] : [];
                        },
                    );
                    return (
                        item.claimIds.includes(claim.id) &&
                        item.sequence > claim.sequence &&
                        (!waiver || item.sequence > waiver.sequence) &&
                        item.outcome === expectedReviewOutcome(claim.verdict) &&
                        reviewerEvidence?.status === "success" &&
                        reviewerEvidence.sourceKind === "reviewer" &&
                        reviewerEvidence.sequence < item.sequence &&
                        reviewerEvidence.reviewer?.agent === "reviewer" &&
                        reviewerEvidence.reviewer.context === "fresh" &&
                        reviewerEvidence.reviewer.exitCode === 0 &&
                        reviewerEvidence.reviewer.outcome === item.outcome &&
                        reviewerEvidence.reviewer.referencedClaimIds.includes(
                            claim.id,
                        ) &&
                        claim.contradictoryEvidenceIds.every((id) =>
                            reviewerEvidence.reviewer?.referencedEvidenceIds.includes(
                                id,
                            ),
                        ) &&
                        primaryEvidence.length ===
                            item.primaryEvidenceIds.length &&
                        primaryEvidence.every(
                            (evidence) =>
                                evidence.sourceKind === "direct" &&
                                evidence.staleness === "fresh" &&
                                (item.outcome === "unresolved" ||
                                    evidence.status === "success") &&
                                reviewerEvidence.reviewer?.referencedEvidenceIds.includes(
                                    evidence.id,
                                ),
                        ) &&
                        (claim.classification !== "empirical" ||
                            primaryEvidence.some((evidence) =>
                                claim.evidenceIds.includes(evidence.id),
                            ))
                    );
                });
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
                    `${review.id} — outcome: ${review.outcome}; reviewer ${review.reviewerEvidenceId}; claims: ${review.claimIds.join(", ")}; primary evidence: ${review.primaryEvidenceIds.join(", ")} — ${review.summary}`,
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
                "",
                `Choice evidence: ${input.userChoiceEvidenceId ?? "none"}`,
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
