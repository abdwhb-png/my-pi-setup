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
export type VerificationDomain =
    | "pi"
    | "local-code"
    | "external"
    | "performance";
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

const DERIVED_EVIDENCE_TOOLS = new Set([
    "ctx_execute",
    "ctx_batch_execute",
    // Historical persisted evidence remains readable after the unified-tool
    // cutover.
    "think_batch_execute",
]);

const SECONDARY_EVIDENCE_TOOLS = new Set([
    "brainstorm_delegate_research",
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
    // Task 7 — Think-in-Code parity: the native FTS5-backed `think_search`
    // and `think_note` tools also return indexed evidence (the analyzer
    // never exposes raw archive bytes to the LLM context).
    if (
        toolName === "think_search" ||
        toolName === "think_note" ||
        toolName === "think_index"
    )
        return "indexed";
    if (reviewer) return "reviewer";
    if (toolName === "subagent" || SECONDARY_EVIDENCE_TOOLS.has(toolName))
        return "secondary";
    if (DERIVED_EVIDENCE_TOOLS.has(toolName)) return "derived";
    // `think_execute` always returns analyzer output. A file path proves only
    // which source was requested, not that the derived claim directly
    // reflects bytes that were successfully inspected.
    if (toolName === "think_execute") return "derived";
    // Both the legacy MCP `ctx_execute_file` and the native
    // `think_execute_file` are classified as direct only when the captured
    // record carries at least one source reference (e.g. the file path that
    // was realpathed under `ctx.cwd`). Without a reference, the analyzer
    // output is treated as derived.
    if (toolName === "ctx_execute_file" || toolName === "think_execute_file")
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
    userChoiceCancelled?: true;
    reviewer?: Readonly<{
        agent: string;
        context?: "fresh" | "fork";
        exitCode?: number;
        outcome?: ReviewOutcome;
        referencedClaimIds: readonly string[];
        referencedEvidenceIds: readonly string[];
    }>;
    verifier?: Readonly<{
        role: "verifier" | "architect";
        agent: string;
        context: "fresh";
        exitCode: 0;
        verificationRunId: string;
        outputName: string;
        outcome?: ReviewOutcome;
        architecturalStatus?: "clear" | "watch" | "block";
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
    verificationDomain?: VerificationDomain;
    architectureImpact?: boolean;
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
    verificationDomain: VerificationDomain;
    architectureImpact: boolean;
    supersedesClaimId?: string;
};

export type LegacyReviewRecord = Readonly<{
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

export type VerificationAudit = Readonly<{
    status: "success" | "failed" | "malformed" | "timeout";
    verificationRunId: string;
    agent: string;
    outputName: string;
    reason?: string;
    architect?: Readonly<{
        evidenceId: string;
        status: "clear" | "watch" | "block";
        claimIds: readonly string[];
        evidenceIds: readonly string[];
        risks: readonly string[];
        summary: string;
    }>;
    advisoryFailure?: Readonly<{
        claimIds: readonly string[];
        evidenceIds: readonly string[];
        reason: string;
    }>;
}>;

export type VerifierReviewRecord = Readonly<{
    id: string;
    kind: "review";
    runId: string;
    phase: "exploring";
    sequence: number;
    timestamp: string;
    verifierEvidenceId?: string;
    outcome?: ReviewOutcome;
    claimIds: readonly string[];
    primaryEvidenceIds: readonly string[];
    summary: string;
    audit: VerificationAudit;
}>;

export type ReviewRecord = LegacyReviewRecord | VerifierReviewRecord;

export type RecordReviewInput = {
    reviewerEvidenceId: string;
    claimIds: string[];
    primaryEvidenceIds: string[];
    summary: string;
};

export type RecordVerificationCompletionInput = {
    verificationRunId: string;
    verifiers: Array<{
        agent: string;
        outputName: string;
        outcome: ReviewOutcome;
        claimIds: string[];
        evidenceIds: string[];
        summary: string;
    }>;
    architect?: {
        agent: "architect";
        outputName: string;
        status: "clear" | "watch" | "block";
        claimIds: string[];
        evidenceIds: string[];
        risks: string[];
        summary: string;
    };
    advisoryFailure?: {
        claimIds: string[];
        evidenceIds: string[];
        reason: string;
    };
};

export type RecordVerificationFailureInput = {
    verificationRunId: string;
    failureKind: "failed" | "malformed" | "timeout";
    reason: string;
    groups: Array<{
        agent: string;
        outputName: string;
        claimIds: string[];
        evidenceIds: string[];
    }>;
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

const VERIFIER_AGENTS = new Set([
    "pi-expert",
    "brainstorm-scout",
    "factual-researcher",
    "performance-reviewer",
]);

function isVerifierMetadata(value: unknown): boolean {
    const verifier = asRecord(value);
    if (
        !verifier ||
        (verifier.role !== "verifier" && verifier.role !== "architect") ||
        typeof verifier.agent !== "string" ||
        verifier.context !== "fresh" ||
        verifier.exitCode !== 0 ||
        typeof verifier.verificationRunId !== "string" ||
        !verifier.verificationRunId.trim() ||
        typeof verifier.outputName !== "string" ||
        !verifier.outputName.trim() ||
        !isStringArray(verifier.referencedClaimIds, /^CL-\d+$/) ||
        verifier.referencedClaimIds.length === 0 ||
        !isStringArray(verifier.referencedEvidenceIds, /^EV-\d+$/)
    )
        return false;
    return verifier.role === "architect"
        ? verifier.agent === "architect" &&
              ["clear", "watch", "block"].includes(
                  String(verifier.architecturalStatus),
              ) &&
              verifier.outcome === undefined
        : VERIFIER_AGENTS.has(verifier.agent) &&
              reviewOutcome(verifier.outcome) !== undefined &&
              verifier.architecturalStatus === undefined;
}

function isVerificationAudit(value: unknown): boolean {
    const audit = asRecord(value);
    if (
        !audit ||
        !["success", "failed", "malformed", "timeout"].includes(
            String(audit.status),
        ) ||
        typeof audit.verificationRunId !== "string" ||
        !audit.verificationRunId.trim() ||
        typeof audit.agent !== "string" ||
        !VERIFIER_AGENTS.has(audit.agent) ||
        typeof audit.outputName !== "string" ||
        !audit.outputName.trim() ||
        (audit.reason !== undefined &&
            (typeof audit.reason !== "string" || !audit.reason.trim()))
    )
        return false;
    const architect = asRecord(audit.architect);
    const advisoryFailure = asRecord(audit.advisoryFailure);
    if (audit.architect !== undefined) {
        if (
            !architect ||
            typeof architect.evidenceId !== "string" ||
            !/^EV-\d+$/.test(architect.evidenceId) ||
            !["clear", "watch", "block"].includes(String(architect.status)) ||
            !isStringArray(architect.claimIds, /^CL-\d+$/) ||
            architect.claimIds.length === 0 ||
            new Set(architect.claimIds).size !== architect.claimIds.length ||
            architect.claimIds.length > 64 ||
            !isStringArray(architect.evidenceIds, /^EV-\d+$/) ||
            new Set(architect.evidenceIds).size !==
                architect.evidenceIds.length ||
            architect.evidenceIds.length > 128 ||
            !isStringArray(architect.risks) ||
            architect.risks.length > 32 ||
            !architect.risks.every((risk) => risk.length <= 1_000) ||
            typeof architect.summary !== "string" ||
            !architect.summary.trim() ||
            architect.summary.length > 2_000
        )
            return false;
    }
    if (audit.advisoryFailure !== undefined) {
        if (
            !advisoryFailure ||
            !isStringArray(advisoryFailure.claimIds, /^CL-\d+$/) ||
            advisoryFailure.claimIds.length === 0 ||
            new Set(advisoryFailure.claimIds).size !==
                advisoryFailure.claimIds.length ||
            advisoryFailure.claimIds.length > 64 ||
            !isStringArray(advisoryFailure.evidenceIds, /^EV-\d+$/) ||
            new Set(advisoryFailure.evidenceIds).size !==
                advisoryFailure.evidenceIds.length ||
            advisoryFailure.evidenceIds.length > 128 ||
            typeof advisoryFailure.reason !== "string" ||
            !advisoryFailure.reason.trim() ||
            advisoryFailure.reason.length > 2_000
        )
            return false;
    }
    return audit.status === "success"
        ? audit.reason === undefined && !(architect && advisoryFailure)
        : typeof audit.reason === "string" &&
              architect === undefined &&
              advisoryFailure === undefined;
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
                (record.userChoiceCancelled === undefined ||
                    (record.userChoiceCancelled === true &&
                        record.userChoiceQuestionHash === undefined &&
                        record.userResponseHashes === undefined)) &&
                (record.reviewer === undefined ||
                    isReviewerMetadata(record.reviewer)) &&
                (record.verifier === undefined ||
                    isVerifierMetadata(record.verifier)) &&
                !(
                    record.reviewer !== undefined &&
                    record.verifier !== undefined
                )
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
                        /^CL-\d+$/.test(record.supersedesClaimId))) &&
                (record.verificationDomain === undefined ||
                    claimVerificationDomain(record.verificationDomain) !==
                        undefined) &&
                (record.architectureImpact === undefined ||
                    typeof record.architectureImpact === "boolean")
            );
        case "review":
            if (
                !hasRecordBase(record, "review", "RV") ||
                !isStringArray(record.claimIds, /^CL-\d+$/) ||
                record.claimIds.length === 0 ||
                !isStringArray(record.primaryEvidenceIds, /^EV-\d+$/) ||
                typeof record.summary !== "string" ||
                !record.summary.trim()
            )
                return false;
            if (record.audit === undefined)
                return (
                    typeof record.reviewerEvidenceId === "string" &&
                    /^EV-\d+$/.test(record.reviewerEvidenceId) &&
                    reviewOutcome(record.outcome) !== undefined &&
                    record.primaryEvidenceIds.length > 0
                );
            if (
                record.reviewerEvidenceId !== undefined ||
                !isVerificationAudit(record.audit)
            )
                return false;
            return asRecord(record.audit)?.status === "success"
                ? typeof record.verifierEvidenceId === "string" &&
                      /^EV-\d+$/.test(record.verifierEvidenceId) &&
                      reviewOutcome(record.outcome) !== undefined
                : record.verifierEvidenceId === undefined &&
                      record.outcome === undefined;
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

export type ExplorationStatusSnapshot = Readonly<{
    evidenceTotal: number;
    claims: Readonly<{ historical: number; active: number }>;
    reviews: Readonly<{
        total: number;
        success: number;
        failed: number;
        malformed: number;
        timeout: number;
    }>;
    unresolvedCriticalClaimIds: readonly string[];
    routingMetadataRequiredClaimIds: readonly string[];
    requiredReviewClaimIds: readonly string[];
    satisfiedReviewClaimIds: readonly string[];
    missingSuccessfulReviewClaimIds: readonly string[];
    architectureBlockedClaimIds: readonly string[];
    waiverRequiredClaimIds: readonly string[];
    finalChoice:
        | "blockedByReviews"
        | "blockedByWaivers"
        | "required"
        | "recorded"
        | "stale"
        | "cancelled";
}>;

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
    const labelKeys = new Set(["source", "sources", "sourceRefs"]);
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

function claimVerificationDomain(
    value: unknown,
): VerificationDomain | undefined {
    switch (value) {
        case "pi":
        case "local-code":
        case "external":
        case "performance":
            return value;
        default:
            return undefined;
    }
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

function isLegacyReview(review: ReviewRecord): review is LegacyReviewRecord {
    return "reviewerEvidenceId" in review;
}

function isVerifierReview(
    review: ReviewRecord,
): review is VerifierReviewRecord {
    return "audit" in review;
}

function sameIds(
    actual: readonly string[],
    expected: readonly string[],
): boolean {
    return (
        actual.length === expected.length &&
        new Set(actual).size === actual.length &&
        actual.every((id) => expected.includes(id))
    );
}

function boundedText(value: string, field: string, maxLength = 2_000): string {
    const normalized = value.trim().slice(0, maxLength);
    if (!normalized) throw new Error(`${field} must be non-empty.`);
    return normalized;
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
                      sourceKind: candidate.verifier
                          ? "secondary"
                          : classifyEvidenceSource(
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
    const successfulVerifierReviewsByRunId = new Map<
        string,
        VerifierReviewRecord[]
    >();
    for (const review of reviewRecords) {
        if (!isVerifierReview(review) || review.audit.status !== "success")
            continue;
        const runReviews =
            successfulVerifierReviewsByRunId.get(
                review.audit.verificationRunId,
            ) ?? [];
        runReviews.push(review);
        successfulVerifierReviewsByRunId.set(
            review.audit.verificationRunId,
            runReviews,
        );
    }
    for (const evidence of evidenceRecords) {
        const auditMetadata = evidence.reviewer ?? evidence.verifier;
        if (!auditMetadata) continue;
        const terminology = evidence.reviewer ? "reviewer" : "verifier";
        for (const claimId of auditMetadata.referencedClaimIds) {
            const claim = restoredClaimsById.get(claimId);
            if (!claim)
                addRestorationBlocker(
                    `Restored ${terminology} evidence ${evidence.id} references unknown claim ${claimId}.`,
                );
            else if (claim.sequence >= evidence.sequence)
                addRestorationBlocker(
                    `Restored ${terminology} evidence ${evidence.id} references non-prior claim ${claimId}.`,
                );
        }
        for (const evidenceId of auditMetadata.referencedEvidenceIds) {
            const referenced = restoredEvidenceById.get(evidenceId);
            if (!referenced)
                addRestorationBlocker(
                    `Restored ${terminology} evidence ${evidence.id} references unknown evidence ${evidenceId}.`,
                );
            else if (referenced.sequence >= evidence.sequence)
                addRestorationBlocker(
                    `Restored ${terminology} evidence ${evidence.id} references non-prior evidence ${evidenceId}.`,
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
        const auditEvidenceId = isLegacyReview(review)
            ? review.reviewerEvidenceId
            : review.verifierEvidenceId;
        if (auditEvidenceId) {
            const auditEvidence = restoredEvidenceById.get(auditEvidenceId);
            const terminology = isLegacyReview(review)
                ? "reviewer"
                : "verifier";
            if (!auditEvidence)
                addRestorationBlocker(
                    `Restored review ${review.id} references unknown ${terminology} evidence ${auditEvidenceId}.`,
                );
            else if (auditEvidence.sequence >= review.sequence)
                addRestorationBlocker(
                    `Restored review ${review.id} references non-prior ${terminology} evidence ${auditEvidenceId}.`,
                );
        }
        if (isVerifierReview(review) && review.audit.architect) {
            const architectAudit = review.audit.architect;
            const architectEvidence = restoredEvidenceById.get(
                architectAudit.evidenceId,
            );
            if (!architectEvidence)
                addRestorationBlocker(
                    `Restored review ${review.id} references unknown architect evidence ${architectAudit.evidenceId}.`,
                );
            else if (architectEvidence.sequence >= review.sequence)
                addRestorationBlocker(
                    `Restored review ${review.id} references non-prior architect evidence ${architectAudit.evidenceId}.`,
                );
            else {
                const runReviews =
                    successfulVerifierReviewsByRunId.get(
                        review.audit.verificationRunId,
                    ) ?? [];
                const runClaimIds = new Set(
                    runReviews.flatMap((candidate) => candidate.claimIds),
                );
                const runEvidenceIds = new Set(
                    runReviews.flatMap(
                        (candidate) => candidate.primaryEvidenceIds,
                    ),
                );
                const runArchitectAudits = runReviews.flatMap((candidate) =>
                    candidate.audit.architect
                        ? [candidate.audit.architect]
                        : [],
                );
                if (
                    architectEvidence.verifier?.role !== "architect" ||
                    architectEvidence.verifier.verificationRunId !==
                        review.audit.verificationRunId ||
                    architectEvidence.verifier.architecturalStatus !==
                        architectAudit.status ||
                    !sameIds(
                        architectEvidence.verifier.referencedClaimIds,
                        architectAudit.claimIds,
                    ) ||
                    !sameIds(
                        architectEvidence.verifier.referencedEvidenceIds,
                        architectAudit.evidenceIds,
                    ) ||
                    !architectAudit.claimIds.every((claimId) =>
                        runClaimIds.has(claimId),
                    ) ||
                    !architectAudit.evidenceIds.every((evidenceId) =>
                        runEvidenceIds.has(evidenceId),
                    ) ||
                    !runArchitectAudits.every(
                        (candidate) =>
                            candidate.evidenceId ===
                                architectAudit.evidenceId &&
                            candidate.status === architectAudit.status &&
                            sameIds(
                                candidate.claimIds,
                                architectAudit.claimIds,
                            ) &&
                            sameIds(
                                candidate.evidenceIds,
                                architectAudit.evidenceIds,
                            ),
                    )
                )
                    addRestorationBlocker(
                        `Restored review ${review.id} has inconsistent architect audit scope.`,
                    );
            }
        }
        if (
            isVerifierReview(review) &&
            review.audit.advisoryFailure &&
            (!review.audit.advisoryFailure.claimIds.every((claimId) =>
                review.claimIds.includes(claimId),
            ) ||
                !review.audit.advisoryFailure.evidenceIds.every((evidenceId) =>
                    review.primaryEvidenceIds.includes(evidenceId),
                ))
        )
            addRestorationBlocker(
                `Restored review ${review.id} has inconsistent architect advisory failure scope.`,
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
            const blockedReason = details?.blockedReason;
            const executionBlocked =
                capture.toolName === "think_execute" &&
                typeof blockedReason === "string" &&
                blockedReason.trim().length > 0;
            const executionBatchFailed =
                capture.toolName === "think_execute" &&
                Array.isArray(details?.items) &&
                details.items.some(
                    (item) => asRecord(item)?.status !== "succeeded",
                );
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
                status:
                    capture.isError || executionBlocked || executionBatchFailed
                        ? "error"
                        : "success",
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
                    : capture.toolName === "ask_user_question" &&
                        details?.cancelled === true
                      ? { userChoiceCancelled: true as const }
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
                verificationDomain: input.verificationDomain,
                architectureImpact: input.architectureImpact,
                ...(input.supersedesClaimId
                    ? { supersedesClaimId: input.supersedesClaimId }
                    : {}),
            };
            claimRecords.push(claim);
            return structuredClone(claim);
        },
        recordVerificationCompletion(input: RecordVerificationCompletionInput) {
            const verificationRunId = boundedText(
                input.verificationRunId,
                "Verification run id",
                256,
            );
            if (input.verifiers.length === 0)
                throw new Error(
                    "Verification completion requires at least one verifier group.",
                );
            const activeClaims = deriveActiveClaims(claimRecords);
            const outputNames = new Set<string>();
            const coveredClaims = new Set<string>();
            const validatedVerifiers = input.verifiers.map((verifier) => {
                if (!VERIFIER_AGENTS.has(verifier.agent))
                    throw new Error(
                        `Unsupported verifier agent: ${verifier.agent}.`,
                    );
                const outputName = boundedText(
                    verifier.outputName,
                    "Verifier output name",
                    128,
                );
                if (outputNames.has(outputName))
                    throw new Error(
                        `Duplicate verification output name: ${outputName}.`,
                    );
                outputNames.add(outputName);
                if (
                    verifier.claimIds.length === 0 ||
                    new Set(verifier.claimIds).size !== verifier.claimIds.length
                )
                    throw new Error(
                        "Verifier claim ids must be non-empty and unique.",
                    );
                const claims = verifier.claimIds.map((claimId) => {
                    const claim = activeClaims.find(
                        (candidate) => candidate.id === claimId,
                    );
                    if (!claim)
                        throw new Error(`Unknown active claim: ${claimId}.`);
                    if (coveredClaims.has(claimId))
                        throw new Error(
                            `Claim ${claimId} appears in multiple verifier groups.`,
                        );
                    coveredClaims.add(claimId);
                    return claim;
                });
                if (
                    claims.some(
                        (claim) =>
                            expectedReviewOutcome(claim.verdict) !==
                            verifier.outcome,
                    )
                )
                    throw new Error(
                        `Verifier outcome does not support the submitted claim verdicts: ${verifier.outcome}.`,
                    );
                const expectedEvidenceIds = [
                    ...new Set(claims.flatMap((claim) => claim.evidenceIds)),
                ];
                if (!sameIds(verifier.evidenceIds, expectedEvidenceIds))
                    throw new Error(
                        `Verifier evidence scope does not match claims ${verifier.claimIds.join(", ")}.`,
                    );
                const primaryEvidence = verifier.evidenceIds.map(
                    (evidenceId) => {
                        const evidence = evidenceRecords.find(
                            (candidate) => candidate.id === evidenceId,
                        );
                        if (!evidence)
                            throw new Error(
                                `Unknown evidence record: ${evidenceId}.`,
                            );
                        return evidence;
                    },
                );
                if (
                    claims.some(
                        (claim) =>
                            claim.classification === "empirical" &&
                            claim.verdict !== "unresolved" &&
                            !primaryEvidence.some(
                                (evidence) =>
                                    claim.evidenceIds.includes(evidence.id) &&
                                    evidence.status === "success" &&
                                    evidence.sourceKind === "direct" &&
                                    evidence.staleness === "fresh",
                            ),
                    )
                )
                    throw new Error(
                        "Verifier output cannot replace required direct fresh evidence.",
                    );
                return {
                    ...verifier,
                    outputName,
                    summary: boundedText(verifier.summary, "Verifier summary"),
                    claims,
                    primaryEvidence,
                };
            });

            const architectureClaims = validatedVerifiers
                .flatMap((verifier) => verifier.claims)
                .filter((claim) => claim.architectureImpact);
            const expectedArchitectClaimIds = architectureClaims.map(
                (claim) => claim.id,
            );
            const expectedArchitectEvidenceIds = [
                ...new Set(
                    architectureClaims.flatMap((claim) => claim.evidenceIds),
                ),
            ];
            let validatedArchitect:
                | (RecordVerificationCompletionInput["architect"] & {
                      outputName: string;
                      summary: string;
                      risks: string[];
                  })
                | undefined;
            let validatedAdvisoryFailure:
                | (RecordVerificationCompletionInput["advisoryFailure"] & {
                      reason: string;
                  })
                | undefined;
            if (expectedArchitectClaimIds.length > 0) {
                if (Boolean(input.architect) === Boolean(input.advisoryFailure))
                    throw new Error(
                        "Architecture-impacting claims require exactly one architect output or advisory failure.",
                    );
                if (input.architect) {
                    if (
                        input.architect.agent !== "architect" ||
                        !sameIds(
                            input.architect.claimIds,
                            expectedArchitectClaimIds,
                        ) ||
                        !sameIds(
                            input.architect.evidenceIds,
                            expectedArchitectEvidenceIds,
                        )
                    )
                        throw new Error(
                            "Architect output scope does not match architecture-impacting claims.",
                        );
                    if (
                        input.architect.risks.length > 32 ||
                        !input.architect.risks.every(
                            (risk) =>
                                typeof risk === "string" &&
                                risk.trim().length > 0,
                        )
                    )
                        throw new Error(
                            "Architect risks must be bounded non-empty strings.",
                        );
                    validatedArchitect = {
                        ...input.architect,
                        outputName: boundedText(
                            input.architect.outputName,
                            "Architect output name",
                            128,
                        ),
                        summary: boundedText(
                            input.architect.summary,
                            "Architect summary",
                        ),
                        risks: input.architect.risks.map((risk) =>
                            boundedText(risk, "Architect risk", 1_000),
                        ),
                    };
                } else {
                    if (
                        !sameIds(
                            input.advisoryFailure!.claimIds,
                            expectedArchitectClaimIds,
                        ) ||
                        !sameIds(
                            input.advisoryFailure!.evidenceIds,
                            expectedArchitectEvidenceIds,
                        )
                    )
                        throw new Error(
                            "Architect advisory failure scope does not match architecture-impacting claims.",
                        );
                    validatedAdvisoryFailure = {
                        ...input.advisoryFailure!,
                        reason: boundedText(
                            input.advisoryFailure!.reason,
                            "Architect advisory failure reason",
                        ),
                    };
                }
            } else if (input.architect || input.advisoryFailure) {
                throw new Error(
                    "Architect output or advisory failure is not allowed without architecture-impacting claims.",
                );
            }

            const appendVerifierEvidence = (input: {
                role: "verifier" | "architect";
                agent: string;
                outputName: string;
                claimIds: string[];
                evidenceIds: string[];
                outcome?: ReviewOutcome;
                architecturalStatus?: "clear" | "watch" | "block";
                structuredOutput: unknown;
            }): EvidenceRecord => {
                evidenceCount += 1;
                const sourceRefs = [
                    ...new Set(
                        input.evidenceIds.flatMap(
                            (evidenceId) =>
                                evidenceRecords.find(
                                    (record) => record.id === evidenceId,
                                )?.sourceRefs ?? [],
                        ),
                    ),
                ].slice(0, 8);
                const evidence: EvidenceRecord = {
                    id: `EV-${String(evidenceCount).padStart(3, "0")}`,
                    kind: "evidence",
                    runId: options.runId,
                    phase: "exploring",
                    sequence: ++sequence,
                    toolName: "brainstorm_run_verification",
                    status: "success",
                    timestamp: now(),
                    sourceRefs,
                    inputHash: sha256({
                        verificationRunId,
                        outputName: input.outputName,
                    }),
                    outputHash: sha256(input.structuredOutput),
                    nativeRef: `subagent:async:${verificationRunId}:${input.outputName}`,
                    sourceKind: "secondary",
                    staleness: "fresh",
                    verifier: {
                        role: input.role,
                        agent: input.agent,
                        context: "fresh",
                        exitCode: 0,
                        verificationRunId,
                        outputName: input.outputName,
                        ...(input.outcome ? { outcome: input.outcome } : {}),
                        ...(input.architecturalStatus
                            ? {
                                  architecturalStatus:
                                      input.architecturalStatus,
                              }
                            : {}),
                        referencedClaimIds: [...input.claimIds],
                        referencedEvidenceIds: [...input.evidenceIds],
                    },
                };
                evidenceRecords.push(evidence);
                return evidence;
            };

            const architectEvidence = validatedArchitect
                ? appendVerifierEvidence({
                      role: "architect",
                      agent: validatedArchitect.agent,
                      outputName: validatedArchitect.outputName,
                      claimIds: validatedArchitect.claimIds,
                      evidenceIds: validatedArchitect.evidenceIds,
                      architecturalStatus: validatedArchitect.status,
                      structuredOutput: validatedArchitect,
                  })
                : undefined;
            const verifierEvidence: EvidenceRecord[] = [];
            const reviews: VerifierReviewRecord[] = [];
            for (const verifier of validatedVerifiers) {
                const evidence = appendVerifierEvidence({
                    role: "verifier",
                    agent: verifier.agent,
                    outputName: verifier.outputName,
                    claimIds: verifier.claimIds,
                    evidenceIds: verifier.evidenceIds,
                    outcome: verifier.outcome,
                    structuredOutput: verifier,
                });
                verifierEvidence.push(evidence);
                const scopedAdvisoryFailure = validatedAdvisoryFailure
                    ? {
                          claimIds: validatedAdvisoryFailure.claimIds.filter(
                              (claimId) => verifier.claimIds.includes(claimId),
                          ),
                          evidenceIds:
                              validatedAdvisoryFailure.evidenceIds.filter(
                                  (evidenceId) =>
                                      verifier.evidenceIds.includes(evidenceId),
                              ),
                          reason: validatedAdvisoryFailure.reason,
                      }
                    : undefined;
                reviewCount += 1;
                const review: VerifierReviewRecord = {
                    id: `RV-${String(reviewCount).padStart(3, "0")}`,
                    kind: "review",
                    runId: options.runId,
                    phase: "exploring",
                    sequence: ++sequence,
                    timestamp: now(),
                    verifierEvidenceId: evidence.id,
                    outcome: verifier.outcome,
                    claimIds: [...verifier.claimIds],
                    primaryEvidenceIds: [...verifier.evidenceIds],
                    summary: verifier.summary,
                    audit: {
                        status: "success",
                        verificationRunId,
                        agent: verifier.agent,
                        outputName: verifier.outputName,
                        ...(validatedArchitect && architectEvidence
                            ? {
                                  architect: {
                                      evidenceId: architectEvidence.id,
                                      status: validatedArchitect.status,
                                      claimIds: [
                                          ...validatedArchitect.claimIds,
                                      ],
                                      evidenceIds: [
                                          ...validatedArchitect.evidenceIds,
                                      ],
                                      risks: [...validatedArchitect.risks],
                                      summary: validatedArchitect.summary,
                                  },
                              }
                            : {}),
                        ...(scopedAdvisoryFailure?.claimIds.length
                            ? {
                                  advisoryFailure: scopedAdvisoryFailure,
                              }
                            : {}),
                    },
                };
                reviewRecords.push(review);
                reviews.push(review);
            }
            return structuredClone({
                architectEvidence,
                verifierEvidence,
                reviews,
            });
        },
        recordVerificationFailure(input: RecordVerificationFailureInput) {
            const verificationRunId = boundedText(
                input.verificationRunId,
                "Verification run id",
                256,
            );
            const reason = boundedText(
                input.reason,
                "Verification failure reason",
            );
            if (input.groups.length === 0)
                throw new Error(
                    "Verification failure requires at least one expected group.",
                );
            const reviews = input.groups.map((group) => {
                if (!VERIFIER_AGENTS.has(group.agent))
                    throw new Error(
                        `Unsupported verifier agent: ${group.agent}.`,
                    );
                const outputName = boundedText(
                    group.outputName,
                    "Verifier output name",
                    128,
                );
                if (
                    group.claimIds.length === 0 ||
                    new Set(group.claimIds).size !== group.claimIds.length
                )
                    throw new Error(
                        "Verifier claim ids must be non-empty and unique.",
                    );
                for (const claimId of group.claimIds) {
                    if (
                        !claimRecords.some(
                            (candidate) => candidate.id === claimId,
                        )
                    )
                        throw new Error(`Unknown claim: ${claimId}.`);
                }
                for (const evidenceId of group.evidenceIds) {
                    if (
                        !evidenceRecords.some(
                            (candidate) => candidate.id === evidenceId,
                        )
                    )
                        throw new Error(
                            `Unknown evidence record: ${evidenceId}.`,
                        );
                }
                reviewCount += 1;
                const review: VerifierReviewRecord = {
                    id: `RV-${String(reviewCount).padStart(3, "0")}`,
                    kind: "review",
                    runId: options.runId,
                    phase: "exploring",
                    sequence: ++sequence,
                    timestamp: now(),
                    claimIds: [...group.claimIds],
                    primaryEvidenceIds: [...group.evidenceIds],
                    summary: reason,
                    audit: {
                        status: input.failureKind,
                        verificationRunId,
                        agent: group.agent,
                        outputName,
                        reason,
                    },
                };
                reviewRecords.push(review);
                return review;
            });
            return structuredClone(reviews);
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
            for (const claim of activeClaims) {
                if (
                    claim.verificationDomain === undefined ||
                    claim.architectureImpact === undefined
                )
                    blockers.push(
                        `Restored claim ${claim.id} lacks routing metadata and must be superseded before verification.`,
                    );
            }
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
            let sequencedUserChoiceEvidence: EvidenceRecord | undefined;
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
                        [
                            "User choice does not match the recorded answer.",
                            `  Choice submitted: "${submission.userChoice}"`,
                            `  Stored hash: ${userChoiceEvidence.userResponseHashes[0]}`,
                            `  Expected: the exact selected option label text, or one of its comma-separated combinations.`,
                            `  Inspect evidence ${submission.userChoiceEvidenceId} (${userChoiceEvidence.nativeRef}) for the original question and answer.`,
                        ].join("\n"),
                    );
                else sequencedUserChoiceEvidence = userChoiceEvidence;
            }
            if (
                sequencedUserChoiceEvidence &&
                activeClaims.some(
                    (claim) =>
                        claim.sequence >= sequencedUserChoiceEvidence.sequence,
                )
            )
                blockers.push(
                    "User choice evidence must follow every active claim.",
                );

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
                    claim.architectureImpact === true ||
                    waiver !== undefined;
                if (!reviewRequired) continue;
                const review = reviewRecords
                    .filter((item) => {
                        if (!item.claimIds.includes(claim.id)) return false;
                        if (
                            item.sequence <= claim.sequence ||
                            (waiver && item.sequence <= waiver.sequence) ||
                            item.outcome !==
                                expectedReviewOutcome(claim.verdict)
                        )
                            return false;
                        if (
                            isVerifierReview(item) &&
                            item.audit.architect?.status === "block" &&
                            item.audit.architect.claimIds.includes(claim.id)
                        )
                            return false;
                        const evidenceId = isLegacyReview(item)
                            ? item.reviewerEvidenceId
                            : item.verifierEvidenceId;
                        const reviewerEvidence = evidenceRecords.find(
                            (evidence) => evidence.id === evidenceId,
                        );
                        const primaryEvidence = item.primaryEvidenceIds.flatMap(
                            (id) => {
                                const evidence = evidenceRecords.find(
                                    (candidate) => candidate.id === id,
                                );
                                return evidence ? [evidence] : [];
                            },
                        );
                        if (
                            reviewerEvidence?.status !== "success" ||
                            reviewerEvidence.sequence >= item.sequence ||
                            primaryEvidence.length !==
                                item.primaryEvidenceIds.length ||
                            !primaryEvidence.every(
                                (evidence) =>
                                    evidence.sourceKind === "direct" &&
                                    evidence.staleness === "fresh" &&
                                    (item.outcome === "unresolved" ||
                                        evidence.status === "success"),
                            ) ||
                            (claim.classification === "empirical" &&
                                !primaryEvidence.some((evidence) =>
                                    claim.evidenceIds.includes(evidence.id),
                                ))
                        )
                            return false;
                        if (isLegacyReview(item))
                            return (
                                reviewerEvidence.sourceKind === "reviewer" &&
                                reviewerEvidence.reviewer?.agent ===
                                    "reviewer" &&
                                reviewerEvidence.reviewer.context === "fresh" &&
                                reviewerEvidence.reviewer.exitCode === 0 &&
                                reviewerEvidence.reviewer.outcome ===
                                    item.outcome &&
                                reviewerEvidence.reviewer.referencedClaimIds.includes(
                                    claim.id,
                                ) &&
                                claim.contradictoryEvidenceIds.every((id) =>
                                    reviewerEvidence.reviewer?.referencedEvidenceIds.includes(
                                        id,
                                    ),
                                ) &&
                                primaryEvidence.every((evidence) =>
                                    reviewerEvidence.reviewer?.referencedEvidenceIds.includes(
                                        evidence.id,
                                    ),
                                )
                            );
                        return (
                            item.audit.status === "success" &&
                            reviewerEvidence.sourceKind === "secondary" &&
                            reviewerEvidence.verifier?.role === "verifier" &&
                            reviewerEvidence.verifier.context === "fresh" &&
                            reviewerEvidence.verifier.exitCode === 0 &&
                            reviewerEvidence.verifier.verificationRunId ===
                                item.audit.verificationRunId &&
                            reviewerEvidence.verifier.agent ===
                                item.audit.agent &&
                            reviewerEvidence.verifier.outputName ===
                                item.audit.outputName &&
                            reviewerEvidence.verifier.outcome ===
                                item.outcome &&
                            reviewerEvidence.verifier.referencedClaimIds.includes(
                                claim.id,
                            ) &&
                            claim.contradictoryEvidenceIds.every((id) =>
                                reviewerEvidence.verifier?.referencedEvidenceIds.includes(
                                    id,
                                ),
                            ) &&
                            primaryEvidence.every((evidence) =>
                                reviewerEvidence.verifier?.referencedEvidenceIds.includes(
                                    evidence.id,
                                ),
                            )
                        );
                    })
                    .reduce<ReviewRecord | undefined>(
                        (latest, item) =>
                            !latest || item.sequence > latest.sequence
                                ? item
                                : latest,
                        undefined,
                    );
                const architectureBlock = reviewRecords.find(
                    (item) =>
                        isVerifierReview(item) &&
                        item.claimIds.includes(claim.id) &&
                        item.sequence > claim.sequence &&
                        item.audit.status === "success" &&
                        item.audit.architect?.status === "block" &&
                        item.audit.architect.claimIds.includes(claim.id),
                );
                if (architectureBlock)
                    blockers.push(
                        `${claim.id} is blocked by architecture verification.`,
                    );
                else if (!review)
                    blockers.push(
                        `${claim.id} requires a fresh completed review.`,
                    );
                else if (
                    sequencedUserChoiceEvidence &&
                    sequencedUserChoiceEvidence.sequence <= review.sequence
                )
                    blockers.push(
                        `User choice evidence must follow required review ${review.id}.`,
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
            const reviewLines = reviewRecords.map((review) => {
                const audit = isLegacyReview(review)
                    ? `legacy reviewer ${review.reviewerEvidenceId}`
                    : `${review.audit.status} verifier ${review.verifierEvidenceId ?? "none"} (${review.audit.agent})`;
                const architect =
                    !isLegacyReview(review) && review.audit.architect
                        ? `; architect ${review.audit.architect.status} claims: ${review.audit.architect.claimIds.join(", ")}; evidence: ${review.audit.architect.evidenceIds.join(", ") || "none"}; risks: ${review.audit.architect.risks.join(" | ") || "none"}; summary: ${review.audit.architect.summary}`
                        : "";
                return `${review.id} — outcome: ${review.outcome ?? "none"}; ${audit}${architect}; claims: ${review.claimIds.join(", ")}; primary evidence: ${review.primaryEvidenceIds.join(", ")} — ${review.summary}`;
            });
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
        getStatusSnapshot(): ExplorationStatusSnapshot {
            const activeClaims = deriveActiveClaims(claimRecords);
            const activeClaimIds = activeClaims.map((claim) => claim.id);
            const routingMetadataRequiredClaimIds = activeClaims
                .filter(
                    (claim) =>
                        claim.verificationDomain === undefined ||
                        claim.architectureImpact === undefined,
                )
                .map((claim) => claim.id);
            const requiredReviewClaimIds = activeClaims
                .filter((claim) => {
                    const waiver = waiverRecords.findLast(
                        (item) => item.claimId === claim.id,
                    );
                    return (
                        (claim.critical &&
                            claim.classification === "empirical") ||
                        claim.contradictoryEvidenceIds.length > 0 ||
                        claim.architectureImpact === true ||
                        waiver !== undefined
                    );
                })
                .map((claim) => claim.id);
            const blockers = this.getGateBlockers({
                approachClaimIds:
                    activeClaimIds.length > 0 ? [activeClaimIds] : [],
                recommendationClaimIds: activeClaimIds,
                userChoice: "",
            });
            const architectureBlockedClaimIds = requiredReviewClaimIds.filter(
                (claimId) =>
                    blockers.includes(
                        `${claimId} is blocked by architecture verification.`,
                    ),
            );
            const missingSuccessfulReviewClaimIds =
                requiredReviewClaimIds.filter((claimId) =>
                    blockers.includes(
                        `${claimId} requires a fresh completed review.`,
                    ),
                );
            const waiverRequiredClaimIds = activeClaims
                .filter((claim) =>
                    blockers.includes(
                        `${claim.id} requires a user-approved waiver.`,
                    ),
                )
                .map((claim) => claim.id);
            const blockedReviewIds = new Set([
                ...architectureBlockedClaimIds,
                ...missingSuccessfulReviewClaimIds,
            ]);
            const satisfiedReviewClaimIds = requiredReviewClaimIds.filter(
                (claimId) => !blockedReviewIds.has(claimId),
            );
            const legacyReviewIsEligible = (
                review: LegacyReviewRecord,
            ): boolean => {
                const reviewerEvidence = evidenceRecords.find(
                    (evidence) => evidence.id === review.reviewerEvidenceId,
                );
                const primaryEvidence = review.primaryEvidenceIds.flatMap(
                    (id) => {
                        const evidence = evidenceRecords.find(
                            (candidate) => candidate.id === id,
                        );
                        return evidence ? [evidence] : [];
                    },
                );
                return (
                    review.claimIds.every((claimId) =>
                        claimRecords.some(
                            (claim) =>
                                claim.id === claimId &&
                                claim.sequence < review.sequence,
                        ),
                    ) &&
                    reviewerEvidence?.status === "success" &&
                    reviewerEvidence.sequence < review.sequence &&
                    reviewerEvidence.sourceKind === "reviewer" &&
                    reviewerEvidence.reviewer?.agent === "reviewer" &&
                    reviewerEvidence.reviewer.context === "fresh" &&
                    reviewerEvidence.reviewer.exitCode === 0 &&
                    reviewerEvidence.reviewer.outcome === review.outcome &&
                    review.claimIds.every((claimId) =>
                        reviewerEvidence.reviewer?.referencedClaimIds.includes(
                            claimId,
                        ),
                    ) &&
                    primaryEvidence.length ===
                        review.primaryEvidenceIds.length &&
                    primaryEvidence.every(
                        (evidence) =>
                            evidence.sequence < review.sequence &&
                            evidence.sourceKind === "direct" &&
                            evidence.staleness === "fresh" &&
                            (review.outcome === "unresolved" ||
                                evidence.status === "success") &&
                            reviewerEvidence.reviewer?.referencedEvidenceIds.includes(
                                evidence.id,
                            ),
                    )
                );
            };
            const reviewCounts = {
                total: reviewRecords.length,
                success: 0,
                failed: 0,
                malformed: 0,
                timeout: 0,
            };
            for (const review of reviewRecords) {
                if (isLegacyReview(review))
                    reviewCounts[
                        legacyReviewIsEligible(review) ? "success" : "malformed"
                    ] += 1;
                else reviewCounts[review.audit.status] += 1;
            }
            const latestQuestionEvidence = evidenceRecords.findLast(
                (evidence) => evidence.toolName === "ask_user_question",
            );
            const latestSuccessfulReviewSequence = reviewRecords
                .filter(
                    (review) =>
                        review.claimIds.some((claimId) =>
                            satisfiedReviewClaimIds.includes(claimId),
                        ) &&
                        (isLegacyReview(review)
                            ? legacyReviewIsEligible(review)
                            : review.audit.status === "success"),
                )
                .reduce(
                    (latest, review) => Math.max(latest, review.sequence),
                    0,
                );
            const latestRequiredSequence = Math.max(
                0,
                ...activeClaims.map((claim) => claim.sequence),
                latestSuccessfulReviewSequence,
            );
            const finalChoice =
                waiverRequiredClaimIds.length > 0
                    ? "blockedByWaivers"
                    : blockedReviewIds.size > 0
                      ? "blockedByReviews"
                      : !latestQuestionEvidence
                        ? "required"
                        : latestQuestionEvidence.status === "success" &&
                            latestQuestionEvidence.userChoiceCancelled === true
                          ? "cancelled"
                          : latestQuestionEvidence.status !== "success" ||
                              !latestQuestionEvidence.userResponseHashes?.length
                            ? "required"
                            : latestQuestionEvidence.sequence <=
                                latestRequiredSequence
                              ? "stale"
                              : "recorded";

            return structuredClone({
                evidenceTotal: evidenceRecords.length,
                claims: {
                    historical: claimRecords.length,
                    active: activeClaims.length,
                },
                reviews: reviewCounts,
                unresolvedCriticalClaimIds: activeClaims
                    .filter(
                        (claim) =>
                            claim.critical && claim.verdict === "unresolved",
                    )
                    .map((claim) => claim.id),
                routingMetadataRequiredClaimIds,
                requiredReviewClaimIds,
                satisfiedReviewClaimIds,
                missingSuccessfulReviewClaimIds,
                architectureBlockedClaimIds,
                waiverRequiredClaimIds,
                finalChoice,
            });
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
