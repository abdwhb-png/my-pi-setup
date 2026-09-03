/**
 * Deterministic structured-delegation plan and read-only policy.
 *
 * Pure module: route selection, claim grouping, strict result schemas,
 * node-plan assembly, and completion validators. The runtime coordinator owns
 * the 0.50 `{requestId, ownerRunId, nodeId}` attempt identities.
 *
 * Capability-ceiling policy: `denyExtensions: false` + exact `allowedTools`.
 * Keeping extensions loadable preserves web/docs provider tools
 * (context7, deepwiki, fetch, web_search) that factual-research routes depend
 * on; `allowedTools` still restricts which builtin/MCP tool NAMES the child may
 * call (pi-args.ts filters `effectiveToolAllowlist` and `effectiveMcpTools`
 * against `allowedTools`).
 *
 * The {@link VerificationDomain} values mirror the domain enum pinned by
 * exploration-ledger.ts (T1); this module re-declares them locally so it stays
 * hermetic. T3 maps ledger `ClaimRecord` → {@link VerificationClaim}.
 */

// ---------------------------------------------------------------------------
// Policy constants
// ---------------------------------------------------------------------------

/** Closed verification domain set, in canonical routing order. */
export const VERIFICATION_DOMAINS = [
    "pi",
    "local-code",
    "external",
    "performance",
] as const satisfies readonly VerificationDomain[];

/** Expected review outcomes, in canonical grouping order. */
export const VERIFICATION_OUTCOMES = [
    "supported",
    "rejected",
    "unresolved",
] as const satisfies readonly VerificationOutcome[];

/** Architectural advisory statuses; `watch` is distinct from `block`. */
export const ARCHITECTURAL_STATUSES = [
    "clear",
    "watch",
    "block",
] as const satisfies readonly ArchitecturalStatus[];

/**
 * Closed routing map: every domain maps to exactly one factual verifier.
 * `code-reviewer` and the generic `reviewer` never appear here — `pi` goes
 * to the dedicated `pi-expert`, keeping factual verification separate from the
 * advisory reviewer used elsewhere in the brainstorming workflow.
 */
export const VERIFICATION_ROUTING = Object.freeze({
    pi: "pi-expert",
    "local-code": "brainstorm-scout",
    external: "factual-researcher",
    performance: "performance-reviewer",
}) as Readonly<Record<VerificationDomain, string>>;

/**
 * Exact verifier agent allowlist. T3 uses this to reject any agent discovered
 * at runtime that is not a factual verifier (e.g. code-reviewer, reviewer,
 * worker, oracle).
 */
export const VERIFIER_AGENT_ALLOWLIST = Object.freeze([
    "pi-expert",
    "brainstorm-scout",
    "factual-researcher",
    "performance-reviewer",
]);

/** Dedicated read-only advisory agent for the architecture step. */
export const ARCHITECT_AGENT = "architect" as const;

/**
 * Exact read-only tool allowlist for spawned verifiers. Covers investigation
 * (direct evidence), research (secondary evidence), and bounded computational
 * derivation (derived evidence) — every mutation-capable tool is excluded so
 * the capability ceiling enforced in T3 keeps verifiers non-writing.
 *
 * `subagent` is intentionally absent: verifiers gather evidence directly and
 * must not fan out; only the orchestrator (T3) spawns. The list is kept
 * extension-provider-compatible (web/docs tools included) so factual-research
 * routes stay functional under the ceiling.
 */
export const READONLY_VERIFIER_TOOLS = Object.freeze([
    "ast_grep_dump",
    "ast_grep_outline",
    "ast_grep_search",
    "context7_query-docs",
    "context7_resolve-library-id",
    "ctx_search",
    "deepwiki_ask_question",
    "deepwiki_read_wiki_contents",
    "deepwiki_read_wiki_structure",
    "fetch_content",
    "find",
    "get_search_content",
    "grep",
    "lens_diagnostics",
    "ls",
    "lsp_diagnostics",
    "memory_search",
    "module_report",
    "pi_session_find",
    "pi_session_query",
    "pi_session_search",
    "read",
    "read_enclosing",
    "read_symbol",
    "session_search",
    "source_check",
    "symbol_search",
    // Task 7 — Think-in-Code parity: verifiers may query the FTS5 index
    // through `think_search` (no filesystem, no execution, no analyzer
    // broker). The three execute tools and the bounded indexer are
    // intentionally absent so verifiers remain non-writing.
    "think_search",
    "web_search",
]);

// ---------------------------------------------------------------------------
// Strict JSON schemas (Record<string, unknown> matches JsonSchemaObject)
// ---------------------------------------------------------------------------

export const VERIFIER_OUTPUT_SCHEMA = {
    type: "object",
    properties: {
        outcome: { type: "string", enum: [...VERIFICATION_OUTCOMES] },
        claimIds: {
            type: "array",
            items: { type: "string" },
            uniqueItems: true,
        },
        evidenceIds: {
            type: "array",
            items: { type: "string" },
            uniqueItems: true,
        },
        summary: { type: "string" },
    },
    required: ["outcome", "claimIds", "evidenceIds", "summary"],
    additionalProperties: false,
} as const satisfies Readonly<Record<string, unknown>>;

export const ARCHITECT_OUTPUT_SCHEMA = {
    type: "object",
    properties: {
        status: { type: "string", enum: [...ARCHITECTURAL_STATUSES] },
        claimIds: {
            type: "array",
            items: { type: "string" },
            uniqueItems: true,
        },
        evidenceIds: {
            type: "array",
            items: { type: "string" },
            uniqueItems: true,
        },
        risks: { type: "array", items: { type: "string" } },
        summary: { type: "string" },
    },
    required: ["status", "claimIds", "evidenceIds", "risks", "summary"],
    additionalProperties: false,
} as const satisfies Readonly<Record<string, unknown>>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VerificationDomain =
    | "pi"
    | "local-code"
    | "external"
    | "performance";
export type VerificationOutcome = "supported" | "rejected" | "unresolved";
export type ArchitecturalStatus = "clear" | "watch" | "block";

/**
 * Sanitized evidence descriptor carried alongside each claim so verifiers can
 * corroborate directly without re-deriving source locations. T3 populates
 * `sourceRefs` from the ledger's sanitized `EvidenceRecord.sourceRefs`.
 */
export interface EvidenceDescriptor {
    readonly id: string;
    readonly sourceRefs: readonly string[];
}

/**
 * Local claim-like type. Decoupled from the exploration ledger so this module
 * stays pure; T3 maps `ClaimRecord` → {@link VerificationClaim} (deriving
 * `expectedOutcome` from the claim verdict: verified→supported,
 * falsified→rejected, unresolved→unresolved) and lifts each cited evidence
 * record into an {@link EvidenceDescriptor}.
 */
export interface VerificationClaim {
    readonly id: string;
    readonly assertion: string;
    readonly domain: VerificationDomain;
    readonly expectedOutcome: VerificationOutcome;
    readonly evidence: readonly EvidenceDescriptor[];
}

export interface VerificationBuildInput {
    readonly runId: string;
    readonly claims: readonly VerificationClaim[];
    /** When true, an advisory architect step follows the verifier groups. */
    readonly architectureImpact?: boolean;
    /** Exact architecture-impacting subset T3 persists and validates. */
    readonly architectureScope?: ArchitectExpectedScope;
}

export interface VerificationGroup {
    readonly domain: VerificationDomain;
    readonly outcome: VerificationOutcome;
    readonly agent: string;
    readonly claimIds: readonly string[];
    readonly assertions: readonly string[];
    /** Aggregated evidence descriptors (deduped by id, merged source refs). */
    readonly evidence: readonly EvidenceDescriptor[];
    /** Derived sorted unique evidence ids, for exact completion correlation. */
    readonly evidenceIds: readonly string[];
}

export interface VerificationPlanNode {
    readonly role: "verifier" | "architect";
    readonly agent: string;
    readonly task: string;
    readonly outputName: string;
    readonly schema: Readonly<Record<string, unknown>>;
}

export interface VerificationPlan {
    readonly nodes: readonly VerificationPlanNode[];
}

/** Expected claim/evidence scope an architect completion must match exactly. */
export interface ArchitectExpectedScope {
    readonly claimIds: readonly string[];
    readonly evidenceIds: readonly string[];
}

export type CompletionResult = Readonly<
    | { ok: true; outcome: VerificationOutcome }
    | { ok: false; blockers: readonly string[] }
>;

export type ArchitectCompletionResult = Readonly<
    | { ok: true; status: ArchitecturalStatus }
    | { ok: false; blockers: readonly string[] }
>;

/**
 * Structurally compatible with pi-subagents `SubagentCapabilityCeiling`.
 * Tool-group aliases are resolved inside each child, so this ceiling limits
 * only agent identities while extensionBindings carry the concrete tool policy.
 */
export interface CapabilityCeiling {
    readonly allowedAgents: readonly string[];
    readonly denyExtensions: false;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const DOMAIN_RANK: Readonly<Record<VerificationDomain, number>> = {
    pi: 0,
    "local-code": 1,
    external: 2,
    performance: 3,
};

const OUTCOME_RANK: Readonly<Record<VerificationOutcome, number>> = {
    supported: 0,
    rejected: 1,
    unresolved: 2,
};

function groupKey(
    domain: VerificationDomain,
    outcome: VerificationOutcome,
): string {
    return `${DOMAIN_RANK[domain]}:${OUTCOME_RANK[outcome]}`;
}

function uniqueSorted(values: readonly string[]): string[] {
    return [...new Set(values)].toSorted((a, b) => a.localeCompare(b));
}

function isStringArray(value: unknown): value is string[] {
    return (
        Array.isArray(value) && value.every((item) => typeof item === "string")
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function exactFieldError(
    value: Record<string, unknown>,
    expected: readonly string[],
    label: string,
): string | undefined {
    const actual = Object.keys(value).toSorted();
    const wanted = [...expected].toSorted();
    return actual.length === wanted.length &&
        actual.every((field, index) => field === wanted[index])
        ? undefined
        : `${label} fields must be exactly: ${wanted.join(", ")}.`;
}

function matchingOutcome(value: unknown): VerificationOutcome | undefined {
    if (value === "supported") return "supported";
    if (value === "rejected") return "rejected";
    if (value === "unresolved") return "unresolved";
    return undefined;
}

function matchingStatus(value: unknown): ArchitecturalStatus | undefined {
    if (value === "clear") return "clear";
    if (value === "watch") return "watch";
    if (value === "block") return "block";
    return undefined;
}

function verifierStepName(
    domain: VerificationDomain,
    outcome: VerificationOutcome,
): string {
    // Keep node ids identifier-safe and stable for correlation and readable
    // architect placeholders.
    return `verify_${domain.replaceAll("-", "_")}_${outcome}`;
}

/** Merge evidence descriptors: dedupe by id, union + sort source refs. */
function mergeEvidence(
    descriptors: readonly EvidenceDescriptor[],
): EvidenceDescriptor[] {
    const byId = new Map<string, Set<string>>();
    for (const descriptor of descriptors) {
        let refs = byId.get(descriptor.id);
        if (!refs) {
            refs = new Set<string>();
            byId.set(descriptor.id, refs);
        }
        for (const ref of descriptor.sourceRefs) refs.add(ref);
    }
    return [...byId.entries()]
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([id, refs]) => ({ id, sourceRefs: [...refs].toSorted() }));
}

function renderVerifierTask(group: VerificationGroup): string {
    const claimLines = group.claimIds.map((id, index) => {
        const assertion = group.assertions[index] ?? "(no assertion recorded)";
        return `- ${id}: ${assertion}`;
    });
    const evidenceLines =
        group.evidence.length > 0
            ? group.evidence.map(
                  (descriptor) =>
                      `- ${descriptor.id}: ${descriptor.sourceRefs.length > 0 ? descriptor.sourceRefs.join(", ") : "(no source reference)"}`,
              )
            : ["- (none — gather primary evidence first)"];
    return [
        "Read-only verification. Do not modify any files.",
        `Verify the following claims in the "${group.domain}" domain.`,
        `Expected aggregate outcome: ${group.outcome}.`,
        "Return strict structured output only (outcome, claimIds, evidenceIds, summary).",
        "ClaimIds and evidenceIds must match the sets below exactly.",
        "",
        "Claims:",
        ...claimLines,
        "",
        "Cited evidence (EV id → source references for direct corroboration):",
        ...evidenceLines,
    ].join("\n");
}

function architectTask(
    verifierOutputNames: readonly string[],
    scope: ArchitectExpectedScope,
    evidence: readonly EvidenceDescriptor[],
): string {
    const refs = verifierOutputNames
        .map((name) => `{outputs.${name}}`)
        .join(" and ");
    return [
        "Advisory architecture review only. Do not modify any files.",
        "Read the verifier completions and judge architectural impact.",
        refs
            ? `Verifier outputs: ${refs}.`
            : "No verifier outputs available; assess from the run context.",
        `Exact architecture claimIds: ${scope.claimIds.join(", ") || "none"}.`,
        `Exact architecture evidenceIds: ${scope.evidenceIds.join(", ") || "none"}.`,
        "Exact architecture evidence sources (use these references; do not guess paths):",
        ...(evidence.length > 0
            ? evidence.map(
                  (descriptor) =>
                      `${descriptor.id}: ${descriptor.sourceRefs.join(", ") || "(no source reference)"}`,
              )
            : ["(none)"]),
        "Return those exact claimIds and evidenceIds; do not include ordinary claims.",
        "Finish by calling structured_output with status clear, watch, or block. Do not return a prose report or acceptance-report block.",
    ].join("\n");
}

/**
 * Detect duplicates, extras, and missing ids. Duplicates fail closed because a
 * verifier must not inflate a claim/evidence set by repeating an id. Returns
 * one blocker per offending category so callers can append them.
 */
function idSetErrors(
    submitted: readonly string[],
    expected: readonly string[],
    noun: "claim" | "evidence",
): string[] {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const id of submitted) {
        if (seen.has(id)) duplicates.add(id);
        else seen.add(id);
    }
    const expectedSet = new Set(expected);
    const extra = [...new Set(submitted)].filter((id) => !expectedSet.has(id));
    const missing = expected.filter((id) => !seen.has(id));
    const blockers: string[] = [];
    for (const id of [...duplicates].toSorted()) {
        blockers.push(`Duplicate ${noun} id ${id} is not allowed.`);
    }
    for (const id of extra) {
        blockers.push(`Output invents unexpected ${noun} ${id}.`);
    }
    for (const id of missing) {
        blockers.push(`Output drops expected ${noun} ${id}.`);
    }
    return blockers;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Deterministically group claims by `(domain, expectedOutcome)` so each
 * verifier group owns a single coherent aggregate outcome. Groups are ordered
 * by canonical domain rank then outcome rank; claim ids are sorted ascending;
 * evidence descriptors are merged (deduped by id, source refs unioned+sorted).
 * Output is byte-identical regardless of input order.
 */
export function groupVerificationClaims(
    claims: readonly VerificationClaim[],
): VerificationGroup[] {
    const buckets = new Map<string, VerificationClaim[]>();
    for (const claim of claims) {
        if (!VERIFICATION_DOMAINS.includes(claim.domain)) continue;
        if (!VERIFICATION_OUTCOMES.includes(claim.expectedOutcome)) continue;
        const key = groupKey(claim.domain, claim.expectedOutcome);
        const bucket = buckets.get(key);
        if (bucket) bucket.push(claim);
        else buckets.set(key, [claim]);
    }

    return [...buckets.entries()]
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([, bucket]) => {
            const ordered = [...bucket].toSorted((a, b) =>
                a.id.localeCompare(b.id),
            );
            const domain = ordered[0].domain;
            const outcome = ordered[0].expectedOutcome;
            const evidence = mergeEvidence(
                ordered.flatMap((claim) => claim.evidence),
            );
            return {
                domain,
                outcome,
                agent: VERIFICATION_ROUTING[domain],
                claimIds: ordered.map((claim) => claim.id),
                assertions: ordered.map((claim) => claim.assertion),
                evidence,
                evidenceIds: evidence.map((descriptor) => descriptor.id),
            } satisfies VerificationGroup;
        });
}

/** Build the deterministic node plan consumed by the 0.50 coordinator. */
export function buildVerificationPlan(
    input: VerificationBuildInput,
): VerificationPlan {
    const groups = groupVerificationClaims(input.claims);
    const nodes: VerificationPlanNode[] = groups.map((group) => ({
        role: "verifier",
        agent: group.agent,
        task: renderVerifierTask(group),
        outputName: verifierStepName(group.domain, group.outcome),
        schema: VERIFIER_OUTPUT_SCHEMA,
    }));

    if (input.architectureImpact === true) {
        const architectureScope = input.architectureScope ?? {
            claimIds: uniqueSorted(groups.flatMap((group) => group.claimIds)),
            evidenceIds: uniqueSorted(
                groups.flatMap((group) => group.evidenceIds),
            ),
        };
        const architectureEvidence = mergeEvidence(
            input.claims.flatMap((claim) => claim.evidence),
        ).filter((descriptor) =>
            architectureScope.evidenceIds.includes(descriptor.id),
        );
        nodes.push({
            role: "architect",
            agent: ARCHITECT_AGENT,
            task: architectTask(
                groups.map((group) =>
                    verifierStepName(group.domain, group.outcome),
                ),
                architectureScope,
                architectureEvidence,
            ),
            outputName: "architect_advisory",
            schema: ARCHITECT_OUTPUT_SCHEMA,
        });
    }

    return { nodes };
}

/**
 * Validate a verifier structured completion against its group with EXACT
 * correlation. Fails closed on: non-object, wrong/missing/extra fields,
 * outcome diverging from the group's expected aggregate, claim id set drift
 * (extra OR missing), evidence id set drift (extra OR missing), or malformed
 * array shapes. A verifier may never invent new EV-* or CL-* ids.
 */
export function verifyVerifierCompletion(
    group: VerificationGroup,
    output: unknown,
): CompletionResult {
    const blockers: string[] = [];
    if (!isRecord(output)) {
        return { ok: false, blockers: ["Verifier output must be an object."] };
    }
    const fieldError = exactFieldError(
        output,
        ["outcome", "claimIds", "evidenceIds", "summary"],
        "Verifier output",
    );
    if (fieldError) blockers.push(fieldError);
    const outcome = matchingOutcome(output.outcome);
    if (outcome === undefined) {
        blockers.push(
            `Verifier outcome must be one of ${VERIFICATION_OUTCOMES.join(", ")}.`,
        );
    } else if (outcome !== group.outcome) {
        blockers.push(
            `Verifier outcome '${outcome}' diverges from expected group outcome '${group.outcome}'.`,
        );
    }
    if (!isStringArray(output.claimIds)) {
        blockers.push("Verifier claimIds must be an array of strings.");
    } else {
        blockers.push(...idSetErrors(output.claimIds, group.claimIds, "claim"));
    }
    if (!isStringArray(output.evidenceIds)) {
        blockers.push("Verifier evidenceIds must be an array of strings.");
    } else {
        blockers.push(
            ...idSetErrors(output.evidenceIds, group.evidenceIds, "evidence"),
        );
    }
    if (!isNonEmptyString(output.summary)) {
        blockers.push("Verifier summary must be a non-empty string.");
    }
    if (outcome === undefined || blockers.length > 0) {
        return { ok: false, blockers };
    }
    return { ok: true, outcome };
}

/**
 * Validate an architect structured completion against the EXACT expected
 * claim/evidence scope. `watch` and `block` are both accepted (T3/gate decides
 * behavior); fails closed on malformed structure, unknown status, missing
 * risks, or scope drift (extra OR missing claim/evidence ids).
 */
export function verifyArchitectCompletion(
    output: unknown,
    expected: ArchitectExpectedScope,
): ArchitectCompletionResult {
    const blockers: string[] = [];
    if (!isRecord(output)) {
        return { ok: false, blockers: ["Architect output must be an object."] };
    }
    const fieldError = exactFieldError(
        output,
        ["status", "claimIds", "evidenceIds", "risks", "summary"],
        "Architect output",
    );
    if (fieldError) blockers.push(fieldError);
    const status = matchingStatus(output.status);
    if (status === undefined) {
        blockers.push(
            `Architect status must be one of ${ARCHITECTURAL_STATUSES.join(", ")}.`,
        );
    }
    if (!isStringArray(output.claimIds)) {
        blockers.push("Architect claimIds must be an array of strings.");
    } else {
        blockers.push(
            ...idSetErrors(output.claimIds, expected.claimIds, "claim"),
        );
    }
    if (!isStringArray(output.evidenceIds)) {
        blockers.push("Architect evidenceIds must be an array of strings.");
    } else {
        blockers.push(
            ...idSetErrors(
                output.evidenceIds,
                expected.evidenceIds,
                "evidence",
            ),
        );
    }
    if (!isStringArray(output.risks)) {
        blockers.push("Architect risks must be an array of strings.");
    }
    if (!isNonEmptyString(output.summary)) {
        blockers.push("Architect summary must be a non-empty string.");
    }
    if (status === undefined || blockers.length > 0) {
        return { ok: false, blockers };
    }
    return { ok: true, status };
}

/**
 * Restrict native verification to its dedicated agents. Tool access is
 * enforced after alias expansion by the private child policy binding.
 */
export function buildVerifierCapabilityCeiling(): CapabilityCeiling {
    return {
        allowedAgents: uniqueSorted([
            ...VERIFIER_AGENT_ALLOWLIST,
            ARCHITECT_AGENT,
        ]),
        denyExtensions: false,
    };
}
