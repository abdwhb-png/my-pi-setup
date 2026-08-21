/**
 * brainstorm-forcer — Programmatically drives brainstorming workflow.
 *
 * Key redesign goals:
 * - `/brainstorm <topic>` now STARTS the run immediately (not arm-only)
 * - phase gates are based on actual tool inventory (`pi.getAllTools()`)
 * - mutation tools are blocked until documenting phase
 * - reads / search / ask_user_question stay available through discussion phases
 * - `/brainstorm next` enforces evidence-based completion criteria
 * - `/brainstorm force-next` bypasses criteria manually
 */

import { randomUUID } from "node:crypto";
import { dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type {
    ExtensionAPI,
    ExtensionContext,
    MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import {
    registerSubagentCapabilityCeiling,
    resolveCurrentSubagentCapabilityCeiling,
    type SubagentCapabilityCeilingHandle,
} from "pi-subagents/capability-ceiling";
import { Type } from "typebox";
import { createWidget, type WidgetHandle } from "../_shared/fancy-footer";
import { createUiColors } from "../_shared/ui/ui-colors";
import { createBrainstormArtifactStore } from "./artifacts";
import {
    createExplorationLedger,
    isExplorationRecord,
    type ExplorationRecord,
    type RecordVerificationCompletionInput,
    type RecordVerificationFailureInput,
} from "./exploration-ledger";
import {
    ArtifactReviewView,
    type ReviewAction,
    type ReviewDecision,
} from "./review";
import {
    ARCHITECT_AGENT,
    buildVerificationPlan,
    buildVerifierCapabilityCeiling,
    groupVerificationClaims,
    verifyArchitectCompletion,
    verifyVerifierCompletion,
    VERIFIER_AGENT_ALLOWLIST,
    type EvidenceDescriptor,
    type VerificationClaim,
    type VerificationGroup,
    type VerificationOutcome,
} from "./verification";
import {
    createVerificationCoordinator,
    isPendingVerificationRun,
    type OwnedTerminalCompletion,
    type PendingVerificationRun,
    type PendingVerificationStep,
    type VerificationCoordinatorCompletion,
    type VerificationDelegationNode,
} from "./verification-runner";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PHASES = [
    "discovery",
    "understanding",
    "exploring",
    "presenting",
    "documenting",
] as const;
type Phase = (typeof PHASES)[number];

const PHASE_LABELS: Record<Phase, string> = {
    discovery: "Discovery",
    understanding: "Understanding",
    exploring: "Exploring",
    presenting: "Presenting",
    documenting: "Documenting",
};

const PHASE_ICONS: Record<Phase, string> = {
    discovery: "🔬",
    understanding: "❓",
    exploring: "💡",
    presenting: "📐",
    documenting: "📝",
};

const PHASE_SUBMISSION_TOOLS: Record<Phase, string> = {
    discovery: "brainstorm_submit_discovery",
    understanding: "brainstorm_submit_understanding",
    exploring: "brainstorm_submit_exploring",
    presenting: "brainstorm_submit_presenting",
    documenting: "brainstorm_submit_design",
};

const EXPLORING_WORKFLOW_TOOLS = new Set([
    "brainstorm_record_claim",
    "brainstorm_run_verification",
    "brainstorm_request_waiver",
]);

const EXPLORING_ORCHESTRATION_TOOLS = new Set(["subagent", "subagent_wait"]);

const ALWAYS_BLOCKED_TOOLS = new Set([
    "write",
    "edit",
    "bash",
    "safe_bash",
    "session_plan",
    "write_plan",
    "edit_plan",
]);

const SESSION_KEY = "brainstorm-forcer";
const LEDGER_SESSION_KEY = "brainstorm-forcer-ledger";
const TERMINAL_COMMIT_SESSION_KEY = "brainstorm-forcer-terminal-commit";
const WIDGET_ID = "brainstorm-forcer";
const DEFAULT_REJECTION_REASON =
    "Refine the current phase: investigate remaining gaps, validate assumptions, go deeper, revise its artifact, then request transition again.";

type TopicState = {
    raw: string;
    display: string;
};

type TerminalVerificationCommit = Readonly<{
    runId: string;
    verificationRunId: string;
    records: readonly ExplorationRecord[];
}>;

function isTerminalVerificationCommit(
    data: unknown,
    currentRunId: string,
    verificationRunId: string,
): data is TerminalVerificationCommit {
    if (!data || typeof data !== "object" || Array.isArray(data)) return false;
    const candidate = data as {
        runId?: unknown;
        verificationRunId?: unknown;
        records?: unknown;
    };
    if (
        candidate.runId !== currentRunId ||
        candidate.verificationRunId !== verificationRunId ||
        !Array.isArray(candidate.records) ||
        candidate.records.length === 0 ||
        !candidate.records.every(
            (record) =>
                isExplorationRecord(record) && record.runId === currentRunId,
        )
    )
        return false;
    const reviews = candidate.records.filter(
        (record): record is Extract<ExplorationRecord, { kind: "review" }> =>
            isExplorationRecord(record) && record.kind === "review",
    );
    const verifierEvidenceIds = new Set(
        candidate.records.flatMap((record) =>
            isExplorationRecord(record) &&
            record.kind === "evidence" &&
            record.verifier?.verificationRunId === verificationRunId
                ? [record.id]
                : [],
        ),
    );
    const successful = reviews.every(
        (review) => "audit" in review && review.audit.status === "success",
    );
    const failed = reviews.every(
        (review) =>
            "audit" in review &&
            (review.audit.status === "failed" ||
                review.audit.status === "malformed" ||
                review.audit.status === "timeout"),
    );
    return (
        reviews.length > 0 &&
        reviews.every(
            (review) =>
                "audit" in review &&
                review.audit.verificationRunId === verificationRunId,
        ) &&
        ((successful &&
            reviews.every(
                (review) =>
                    "verifierEvidenceId" in review &&
                    typeof review.verifierEvidenceId === "string" &&
                    verifierEvidenceIds.has(review.verifierEvidenceId),
            )) ||
            (failed && verifierEvidenceIds.size === 0))
    );
}

function summarizeTopicForUi(raw: string): string {
    const singleLine = raw.replace(/\s+/g, " ").trim();
    if (singleLine.length <= 64) return singleLine;
    return `${singleLine.slice(0, 61).trimEnd()}…`;
}

function boundedSingleLine(value: string, maxLength: number): string {
    const normalized = value.replace(/\s+/g, " ").trim();
    return normalized.length <= maxLength
        ? normalized
        : `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function boundedVerificationWarning(message: string): string {
    return boundedSingleLine(message, 700);
}

function summarizeIds(ids: readonly string[]): string {
    const displayed = ids
        .slice(0, 8)
        .map((id) => boundedSingleLine(id, 64) || "<empty>");
    const summary =
        ids.length <= 8
            ? displayed.join(", ")
            : `${displayed.join(", ")} (+${ids.length - 8} more)`;
    return boundedSingleLine(summary, 600);
}

function markdownList(items: readonly string[]): string[] {
    return items.length > 0 ? items.map((item) => `- ${item}`) : ["- None."];
}

function markdownSections(
    sections: readonly { title: string; content: string; feedback?: string }[],
): string[] {
    return sections.flatMap((section) => [
        `## ${section.title}`,
        "",
        section.content,
        ...(section.feedback ? ["", `**Feedback:** ${section.feedback}`] : []),
        "",
    ]);
}

type ToolGroups = {
    research: Set<string>;
    questioning: Set<string>;
    mutation: Set<string>;
};

type Evidence = {
    researchCalls: number;
    questionCalls: number;
    assistantTurnsByPhase: Record<Phase, number>;
};

type ArtifactCheckpoint = {
    path: string;
    revision: number;
    complete: boolean;
    blocker?: string;
};

type ArtifactCheckpoints = Partial<Record<Phase, ArtifactCheckpoint>>;

const EMPTY_EVIDENCE = (): Evidence => ({
    researchCalls: 0,
    questionCalls: 0,
    assistantTurnsByPhase: {
        discovery: 0,
        understanding: 0,
        exploring: 0,
        presenting: 0,
        documenting: 0,
    },
});

function buildToolGroups(pi: ExtensionAPI): ToolGroups {
    const tools = pi.getAllTools();

    const research = new Set<string>();
    const questioning = new Set<string>();
    const mutation = new Set<string>();

    const isMutationLike = (name: string, description: string): boolean => {
        const text = `${name} ${description}`.toLowerCase();
        return [
            /(^|[_-])(write|edit)([_-]|$)/,
            /(^|[_-])(delete|remove|rename|move|apply|patch|commit|push|merge|create|save|update)([_-]|$)/,
            /\b(write|edit|delete|remove|rename|move|apply|patch|commit|push|merge|create|save|update|modify|overwrite|mutate)\b/,
        ].some((re) => re.test(text));
    };

    const isResearchLike = (name: string, description: string): boolean => {
        const text = `${name} ${description}`.toLowerCase();
        return [
            /(^|[_-])(read|grep|find|ls)([_-]|$)/,
            /(^|[_-])(search|fetch|query|lookup|crawl|scan|inspect|list)([_-]|$)/,
            /\b(read|search|fetch|query|lookup|crawl|scan|inspect|list|grep|find|discover|analyze|analyse|retrieve|browse|web)\b/,
        ].some((re) => re.test(text));
    };

    for (const tool of tools) {
        const name = tool.name;
        const description = tool.description ?? "";
        if (name === "ask_user_question") questioning.add(name);
        if (isMutationLike(name, description)) mutation.add(name);
        if (isResearchLike(name, description)) research.add(name);
    }

    return { research, questioning, mutation };
}

function canUseTool(
    phase: Phase,
    toolName: string,
    groups: ToolGroups,
    input?: Record<string, unknown>,
    pendingVerification?: PendingVerificationRun | null,
): boolean {
    if (toolName === "brainstorm_transition") return true;
    if (phase === "exploring" && EXPLORING_WORKFLOW_TOOLS.has(toolName))
        return true;
    if (Object.values(PHASE_SUBMISSION_TOOLS).includes(toolName))
        return toolName === PHASE_SUBMISSION_TOOLS[phase];
    if (
        phase === "exploring" &&
        pendingVerification &&
        toolName === "ask_user_question"
    )
        return false;
    if (toolName === "subagent" || toolName === "subagent_wait") return false;
    if (ALWAYS_BLOCKED_TOOLS.has(toolName)) return false;
    return !groups.mutation.has(toolName);
}

function pendingVerificationToolBlockReason(
    phase: Phase,
    toolName: string,
    input: Record<string, unknown> | undefined,
    pendingVerification: PendingVerificationRun | null,
): string | undefined {
    if (phase !== "exploring") return undefined;
    if (toolName === "ask_user_question" && pendingVerification)
        return `BLOCKED: ask_user_question is blocked while verification run ${pendingVerification.runId} is pending. Wait for terminal processing to record RV-* before asking the user.`;
    if (toolName === "subagent" || toolName === "subagent_wait")
        return pendingVerification
            ? `BLOCKED: ${toolName} cannot control Brainstorm coordinator run ${pendingVerification.runId}. Use /brainstorm status or /brainstorm stop.`
            : `BLOCKED: direct ${toolName} calls are disabled during Exploring. Use brainstorm_run_verification.`;
    return undefined;
}

function phaseRestrictionSummary(phase: Phase): string {
    switch (phase) {
        case "discovery":
            return "Discovery phase. Any non-mutating tool is allowed. Mutation blocked. Gather evidence + produce Research Summary.";
        case "understanding":
            return "Understanding phase. Any non-mutating tool is allowed; prefer ask_user_question to refine requirements. Mutation blocked.";
        case "exploring":
            return "Exploring phase. Allowed non-mutating results become EV-* records. Qualify CL-* claims, run dedicated structured verification, obtain user-approved waivers, and submit 2-3 claim-linked approaches. Direct subagent and subagent_wait calls are blocked; inspect or cancel the coordinator through /brainstorm status or /brainstorm stop. Mutation is blocked.";
        case "presenting":
            return "Presenting phase. Any non-mutating tool is allowed. Present design sections, validate with user. Mutation blocked.";
        case "documenting":
            return "Submit final design with brainstorm_submit_design. Generic mutation and planning tools remain blocked.";
    }
}

function phaseBanner(phase: Phase, topic: TopicState): string {
    return `${PHASE_ICONS[phase]} Brainstorm ${PHASE_LABELS[phase]} (${PHASES.indexOf(phase) + 1}/${PHASES.length}) — ${topic.display}`;
}

function phasePrompt(
    phase: Phase,
    topic: TopicState,
    evidence: Evidence,
): string {
    const completed: string[] = [];
    const idx = PHASES.indexOf(phase);
    for (let i = 0; i < idx; i++) {
        completed.push(`- COMPLETED: ${PHASE_LABELS[PHASES[i]]}`);
    }

    const evidenceLine = `Observed tool calls — research=${evidence.researchCalls}, questions=${evidence.questionCalls}. Completion is determined only by the structured phase artifact.`;
    const phaseControl = [
        `Submit this phase's complete content with \`${PHASE_SUBMISSION_TOOLS[phase]}\`.`,
        `After submission succeeds, call \`brainstorm_transition\` with action \`next\`. Use action \`previous\` to go back.`,
        `The transition requires explicit user approval. On rejection, stay in the current phase, follow the feedback, deepen the work, and submit a new revision before requesting \`next\` again.`,
        `Do not start the next phase before the transition succeeds.`,
    ];

    switch (phase) {
        case "discovery":
            return [
                `Current topic: ${topic.raw}`,
                `Current phase: DISCOVERY`,
                `Use the bundled skill \`brainstorm-forcer\` and research tools to understand the codebase and produce a Research Summary with Files Accessed / Key Findings / Gaps.`,
                ...phaseControl,
                evidenceLine,
            ].join("\n\n");
        case "understanding":
            return [
                `Current topic: ${topic.raw}`,
                `Current phase: UNDERSTANDING`,
                `Use the bundled skill \`brainstorm-forcer\` and ask_user_question to ask one clarifying question at a time. Do not write code.`,
                ...phaseControl,
                evidenceLine,
                ...completed,
            ].join("\n\n");
        case "exploring":
            return [
                `Current topic: ${topic.raw}`,
                `Current phase: EXPLORING`,
                `Follow the bundled skill \`brainstorm-forcer\`. Identify each decision-relevant assumption and classify it as empirical, design-choice, or future-contingency. Do not write code.`,
                `Verify empirical assumptions with direct read/code/LSP/AST/test/API/official-documentation tools. Indexed or secondary retrieval does not replace direct evidence.`,
                `Allowed Exploring tool results are captured automatically as EV-* records. Use \`brainstorm_record_claim\` to create CL-* records with verificationDomain and architectureImpact; never invent evidence identifiers. Direct proof uses a strict tool allowlist; unknown tools and user input are ineligible.`,
                `Critical claims supported by \`ctx_search\` need direct corroboration. Failed, stale, indexed-only, secondary, or verifier evidence cannot independently verify a critical empirical claim.`,
                `Call \`brainstorm_run_verification\` with only the selected claimIds. It coordinates dedicated foreground leaves through pi-subagents structured delegation, routes verifier groups in parallel, and adds an architect advisory only for architecture-impacting claims. Do not call \`subagent\` or \`subagent_wait\` directly. Use \`/brainstorm status\` to inspect the owned run and \`/brainstorm stop\` to cancel its exact active attempts.`,
                `\`ask_user_question\` remains blocked until terminal verification processing records the required RV-* audit.`,
                `Use \`brainstorm_request_waiver\` only for an unresolved critical claim. The user must approve the documented waiver; a waiver also requires later successful verification.`,
                `Obtain the explicit user choice through a dedicated single-question \`ask_user_question\` call. Submit 2-3 approaches whose \`claimIds\` reference active claims, an evidence-backed recommendation with \`recommendationClaimIds\`, the user choice, and its \`userChoiceEvidenceId\`.`,
                ...phaseControl,
                evidenceLine,
                ...completed,
            ].join("\n\n");
        case "presenting":
            return [
                `Current topic: ${topic.raw}`,
                `Current phase: PRESENTING`,
                `Follow the bundled skill \`brainstorm-forcer\`: present design in 200-300 word sections. Validate sections with user using ask_user_question when appropriate. Do not write code.`,
                ...phaseControl,
                evidenceLine,
                ...completed,
            ].join("\n\n");
        case "documenting":
            return [
                `Current topic: ${topic.raw}`,
                `Current phase: DOCUMENTING`,
                `Submit the final design with \`brainstorm_submit_design\`. Do not create an implementation plan, choose a planning workflow, or implement code.`,
                ...phaseControl,
                evidenceLine,
                ...completed,
            ].join("\n\n");
    }
}

const brainstormMessageRenderer: MessageRenderer = (
    message,
    { expanded },
    theme,
) => {
    const colors = createUiColors(theme);
    const content = typeof message.content === "string" ? message.content : "";
    let text = colors.primary("[brainstorm] ") + colors.text(content);
    if (expanded && message.details) {
        text += "\n" + colors.meta(JSON.stringify(message.details, null, 2));
    }
    return new Text(text, 0, 0);
};

/**
 * Manages the read-only verifier capability ceiling for the active brainstorm
 * session. Source is stable ("brainstorm-forcer") so reload re-registration is
 * idempotent. Registers by exact session ID; disposes only this extension's
 * handle. Fail closed if session ID is unavailable.
 */
export function createCapabilityCeilingManager() {
    let handle: SubagentCapabilityCeilingHandle | null = null;
    return {
        register(sessionId: string): void {
            if (!sessionId || !sessionId.trim())
                throw new Error(
                    "Cannot register verifier ceiling without a session ID.",
                );
            if (handle) handle.dispose();
            handle = registerSubagentCapabilityCeiling({
                sessionId,
                source: "brainstorm-forcer",
                ceiling: buildVerifierCapabilityCeiling(),
            });
        },
        dispose(): void {
            if (handle) {
                handle.dispose();
                handle = null;
            }
        },
    };
}

/**
 * Preflight foundation: verifies each allowlisted routed verifier agent is
 * discoverable and launchable under the effective capability ceiling without
 * spawning. Uses public pi-subagents/preflight via dynamic import (the module
 * is heavy — agent discovery, model resolution). Slice B calls this before
 * every spawn.
 */
export async function preflightVerifierAgents(
    sessionId: string,
    cwd: string,
    agents: readonly string[],
): Promise<
    ReadonlyArray<{
        agent: string;
        ok: boolean;
        message?: string;
    }>
> {
    const allowedAgents = new Set([
        ...VERIFIER_AGENT_ALLOWLIST,
        ARCHITECT_AGENT,
    ]);
    if (agents.some((agent) => !allowedAgents.has(agent)))
        throw new Error("A selected verifier preflight agent is not allowed.");
    if (agents.length === 0 || new Set(agents).size !== agents.length)
        throw new Error(
            "Verifier preflight agents must be a non-empty unique sequence.",
        );
    const { resolveSubagentLaunchContract } =
        await import("pi-subagents/preflight");
    const capabilityCeiling =
        resolveCurrentSubagentCapabilityCeiling(sessionId);
    if (!capabilityCeiling)
        return agents.map((agent) => ({
            agent,
            ok: false,
            message: "Verifier capability ceiling is not active.",
        }));
    const results = await Promise.all(
        agents.map(async (agent) => {
            try {
                const result = await resolveSubagentLaunchContract({
                    agent,
                    cwd,
                    context: "fresh",
                    capabilityCeiling,
                });
                return {
                    agent,
                    ok: result.ok,
                    message: result.ok ? undefined : result.message,
                };
            } catch (error) {
                return {
                    agent,
                    ok: false,
                    message:
                        error instanceof Error ? error.message : String(error),
                };
            }
        }),
    );
    return results;
}

type PreflightResult = Awaited<ReturnType<typeof preflightVerifierAgents>>;

export type BrainstormForcerDependencies = Readonly<{
    preflight?: (
        sessionId: string,
        cwd: string,
        agents: readonly string[],
    ) => Promise<PreflightResult>;
}>;

export default function brainstormForcer(
    pi: ExtensionAPI,
    dependencies: BrainstormForcerDependencies = {},
) {
    pi.registerMessageRenderer(SESSION_KEY, brainstormMessageRenderer);

    let activePhase: Phase | null = null;
    let topic: TopicState = { raw: "", display: "" };
    let evidence = EMPTY_EVIDENCE();
    let groups: ToolGroups = {
        research: new Set(),
        questioning: new Set(),
        mutation: new Set(),
    };
    let widgetText: string | null = null;
    let widget: WidgetHandle | null = null;
    let runId = "";
    let startedAt = "";
    let artifactStore: ReturnType<typeof createBrainstormArtifactStore> | null =
        null;
    let artifacts: ArtifactCheckpoints = {};
    let explorationLedger: ReturnType<typeof createExplorationLedger> | null =
        null;
    let pendingVerification: PendingVerificationRun | null = null;
    let terminalRecoveryBlockedRunId: string | null = null;
    let lastTerminalRunId: string | null = null;
    let activeContext: ExtensionContext | null = null;
    let launchInProgress = false;
    const earlyCompletionEvents: VerificationCoordinatorCompletion[] = [];
    const processingRunIds = new Set<string>();
    const ceilingManager = createCapabilityCeilingManager();
    const verificationCoordinator = createVerificationCoordinator(pi.events);
    const runPreflight = dependencies.preflight ?? preflightVerifierAgents;
    const unsubscribeCompletion = verificationCoordinator.onComplete((data) => {
        const dispatchedPending = pendingVerification;
        const dispatchedContext = activeContext;
        void handleAsyncCompletion(data).catch((error) => {
            try {
                const pendingRunId = boundedSingleLine(
                    dispatchedPending?.runId ?? "",
                    96,
                );
                const reason = boundedSingleLine(
                    error instanceof Error ? error.message : String(error),
                    500,
                );
                const stillOwnsActivePending =
                    dispatchedPending !== null &&
                    pendingVerification === dispatchedPending &&
                    activeContext === dispatchedContext;
                if (stillOwnsActivePending && dispatchedContext) {
                    pendingVerification = null;
                    saveState(dispatchedContext);
                    dispatchedContext.ui.notify(
                        boundedVerificationWarning(
                            `Verification completion${pendingRunId ? ` ${pendingRunId}` : ""} contained: ${reason || "unknown async error"}. Pending cleared.`,
                        ),
                        "warning",
                    );
                } else if (dispatchedContext) {
                    dispatchedContext.ui.notify(
                        boundedVerificationWarning(
                            `Verification completion${pendingRunId ? ` ${pendingRunId}` : ""} contained after branch state changed: ${reason || "unknown async error"}. Active pending preserved.`,
                        ),
                        "warning",
                    );
                } else {
                    process.stderr.write(
                        `${boundedVerificationWarning(
                            `brainstorm-forcer verification completion contained: ${reason || "unknown async error"}`,
                        )}\n`,
                    );
                }
            } catch (boundaryError) {
                const boundaryReason = boundedSingleLine(
                    boundaryError instanceof Error
                        ? boundaryError.message
                        : String(boundaryError),
                    500,
                );
                try {
                    process.stderr.write(
                        `${boundedVerificationWarning(
                            `brainstorm-forcer verification error boundary failed: ${boundaryReason || "unknown boundary error"}`,
                        )}\n`,
                    );
                } catch {
                    return;
                }
            }
        });
    });

    pi.registerTool({
        name: "brainstorm_submit_discovery",
        label: "Submit Brainstorm Discovery",
        description:
            "Write the structured Discovery artifact for the active brainstorming run.",
        parameters: Type.Object(
            {
                filesAccessed: Type.Array(Type.String({ minLength: 1 }), {
                    minItems: 1,
                }),
                keyFindings: Type.Array(Type.String({ minLength: 1 }), {
                    minItems: 1,
                }),
                gaps: Type.Array(Type.String({ minLength: 1 })),
            },
            { additionalProperties: false },
        ),
        async execute(_id, params, _signal, _update, ctx) {
            if (activePhase !== "discovery")
                throw new Error(
                    `Discovery artifact is unavailable during ${activePhase ?? "inactive"} phase.`,
                );
            const markdown = [
                "# Discovery",
                "",
                "## Files Accessed",
                "",
                ...params.filesAccessed.map((item) => `- ${item}`),
                "",
                "## Key Findings",
                "",
                ...params.keyFindings.map((item) => `- ${item}`),
                "",
                "## Gaps",
                "",
                ...(params.gaps.length > 0
                    ? params.gaps.map((item) => `- ${item}`)
                    : ["- None."]),
            ].join("\n");
            return submitArtifact(
                "discovery",
                "brainstorm_submit_discovery",
                markdown,
                true,
                undefined,
                ctx,
            );
        },
    });

    pi.registerTool({
        name: "brainstorm_submit_understanding",
        label: "Submit Brainstorm Understanding",
        description:
            "Write the structured Understanding artifact for the active brainstorming run.",
        parameters: Type.Object(
            {
                objective: Type.String({ minLength: 1 }),
                requirements: Type.Array(Type.String({ minLength: 1 }), {
                    minItems: 1,
                }),
                constraints: Type.Array(Type.String({ minLength: 1 })),
                successCriteria: Type.Array(Type.String({ minLength: 1 }), {
                    minItems: 1,
                }),
                openQuestions: Type.Array(Type.String({ minLength: 1 })),
            },
            { additionalProperties: false },
        ),
        async execute(_id, params, _signal, _update, ctx) {
            const markdown = [
                "# Understanding",
                "",
                "## Objective",
                "",
                params.objective,
                "",
                "## Requirements",
                "",
                ...markdownList(params.requirements),
                "",
                "## Constraints",
                "",
                ...markdownList(params.constraints),
                "",
                "## Success Criteria",
                "",
                ...markdownList(params.successCriteria),
                "",
                "## Open Questions",
                "",
                ...markdownList(params.openQuestions),
            ].join("\n");
            const complete = params.openQuestions.length === 0;
            return submitArtifact(
                "understanding",
                "brainstorm_submit_understanding",
                markdown,
                complete,
                complete
                    ? undefined
                    : "Understanding incomplete: open questions remain.",
                ctx,
            );
        },
    });

    pi.registerTool({
        name: "brainstorm_record_claim",
        label: "Record Brainstorm Claim",
        description:
            "Create an immutable qualified claim for the active Exploring phase.",
        parameters: Type.Object(
            {
                assertion: Type.String({ minLength: 1 }),
                classification: StringEnum([
                    "empirical",
                    "design-choice",
                    "future-contingency",
                ] as const),
                critical: Type.Boolean(),
                verdict: StringEnum([
                    "verified",
                    "falsified",
                    "unresolved",
                ] as const),
                evidenceIds: Type.Array(Type.String({ pattern: "^EV-\\d+$" })),
                contradictoryEvidenceIds: Type.Array(
                    Type.String({ pattern: "^EV-\\d+$" }),
                ),
                impact: Type.String({ minLength: 1 }),
                mitigation: Type.String({ minLength: 1 }),
                verificationDomain: StringEnum([
                    "pi",
                    "local-code",
                    "external",
                    "performance",
                ] as const),
                architectureImpact: Type.Boolean(),
                supersedesClaimId: Type.Optional(
                    Type.String({ pattern: "^CL-\\d+$" }),
                ),
            },
            { additionalProperties: false },
        ),
        async execute(_id, params, _signal, _update, ctx) {
            if (activePhase !== "exploring")
                throw new Error(
                    `Claims are unavailable during ${activePhase ?? "inactive"} phase.`,
                );
            explorationLedger ??= createExplorationLedger({ runId });
            const record = explorationLedger.recordClaim(params);
            appendExplorationRecord(record, ctx);
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Claim recorded: ${record.id} (${record.verdict}).`,
                    },
                ],
                details: { record },
            };
        },
    });

    pi.registerTool({
        name: "brainstorm_run_verification",
        label: "Run Brainstorm Verification",
        description:
            "Start one dedicated read-only structured verification run for selected active claims.",
        parameters: Type.Object(
            {
                claimIds: Type.Array(Type.String({ pattern: "^CL-\\d+$" }), {
                    minItems: 1,
                    uniqueItems: true,
                }),
            },
            { additionalProperties: false },
        ),
        executionMode: "sequential",
        async execute(_id, params, _signal, _update, ctx) {
            if (activePhase !== "exploring")
                throw new Error(
                    `Verification is unavailable during ${activePhase ?? "inactive"} phase.`,
                );
            activeContext = ctx;
            const pending = await launchVerification(params.claimIds, ctx);
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Verification started: ${pending.runId} for ${pending.claimIds.join(", ")}.`,
                    },
                ],
                details: {
                    status: "pending",
                    runId: pending.runId,
                    claimIds: pending.claimIds,
                },
            };
        },
    });

    pi.registerTool({
        name: "brainstorm_request_waiver",
        label: "Request Brainstorm Waiver",
        description:
            "Ask the user to approve a documented waiver for an unresolved critical Exploring claim.",
        parameters: Type.Object(
            {
                claimId: Type.String({ pattern: "^CL-\\d+$" }),
                reason: Type.String({ minLength: 1 }),
                impact: Type.String({ minLength: 1 }),
                mitigation: Type.String({ minLength: 1 }),
                reevaluateWhen: Type.String({ minLength: 1 }),
            },
            { additionalProperties: false },
        ),
        async execute(_id, params, _signal, _update, ctx) {
            if (activePhase !== "exploring")
                throw new Error(
                    `Waivers are unavailable during ${activePhase ?? "inactive"} phase.`,
                );
            if (!ctx.hasUI)
                throw new Error(
                    "Waiver approval requires interactive user input.",
                );
            explorationLedger ??= createExplorationLedger({ runId });
            const claim = explorationLedger
                .getActiveClaims()
                .find((item) => item.id === params.claimId);
            if (!claim || !claim.critical || claim.verdict !== "unresolved")
                throw new Error(
                    "Waivers apply only to active unresolved critical claims.",
                );
            const choice = await ctx.ui.select(
                [
                    `Approve waiver for ${params.claimId}?`,
                    `Reason: ${params.reason}`,
                    `Impact: ${params.impact}`,
                    `Mitigation: ${params.mitigation}`,
                    `Re-evaluate when: ${params.reevaluateWhen}`,
                ].join("\n"),
                ["Approve waiver", "Reject"],
            );
            if (choice !== "Approve waiver")
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `Waiver rejected for ${params.claimId}.`,
                        },
                    ],
                    details: { approved: false, claimId: params.claimId },
                };
            const record = explorationLedger.recordWaiver(params);
            appendExplorationRecord(record, ctx);
            return {
                content: [
                    {
                        type: "text" as const,
                        text: `Waiver approved and recorded: ${record.id}.`,
                    },
                ],
                details: { approved: true, record },
            };
        },
    });

    const ApproachSchema = Type.Object(
        {
            title: Type.String({ minLength: 1 }),
            summary: Type.String({ minLength: 1 }),
            tradeoffs: Type.Array(Type.String({ minLength: 1 })),
            claimIds: Type.Array(Type.String({ pattern: "^CL-\\d+$" }), {
                minItems: 1,
            }),
            failureConditions: Type.Array(Type.String({ minLength: 1 })),
        },
        { additionalProperties: false },
    );
    pi.registerTool({
        name: "brainstorm_submit_exploring",
        label: "Submit Brainstorm Exploration",
        description:
            "Write the structured Exploring artifact for the active brainstorming run.",
        parameters: Type.Object(
            {
                approaches: Type.Array(ApproachSchema, {
                    minItems: 2,
                    maxItems: 3,
                }),
                recommendation: Type.String({ minLength: 1 }),
                recommendationClaimIds: Type.Array(
                    Type.String({ pattern: "^CL-\\d+$" }),
                    { minItems: 1 },
                ),
                userChoice: Type.String({ minLength: 1 }),
                userChoiceEvidenceId: Type.String({ pattern: "^EV-\\d+$" }),
            },
            { additionalProperties: false },
        ),
        async execute(_id, params, _signal, _update, ctx) {
            if (activePhase !== "exploring")
                throw new Error(
                    `Exploring artifact is unavailable during ${activePhase ?? "inactive"} phase.`,
                );
            explorationLedger ??= createExplorationLedger({ runId });
            const blockers = explorationLedger.getGateBlockers({
                approachClaimIds: params.approaches.map(
                    (approach) => approach.claimIds,
                ),
                recommendationClaimIds: params.recommendationClaimIds,
                userChoice: params.userChoice,
                userChoiceEvidenceId: params.userChoiceEvidenceId,
            });
            if (blockers.length > 0) {
                const boundedBlockers = blockers.slice(0, 32);
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: [
                                "Exploring submission blocked:",
                                ...boundedBlockers.map(
                                    (blocker) => `- ${blocker}`,
                                ),
                            ].join("\n"),
                        },
                    ],
                    details: {
                        blocked: true as const,
                        blockers: boundedBlockers,
                    },
                };
            }
            const markdown =
                explorationLedger.renderExplorationMarkdown(params);
            return submitArtifact(
                "exploring",
                "brainstorm_submit_exploring",
                markdown,
                true,
                undefined,
                ctx,
            );
        },
    });

    const DesignSectionSchema = Type.Object(
        {
            title: Type.String({ minLength: 1 }),
            content: Type.String({ minLength: 1 }),
            feedback: Type.Optional(Type.String({ minLength: 1 })),
        },
        { additionalProperties: false },
    );
    pi.registerTool({
        name: "brainstorm_submit_presenting",
        label: "Submit Brainstorm Presentation",
        description:
            "Write the reviewed Presenting artifact for the active brainstorming run.",
        parameters: Type.Object(
            {
                sections: Type.Array(DesignSectionSchema, { minItems: 1 }),
                decisions: Type.Array(Type.String({ minLength: 1 })),
                approved: Type.Boolean(),
            },
            { additionalProperties: false },
        ),
        async execute(_id, params, _signal, _update, ctx) {
            const sections = markdownSections(params.sections);
            const markdown = [
                "# Presented Design",
                "",
                ...sections,
                "## Decisions",
                "",
                ...markdownList(params.decisions),
                "",
                `## Approval\n\n${params.approved ? "Approved" : "Not approved"}`,
            ].join("\n");
            return submitArtifact(
                "presenting",
                "brainstorm_submit_presenting",
                markdown,
                params.approved,
                params.approved
                    ? undefined
                    : "Presenting incomplete: final design approval is missing.",
                ctx,
            );
        },
    });

    const FinalSectionSchema = Type.Object(
        {
            title: Type.String({ minLength: 1 }),
            content: Type.String({ minLength: 1 }),
        },
        { additionalProperties: false },
    );
    pi.registerTool({
        name: "brainstorm_submit_design",
        label: "Submit Brainstorm Design",
        description:
            "Write the final design artifact. Do not include an implementation plan.",
        parameters: Type.Object(
            {
                title: Type.String({ minLength: 1 }),
                summary: Type.String({ minLength: 1 }),
                sections: Type.Array(FinalSectionSchema, { minItems: 1 }),
                decisions: Type.Array(Type.String({ minLength: 1 })),
                residualRisks: Type.Array(Type.String({ minLength: 1 })),
            },
            { additionalProperties: false },
        ),
        async execute(_id, params, _signal, _update, ctx) {
            const sections = markdownSections(params.sections);
            const markdown = [
                `# ${params.title}`,
                "",
                params.summary,
                "",
                ...sections,
                "## Decisions",
                "",
                ...markdownList(params.decisions),
                "",
                "## Residual Risks",
                "",
                ...markdownList(params.residualRisks),
            ].join("\n");
            return submitArtifact(
                "documenting",
                "brainstorm_submit_design",
                markdown,
                true,
                undefined,
                ctx,
            );
        },
    });

    pi.registerTool({
        name: "brainstorm_transition",
        label: "Transition Brainstorm Phase",
        description:
            "Request a user-approved move one phase forward or backward, or inspect current brainstorm status. No force or phase skipping.",
        parameters: Type.Object(
            { action: StringEnum(["next", "previous", "status"] as const) },
            { additionalProperties: false },
        ),
        async execute(_id, params, _signal, _update, ctx) {
            if (!activePhase) throw new Error("No active brainstorming run.");
            if (params.action === "status") return transitionResult(false);
            const blocker = adjacentTransitionBlocker(params.action);
            if (blocker) throw new Error(blocker);
            const targetPhase =
                params.action === "next"
                    ? nextPhase(activePhase)
                    : previousPhase(activePhase);
            const targetLabel = targetPhase
                ? PHASE_LABELS[targetPhase]
                : "Complete brainstorm";
            const choice = await requestTransitionDecision(
                params.action,
                targetLabel,
                ctx,
            );
            if (choice !== "Approve") {
                const customReason =
                    choice === "Reject with reason"
                        ? await ctx.ui.input(
                              "Why reject this transition? (optional)",
                          )
                        : undefined;
                return rejectTransition(
                    params.action,
                    customReason?.trim() || DEFAULT_REJECTION_REASON,
                    ctx,
                );
            }
            const outcome = applyAdjacentTransition(params.action, ctx);
            if (outcome.completed) {
                return {
                    content: [{ type: "text", text: outcome.message }],
                    details: { phase: null, completed: true, approved: true },
                };
            }
            return transitionResult(false, true);
        },
    });

    async function requestTransitionDecision(
        action: "next" | "previous",
        targetLabel: string,
        ctx: ExtensionContext,
    ): Promise<ReviewDecision> {
        if (!activePhase) throw new Error("No active brainstorming run.");
        const currentPhase = activePhase;
        const fallback = async (): Promise<ReviewDecision | undefined> => {
            const choice = await ctx.ui.select(
                `Approve brainstorm transition: ${PHASE_LABELS[currentPhase]} → ${targetLabel}?`,
                ["Approve", "Reject", "Reject with reason"],
            );
            return choice === "Approve" ||
                choice === "Reject" ||
                choice === "Reject with reason"
                ? choice
                : undefined;
        };
        if (ctx.mode !== "tui") return (await fallback()) ?? "Reject";

        const reviewPhase = artifacts[currentPhase]
            ? currentPhase
            : action === "previous"
              ? previousPhase(currentPhase)
              : undefined;
        const checkpoint = reviewPhase ? artifacts[reviewPhase] : undefined;
        if (!reviewPhase || !checkpoint) return (await fallback()) ?? "Reject";
        const revision = String(checkpoint.revision).padStart(3, "0");
        const decision = await openArtifactOverlay(
            checkpoint,
            `${PHASE_LABELS[reviewPhase]} r${revision} → ${targetLabel}`,
            ["Approve", "Reject", "Reject with reason"],
            "Reject",
            ctx,
        );
        return decision === "Close" || !decision ? "Reject" : decision;
    }

    async function openArtifactOverlay(
        checkpoint: ArtifactCheckpoint,
        title: string,
        actions: readonly ReviewAction[],
        escapeAction: ReviewAction,
        ctx: ExtensionContext,
    ): Promise<ReviewAction | undefined> {
        if (ctx.mode !== "tui") return undefined;
        const markdown = getArtifactStore(ctx).read(checkpoint.path);
        return ctx.ui.custom<ReviewAction>(
            (tui, theme, _keybindings, done) =>
                new ArtifactReviewView({
                    title,
                    subtitle: checkpoint.path,
                    body: new Markdown(markdown, 0, 0, getMarkdownTheme()),
                    actions,
                    escapeAction,
                    theme,
                    requestRender: () => tui.requestRender(),
                    done,
                }),
            {
                overlay: true,
                overlayOptions: {
                    width: "90%",
                    maxHeight: "80%",
                    margin: 2,
                },
            },
        );
    }

    function expectedSubmissionTool(phase: Phase): string {
        return PHASE_SUBMISSION_TOOLS[phase];
    }

    function artifactCompletionBlocker(phase: Phase): string | undefined {
        if (phase === "exploring" && pendingVerification)
            return `Exploring incomplete: verification run ${pendingVerification.runId} is pending.`;
        const checkpoint = artifacts[phase];
        if (!checkpoint)
            return `${PHASE_LABELS[phase]} incomplete: ${expectedSubmissionTool(phase)} has not submitted an artifact.`;
        return checkpoint.complete
            ? undefined
            : (checkpoint.blocker ?? `${PHASE_LABELS[phase]} incomplete.`);
    }

    function adjacentTransitionBlocker(
        action: "next" | "previous",
    ): string | undefined {
        if (!activePhase) return "No active brainstorming run.";
        if (action === "next") return artifactCompletionBlocker(activePhase);
        return previousPhase(activePhase)
            ? undefined
            : "Already at first phase.";
    }

    function applyAdjacentTransition(
        action: "next" | "previous",
        ctx: ExtensionContext,
    ) {
        const blocker = adjacentTransitionBlocker(action);
        if (blocker) throw new Error(blocker);
        if (!activePhase) throw new Error("No active brainstorming run.");
        if (action === "next") {
            const next = nextPhase(activePhase);
            if (!next) {
                const completedTopic = topic.raw;
                resetState();
                saveState(ctx);
                return {
                    phase: null,
                    completed: true,
                    message: `Brainstorm completed for: ${completedTopic}. No planning workflow was started.`,
                };
            }
            activePhase = next;
        } else {
            const previous = previousPhase(activePhase);
            if (!previous) throw new Error("Already at first phase.");
            activePhase = previous;
        }
        saveState(ctx);
        pi.sendMessage(
            {
                customType: "brainstorm-forcer-transition",
                content: `Brainstorm phase changed to ${PHASE_LABELS[activePhase]}. Use ${expectedSubmissionTool(activePhase)} and do not work on later phases.`,
                display: true,
            },
            { deliverAs: "steer" },
        );
        return {
            phase: activePhase,
            completed: false,
            message: `${action === "next" ? "Advanced" : "Returned"} to ${PHASE_LABELS[activePhase]} (${PHASES.indexOf(activePhase) + 1}/${PHASES.length}).`,
        };
    }

    function rejectTransition(
        action: "next" | "previous",
        reason: string,
        ctx: ExtensionContext,
    ) {
        if (!activePhase) throw new Error("No active brainstorming run.");
        const rejectedPhase = activePhase;
        const feedback =
            reason === DEFAULT_REJECTION_REASON
                ? reason
                : `${reason} ${DEFAULT_REJECTION_REASON}`;
        if (action === "next") {
            const checkpoint = artifacts[rejectedPhase];
            if (checkpoint)
                artifacts[rejectedPhase] = {
                    ...checkpoint,
                    complete: false,
                    blocker: feedback,
                };
            saveState(ctx);
        }
        pi.sendMessage(
            {
                customType: "brainstorm-forcer-transition-rejected",
                content: `Transition rejected by the user. Stay in ${PHASE_LABELS[rejectedPhase]}. ${feedback}`,
                display: true,
            },
            { deliverAs: "steer" },
        );
        return {
            content: [
                {
                    type: "text" as const,
                    text: `Transition rejected. ${feedback}`,
                },
            ],
            details: {
                phase: rejectedPhase,
                completed: false,
                approved: false,
                rejectionReason: reason,
                artifacts: structuredClone(artifacts),
            },
        };
    }

    function notifyAdjacentTransition(
        action: "next" | "previous",
        ctx: ExtensionContext,
    ): void {
        try {
            const outcome = applyAdjacentTransition(action, ctx);
            ctx.ui.notify(outcome.message, "info");
        } catch (error) {
            ctx.ui.notify(
                error instanceof Error ? error.message : String(error),
                "warning",
            );
        }
    }

    function transitionResult(completed: boolean, approved?: boolean) {
        return {
            content: [
                {
                    type: "text" as const,
                    text: activePhase
                        ? [
                              `Current brainstorm phase: ${PHASE_LABELS[activePhase]}.`,
                              ...(activePhase === "exploring"
                                  ? explorationStatusLines()
                                  : []),
                          ].join("\n")
                        : "Brainstorm completed.",
                },
            ],
            details: {
                phase: activePhase,
                completed,
                artifacts: structuredClone(artifacts),
                pendingVerification: structuredClone(pendingVerification),
                ...(activePhase === "exploring"
                    ? {
                          exploringStatus: structuredClone(
                              explorationStatusSnapshot(),
                          ),
                      }
                    : {}),
                ...(approved === undefined ? {} : { approved }),
            },
        };
    }

    function submitArtifact(
        phase: Phase,
        tool: string,
        markdown: string,
        complete: boolean,
        blocker: string | undefined,
        ctx: ExtensionContext,
    ) {
        if (activePhase !== phase)
            throw new Error(
                `${PHASE_LABELS[phase]} artifact is unavailable during ${activePhase ?? "inactive"} phase.`,
            );
        const artifact = getArtifactStore(ctx).submit({
            phase,
            markdown,
            tool,
        });
        const phaseIndex = PHASES.indexOf(phase);
        for (const downstream of PHASES.slice(phaseIndex))
            delete artifacts[downstream];
        artifacts[phase] = {
            path: artifact.path,
            revision: artifact.revision,
            complete,
            ...(blocker ? { blocker } : {}),
        };
        saveState(ctx);
        return {
            content: [
                {
                    type: "text" as const,
                    text: `${PHASE_LABELS[phase]} artifact saved: ${artifact.path} (revision ${artifact.revision}).`,
                },
            ],
            details: { artifact },
        };
    }

    function getArtifactStore(ctx: ExtensionContext) {
        if (!runId || !activePhase)
            throw new Error("No active brainstorming run.");
        const persistedDate =
            typeof startedAt === "string"
                ? startedAt.match(/^\d{4}-\d{2}-\d{2}/)?.[0]
                : undefined;
        const artifactDate = Object.values(artifacts)[0]?.path.match(
            /docs\/brainstorms\/(\d{4}-\d{2}-\d{2})-/,
        )?.[1];
        artifactStore ??= createBrainstormArtifactStore({
            projectRoot: ctx.cwd,
            runId,
            topic: topic.raw,
            date: persistedDate ?? artifactDate,
        });
        return artifactStore;
    }

    function refreshGroups() {
        groups = buildToolGroups(pi);
    }

    function expectedOutcomeForVerdict(
        verdict: "verified" | "falsified" | "unresolved",
    ): VerificationOutcome {
        return verdict === "verified"
            ? "supported"
            : verdict === "falsified"
              ? "rejected"
              : "unresolved";
    }

    function buildVerificationSelection(claimIds: readonly string[]) {
        if (pendingVerification)
            throw new Error(
                `Verification run ${pendingVerification.runId} is already pending.`,
            );
        explorationLedger ??= createExplorationLedger({ runId });
        const activeClaims = explorationLedger.getActiveClaims();
        const records = explorationLedger.getRecords();
        const evidenceById = new Map(
            records.flatMap((record) =>
                record.kind === "evidence"
                    ? [[record.id, record] as const]
                    : [],
            ),
        );
        const claims = claimIds.map((claimId): VerificationClaim => {
            const claim = activeClaims.find(
                (candidate) => candidate.id === claimId,
            );
            if (!claim) throw new Error(`Unknown active claim: ${claimId}.`);
            if (
                claim.verificationDomain === undefined ||
                claim.architectureImpact === undefined
            )
                throw new Error(
                    `Claim ${claim.id} lacks required verification routing metadata. Use brainstorm_record_claim with supersedesClaimId, verificationDomain, and architectureImpact before verification.`,
                );
            const evidence: EvidenceDescriptor[] = claim.evidenceIds.map(
                (evidenceId) => {
                    const record = evidenceById.get(evidenceId);
                    if (!record)
                        throw new Error(
                            `Claim ${claim.id} references unknown evidence ${evidenceId}.`,
                        );
                    return {
                        id: record.id,
                        sourceRefs: [...record.sourceRefs],
                    };
                },
            );
            return {
                id: claim.id,
                assertion: claim.assertion,
                domain: claim.verificationDomain,
                expectedOutcome: expectedOutcomeForVerdict(claim.verdict),
                evidence,
            };
        });
        const groups = groupVerificationClaims(claims);
        const architectureClaims = activeClaims.filter(
            (claim) =>
                claimIds.includes(claim.id) &&
                claim.architectureImpact === true,
        );
        const architectureScope = {
            claimIds: architectureClaims.map((claim) => claim.id),
            evidenceIds: [
                ...new Set(
                    architectureClaims.flatMap((claim) => claim.evidenceIds),
                ),
            ].toSorted(),
        };
        const plan = buildVerificationPlan({
            runId,
            claims,
            architectureImpact: architectureClaims.length > 0,
            ...(architectureClaims.length > 0 ? { architectureScope } : {}),
        });
        const verifierNodes = plan.nodes.filter(
            (node) => node.role === "verifier",
        );
        if (verifierNodes.length !== groups.length)
            throw new Error(
                "Deterministic verification plan does not match its groups.",
            );
        const expectedSteps: PendingVerificationStep[] = groups.map(
            (group, index) => {
                const step = verifierNodes[index];
                if (!step || step.agent !== group.agent)
                    throw new Error(
                        "Deterministic verifier agent does not match its group.",
                    );
                return {
                    role: "verifier",
                    outputName: step.outputName,
                    agent: group.agent,
                    domain: group.domain,
                    outcome: group.outcome,
                    claimIds: [...group.claimIds],
                    evidenceIds: [...group.evidenceIds],
                };
            },
        );
        if (architectureClaims.length > 0) {
            const architectStep = plan.nodes.find(
                (node) => node.role === "architect",
            );
            if (!architectStep || architectStep.agent !== ARCHITECT_AGENT)
                throw new Error(
                    "Deterministic verification plan lacks its architect node.",
                );
            expectedSteps.push({
                role: "architect",
                outputName: architectStep.outputName,
                agent: ARCHITECT_AGENT,
                claimIds: architectureScope.claimIds,
                evidenceIds: architectureScope.evidenceIds,
            });
        }
        return {
            nodes: [...plan.nodes] as VerificationDelegationNode[],
            expectedSteps,
        };
    }

    async function launchVerification(
        claimIds: readonly string[],
        ctx: ExtensionContext,
    ): Promise<PendingVerificationRun> {
        const sessionId = ctx.sessionManager.getSessionId();
        const sessionFile = ctx.sessionManager.getSessionFile();
        const branchLeafId = ctx.sessionManager.getLeafId();
        const brainstormRunId = runId;
        if (!sessionId || !sessionFile || !isAbsolute(sessionFile))
            throw new Error(
                "Verification requires an active persisted Pi session.",
            );
        const ownsLaunch = () =>
            activeContext === ctx &&
            activePhase === "exploring" &&
            runId === brainstormRunId &&
            ctx.sessionManager.getSessionId() === sessionId &&
            ctx.sessionManager.getSessionFile() === sessionFile &&
            ctx.sessionManager.getLeafId() === branchLeafId &&
            pendingVerification === null;
        const assertLaunchOwnership = () => {
            if (!ownsLaunch())
                throw new Error(
                    "Verification launch ownership changed before persistence.",
                );
        };
        assertLaunchOwnership();
        const capabilityCeiling =
            resolveCurrentSubagentCapabilityCeiling(sessionId);
        if (!capabilityCeiling)
            throw new Error(
                "Verifier capability ceiling is not active for this session.",
            );
        const { nodes, expectedSteps } = buildVerificationSelection(claimIds);
        const expectedAgents = [
            ...new Set(expectedSteps.map((step) => step.agent)),
        ];
        const preflight = await runPreflight(
            sessionId,
            ctx.cwd,
            expectedAgents,
        );
        assertLaunchOwnership();
        const returnedAgents = preflight.map((result) => result.agent);
        if (
            returnedAgents.length !== expectedAgents.length ||
            new Set(returnedAgents).size !== returnedAgents.length ||
            returnedAgents.some(
                (agent, index) => agent !== expectedAgents[index],
            )
        )
            throw new Error(
                "Verifier preflight did not return the exact selected agent sequence.",
            );
        const failed = preflight.filter((result) => !result.ok);
        if (failed.length > 0)
            throw new Error(
                `Verifier preflight failed: ${failed.map((result) => `${result.agent}: ${result.message ?? "unavailable"}`).join("; ")}.`,
            );
        launchInProgress = true;
        earlyCompletionEvents.length = 0;
        const pendingBeforeLaunch = pendingVerification;
        let receipt: { runId: string } | undefined;
        try {
            receipt = verificationCoordinator.start({
                ownerRunId: brainstormRunId,
                sessionId,
                sessionFile,
                cwd: ctx.cwd,
                label: `Brainstorm verification (${claimIds.length} claim${claimIds.length === 1 ? "" : "s"})`,
                nodes,
            });
            if (!ownsLaunch()) {
                verificationCoordinator.stop(receipt.runId);
                assertLaunchOwnership();
            }
            const pending: PendingVerificationRun = {
                runId: receipt.runId,
                ownerSessionId: sessionId,
                ownerSessionFile: sessionFile,
                brainstormRunId,
                claimIds: [...claimIds],
                startedAt: new Date().toISOString(),
                expectedSteps,
            };
            if (!isPendingVerificationRun(pending))
                throw new Error(
                    "Structured delegation returned invalid verification ownership metadata.",
                );
            pendingVerification = pending;
            saveState(ctx);
            const early = earlyCompletionEvents.splice(0);
            for (const completion of early)
                await handleAsyncCompletion(completion);
            return pending;
        } catch (error) {
            if (receipt) verificationCoordinator.stop(receipt.runId);
            pendingVerification = pendingBeforeLaunch;
            throw error;
        } finally {
            launchInProgress = false;
            earlyCompletionEvents.length = 0;
        }
    }

    function pendingVerifierGroups(
        pending: PendingVerificationRun,
    ): Array<Extract<PendingVerificationStep, { role: "verifier" }>> {
        return pending.expectedSteps.filter(
            (
                step,
            ): step is Extract<PendingVerificationStep, { role: "verifier" }> =>
                step.role === "verifier",
        );
    }

    function auditVerificationFailure(
        pending: PendingVerificationRun,
        failureKind: "failed" | "malformed" | "timeout",
        reason: string,
        ctx: ExtensionContext,
    ): void {
        try {
            persistTerminalVerificationCommit(
                pending,
                terminalVerificationFailureRecords({
                    verificationRunId: pending.runId,
                    failureKind,
                    reason,
                    groups: pendingVerifierGroups(pending).map((step) => ({
                        agent: step.agent,
                        outputName: step.outputName,
                        claimIds: [...step.claimIds],
                        evidenceIds: [...step.evidenceIds],
                    })),
                }),
                ctx,
            );
            ctx.ui.notify(
                boundedVerificationWarning(
                    `Verification ${boundedSingleLine(pending.runId, 96)} ${failureKind}: ${boundedSingleLine(reason, 500) || "unknown verification failure"}`,
                ),
                "warning",
            );
        } catch (error) {
            const persistenceError = boundedSingleLine(
                error instanceof Error ? error.message : String(error),
                500,
            );
            const warning = boundedVerificationWarning(
                `Verification ${boundedSingleLine(pending.runId, 96)} ${failureKind} audit remains durably pending recovery: ${persistenceError || "unknown persistence error"}.`,
            );
            try {
                ctx.ui.notify(warning, "warning");
            } catch {
                try {
                    process.stderr.write(`brainstorm-forcer: ${warning}\n`);
                } catch {
                    return;
                }
            }
        }
    }

    function verificationGroupFromPending(
        step: Extract<PendingVerificationStep, { role: "verifier" }>,
    ): VerificationGroup {
        const activeClaims = explorationLedger?.getActiveClaims() ?? [];
        const records = explorationLedger?.getRecords() ?? [];
        return {
            domain: step.domain,
            outcome: step.outcome,
            agent: step.agent,
            claimIds: [...step.claimIds],
            assertions: step.claimIds.map(
                (claimId) =>
                    activeClaims.find((claim) => claim.id === claimId)
                        ?.assertion ?? "",
            ),
            evidence: step.evidenceIds.map((evidenceId) => {
                const evidence = records.find(
                    (record) =>
                        record.kind === "evidence" && record.id === evidenceId,
                );
                return {
                    id: evidenceId,
                    sourceRefs:
                        evidence?.kind === "evidence"
                            ? [...evidence.sourceRefs]
                            : [],
                };
            }),
            evidenceIds: [...step.evidenceIds],
        };
    }

    function stageTerminalVerificationRecords(
        recordTerminal: (
            ledger: ReturnType<typeof createExplorationLedger>,
        ) => ExplorationRecord[],
    ): {
        stagedLedger: ReturnType<typeof createExplorationLedger>;
        records: ExplorationRecord[];
    } {
        explorationLedger ??= createExplorationLedger({ runId });
        const stagedLedger = createExplorationLedger({
            runId,
            initialRecords: explorationLedger.getRecords(),
        });
        return {
            stagedLedger,
            records: recordTerminal(stagedLedger),
        };
    }

    function terminalVerificationRecords(
        input: RecordVerificationCompletionInput,
    ) {
        return stageTerminalVerificationRecords((stagedLedger) => {
            const completion = stagedLedger.recordVerificationCompletion(input);
            return [
                ...(completion.architectEvidence
                    ? [completion.architectEvidence]
                    : []),
                ...completion.verifierEvidence,
                ...completion.reviews,
            ];
        });
    }

    function terminalVerificationFailureRecords(
        input: RecordVerificationFailureInput,
    ) {
        return stageTerminalVerificationRecords((stagedLedger) =>
            stagedLedger.recordVerificationFailure(input),
        );
    }

    function latestTerminalVerificationCommit(
        ctx: ExtensionContext,
        verificationRunId: string,
    ): TerminalVerificationCommit | undefined {
        for (const entry of ctx.sessionManager.getBranch().toReversed()) {
            if (
                entry.type === "custom" &&
                entry.customType === TERMINAL_COMMIT_SESSION_KEY &&
                isTerminalVerificationCommit(
                    entry.data,
                    runId,
                    verificationRunId,
                )
            )
                return entry.data;
        }
        return undefined;
    }

    function markExploringArtifactStale(): void {
        const checkpoint = artifacts.exploring;
        if (!checkpoint) return;
        artifacts.exploring = {
            ...checkpoint,
            complete: false,
            blocker:
                "Exploring incomplete: ledger changed after the latest Exploring artifact; submit a new revision.",
        };
        delete artifacts.presenting;
        delete artifacts.documenting;
    }

    function persistTerminalVerificationCommit(
        pending: PendingVerificationRun,
        staged: ReturnType<typeof stageTerminalVerificationRecords>,
        ctx: ExtensionContext,
    ): void {
        const previousLedger = explorationLedger;
        const previousArtifacts = structuredClone(artifacts);
        const previousPending = pendingVerification;
        const previousLastTerminalRunId = lastTerminalRunId;
        const { stagedLedger, records } = staged;
        const commit: TerminalVerificationCommit = {
            runId,
            verificationRunId: pending.runId,
            records,
        };

        pi.appendEntry(TERMINAL_COMMIT_SESSION_KEY, commit);
        const persistedIds = new Set(
            restoredLedgerRecords(ctx, runId).map((record) => record.id),
        );
        for (const record of records) {
            if (!persistedIds.has(record.id))
                pi.appendEntry(LEDGER_SESSION_KEY, { runId, record });
        }

        explorationLedger = stagedLedger;
        markExploringArtifactStale();
        lastTerminalRunId = pending.runId;
        pendingVerification = null;
        try {
            saveState(ctx);
        } catch (error) {
            explorationLedger = previousLedger;
            artifacts = previousArtifacts;
            pendingVerification = previousPending;
            lastTerminalRunId = previousLastTerminalRunId;
            throw error;
        }
    }

    function recoverTerminalVerificationCommit(
        pending: PendingVerificationRun,
        ctx: ExtensionContext,
    ): "absent" | "recovered" | "failed" {
        const commit = latestTerminalVerificationCommit(ctx, pending.runId);
        if (!commit) return "absent";
        const previousLedger = explorationLedger;
        const previousArtifacts = structuredClone(artifacts);
        const previousPending = pendingVerification;
        const previousLastTerminalRunId = lastTerminalRunId;
        try {
            const persistedRecords = restoredLedgerRecords(ctx, runId);
            const persistedIds = new Set(
                persistedRecords.map((record) => record.id),
            );
            for (const record of commit.records) {
                if (!persistedIds.has(record.id))
                    pi.appendEntry(LEDGER_SESSION_KEY, { runId, record });
            }
            explorationLedger = createExplorationLedger({
                runId,
                initialRecords: restoredLedgerRecords(ctx, runId),
            });
            markExploringArtifactStale();
            lastTerminalRunId = pending.runId;
            pendingVerification = null;
            saveState(ctx);
            return "recovered";
        } catch (error) {
            explorationLedger = previousLedger;
            artifacts = previousArtifacts;
            pendingVerification = previousPending;
            lastTerminalRunId = previousLastTerminalRunId;
            const reason = boundedSingleLine(
                error instanceof Error ? error.message : String(error),
                500,
            );
            ctx.ui.notify(
                boundedVerificationWarning(
                    `Verification ${boundedSingleLine(pending.runId, 96)} terminal recovery remains pending: ${reason || "unknown persistence error"}.`,
                ),
                "warning",
            );
            return "failed";
        }
    }

    async function processOwnedTerminal(
        pending: PendingVerificationRun,
        terminal: Exclude<OwnedTerminalCompletion, { kind: "unrelated" }>,
        ctx: ExtensionContext,
    ): Promise<void> {
        if (processingRunIds.has(pending.runId)) return;
        processingRunIds.add(pending.runId);
        try {
            if (terminal.kind === "failure") {
                const verifierSteps = pendingVerifierGroups(pending);
                const architectStep = pending.expectedSteps.find(
                    (step) => step.role === "architect",
                );
                const completedOutputs = terminal.completedStructuredOutputs;
                if (
                    terminal.failureKind === "failed" &&
                    architectStep &&
                    terminal.failedAdvisoryOutputName ===
                        architectStep.outputName &&
                    completedOutputs &&
                    verifierSteps.every(
                        (step) =>
                            completedOutputs[step.outputName] !== undefined,
                    )
                ) {
                    const verifierOutputs = verifierSteps.map((step) => ({
                        step,
                        output: completedOutputs[step.outputName],
                        validation: verifyVerifierCompletion(
                            verificationGroupFromPending(step),
                            completedOutputs[step.outputName],
                        ),
                    }));
                    if (verifierOutputs.every((item) => item.validation.ok)) {
                        try {
                            persistTerminalVerificationCommit(
                                pending,
                                terminalVerificationRecords({
                                    verificationRunId: pending.runId,
                                    verifiers: verifierOutputs.map(
                                        ({ step, output }) => {
                                            const structured = output as {
                                                outcome: VerificationOutcome;
                                                claimIds: string[];
                                                evidenceIds: string[];
                                                summary: string;
                                            };
                                            return {
                                                agent: step.agent,
                                                outputName: step.outputName,
                                                outcome: structured.outcome,
                                                claimIds: [
                                                    ...structured.claimIds,
                                                ],
                                                evidenceIds: [
                                                    ...structured.evidenceIds,
                                                ],
                                                summary: structured.summary,
                                            };
                                        },
                                    ),
                                    advisoryFailure: {
                                        claimIds: [...architectStep.claimIds],
                                        evidenceIds: [
                                            ...architectStep.evidenceIds,
                                        ],
                                        reason: terminal.reason,
                                    },
                                }),
                                ctx,
                            );
                        } catch (error) {
                            ctx.ui.notify(
                                boundedVerificationWarning(
                                    `Verification ${boundedSingleLine(pending.runId, 96)} completion is durably pending recovery: ${boundedSingleLine(error instanceof Error ? error.message : String(error), 500) || "unknown persistence error"}.`,
                                ),
                                "warning",
                            );
                            return;
                        }
                        ctx.ui.notify(
                            boundedVerificationWarning(
                                `Verification ${pending.runId} completed; verifier outputs were audited successfully, while the architect advisory failed: ${terminal.reason}`,
                            ),
                            "warning",
                        );
                        return;
                    }
                }
                auditVerificationFailure(
                    pending,
                    terminal.failureKind,
                    terminal.reason,
                    ctx,
                );
                return;
            }
            const verifierOutputs: Array<{
                agent: string;
                outputName: string;
                outcome: VerificationOutcome;
                claimIds: string[];
                evidenceIds: string[];
                summary: string;
            }> = [];
            let architectOutput:
                | {
                      agent: "architect";
                      outputName: string;
                      status: "clear" | "watch" | "block";
                      claimIds: string[];
                      evidenceIds: string[];
                      risks: string[];
                      summary: string;
                  }
                | undefined;
            for (const step of pending.expectedSteps) {
                const output = terminal.structuredOutputs[step.outputName];
                if (step.role === "verifier") {
                    const validated = verifyVerifierCompletion(
                        verificationGroupFromPending(step),
                        output,
                    );
                    if (!validated.ok) {
                        auditVerificationFailure(
                            pending,
                            "malformed",
                            validated.blockers.join(" "),
                            ctx,
                        );
                        return;
                    }
                    const structured = output as {
                        outcome: VerificationOutcome;
                        claimIds: string[];
                        evidenceIds: string[];
                        summary: string;
                    };
                    verifierOutputs.push({
                        agent: step.agent,
                        outputName: step.outputName,
                        outcome: structured.outcome,
                        claimIds: [...structured.claimIds],
                        evidenceIds: [...structured.evidenceIds],
                        summary: structured.summary,
                    });
                    continue;
                }
                const validated = verifyArchitectCompletion(output, {
                    claimIds: step.claimIds,
                    evidenceIds: step.evidenceIds,
                });
                if (!validated.ok) {
                    auditVerificationFailure(
                        pending,
                        "malformed",
                        validated.blockers.join(" "),
                        ctx,
                    );
                    return;
                }
                const structured = output as {
                    status: "clear" | "watch" | "block";
                    claimIds: string[];
                    evidenceIds: string[];
                    risks: string[];
                    summary: string;
                };
                architectOutput = {
                    agent: "architect",
                    outputName: step.outputName,
                    status: structured.status,
                    claimIds: [...structured.claimIds],
                    evidenceIds: [...structured.evidenceIds],
                    risks: [...structured.risks],
                    summary: structured.summary,
                };
            }

            try {
                persistTerminalVerificationCommit(
                    pending,
                    terminalVerificationRecords({
                        verificationRunId: pending.runId,
                        verifiers: verifierOutputs,
                        ...(architectOutput
                            ? { architect: architectOutput }
                            : {}),
                    }),
                    ctx,
                );
            } catch (error) {
                ctx.ui.notify(
                    boundedVerificationWarning(
                        `Verification ${boundedSingleLine(pending.runId, 96)} completion is durably pending recovery: ${boundedSingleLine(error instanceof Error ? error.message : String(error), 500) || "unknown persistence error"}.`,
                    ),
                    "warning",
                );
                return;
            }
            ctx.ui.notify(
                `Verification ${pending.runId} completed and audited.`,
                architectOutput?.status === "block" ? "warning" : "info",
            );
        } finally {
            processingRunIds.delete(pending.runId);
        }
    }

    async function handleAsyncCompletion(
        raw: VerificationCoordinatorCompletion,
    ): Promise<void> {
        if (launchInProgress && !pendingVerification) {
            if (earlyCompletionEvents.length < 8)
                earlyCompletionEvents.push(raw);
            return;
        }
        const pending = pendingVerification;
        const ctx = activeContext;
        if (!pending || !ctx) return;
        if (raw.runId !== pending.runId) return;
        await processOwnedTerminal(pending, raw.terminal, ctx);
    }

    function resetState() {
        activePhase = null;
        topic = { raw: "", display: "" };
        evidence = EMPTY_EVIDENCE();
        runId = "";
        startedAt = "";
        artifactStore = null;
        artifacts = {};
        explorationLedger = null;
        pendingVerification = null;
        terminalRecoveryBlockedRunId = null;
        lastTerminalRunId = null;
        processingRunIds.clear();
        earlyCompletionEvents.length = 0;
        ceilingManager.dispose();
        refreshGroups();
    }

    function nextPhase(phase: Phase): Phase | null {
        const idx = PHASES.indexOf(phase) + 1;
        return idx < PHASES.length ? PHASES[idx] : null;
    }

    function previousPhase(phase: Phase): Phase | null {
        const idx = PHASES.indexOf(phase) - 1;
        return idx >= 0 ? PHASES[idx] : null;
    }

    function findPhase(text: string): Phase | null {
        const lower = text.trim().toLowerCase();
        const byName = PHASES.find(
            (p) =>
                p === lower ||
                PHASE_LABELS[p].toLowerCase() === lower ||
                p.startsWith(lower),
        );
        if (byName) return byName;
        const n = Number(lower);
        if (Number.isInteger(n) && n >= 1 && n <= PHASES.length)
            return PHASES[n - 1];
        return null;
    }

    function explorationStatusSnapshot() {
        const ledger = explorationLedger?.getStatusSnapshot();
        if (!ledger) return null;
        const questionTool = pendingVerification
            ? "blockedPending"
            : "available";
        const nextAction = pendingVerification
            ? "waitVerification"
            : ledger.routingMetadataRequiredClaimIds.length > 0
              ? "supersedeClaims"
              : ledger.waiverRequiredClaimIds.length > 0
                ? "requestWaiver"
                : ledger.missingSuccessfulReviewClaimIds.length > 0 ||
                    ledger.architectureBlockedClaimIds.length > 0
                  ? "runVerification"
                  : ledger.finalChoice === "recorded"
                    ? "submitExploring"
                    : "askDedicatedChoice";
        return {
            ...ledger,
            pendingRunId: pendingVerification?.runId ?? null,
            questionTool,
            nextAction,
        } as const;
    }

    function explorationStatusLines(): string[] {
        const status = explorationStatusSnapshot();
        if (!status) return [];
        return [
            `Exploring ledger: EV=${status.evidenceTotal} | claims=${status.claims.active} active/${status.claims.historical} historical | reviews=${status.reviews.success} successful/${status.reviews.total} total (failed=${status.reviews.failed} malformed=${status.reviews.malformed} timeout=${status.reviews.timeout})`,
            `Active unresolved critical claims: ${status.unresolvedCriticalClaimIds.join(", ") || "none"}`,
            `Routing metadata supersession required: ${status.routingMetadataRequiredClaimIds.join(", ") || "none"}`,
            `Required successful reviews missing: ${status.missingSuccessfulReviewClaimIds.join(", ") || "none"}`,
            `Required waivers missing: ${status.waiverRequiredClaimIds.join(", ") || "none"}`,
            `Verification: ${status.pendingRunId ? `pending ${status.pendingRunId}` : "none pending"}`,
            `Question tool: ${status.questionTool}`,
            `Final choice: ${status.finalChoice}`,
            `Next action: ${status.nextAction}`,
            ...(status.nextAction === "supersedeClaims"
                ? [
                      "Recovery: call brainstorm_record_claim with supersedesClaimId for each listed claim, including verificationDomain and architectureImpact, before brainstorm_run_verification.",
                  ]
                : []),
        ];
    }

    function updateWidget(ctx: ExtensionContext): void {
        if (!ctx.hasUI) return;
        const colors = createUiColors(ctx.ui.theme);
        if (!activePhase) {
            widgetText = null;
            widget?.update(ctx, null);
            return;
        }
        const idx = PHASES.indexOf(activePhase) + 1;
        const research = evidence.researchCalls;
        const questions = evidence.questionCalls;
        const exploringStatus = explorationStatusSnapshot();
        const metrics =
            activePhase === "exploring" && exploringStatus
                ? `ev:${exploringStatus.evidenceTotal} review:${exploringStatus.satisfiedReviewClaimIds.length}/${exploringStatus.requiredReviewClaimIds.length} action:${exploringStatus.nextAction}`
                : `r:${research} q:${questions}`;
        widgetText = [
            colors.primary(
                `${PHASE_ICONS[activePhase]} ${PHASE_LABELS[activePhase]}`,
            ),
            colors.separator(" • "),
            colors.meta(`p${idx}/${PHASES.length}`),
            colors.separator(" • "),
            colors.text(topic.display),
            colors.separator(" • "),
            colors.meta(metrics),
        ].join("");
        widget?.update(ctx, widgetText);
    }

    function stateSnapshot() {
        if (!activePhase) return { active: false as const };
        return {
            active: true as const,
            phase: activePhase,
            topic,
            evidence,
            runId,
            startedAt,
            artifacts,
            pendingVerification,
            lastTerminalRunId,
        };
    }

    function saveState(ctx: ExtensionContext): void {
        pi.appendEntry(SESSION_KEY, stateSnapshot());
        updateWidget(ctx);
    }

    function appendExplorationRecord(
        record: ExplorationRecord,
        ctx: ExtensionContext,
    ): void {
        pi.appendEntry(LEDGER_SESSION_KEY, { runId, record });
        if (!artifacts.exploring) {
            updateWidget(ctx);
            return;
        }
        markExploringArtifactStale();
        saveState(ctx);
    }

    function latestSessionData(ctx: ExtensionContext) {
        const entries = ctx.sessionManager.getBranch();
        for (let i = entries.length - 1; i >= 0; i--) {
            const entry = entries[i];
            if (entry.type === "custom" && entry.customType === SESSION_KEY)
                return entry.data;
        }
        return undefined;
    }

    function restoredLedgerRecords(
        ctx: ExtensionContext,
        currentRunId: string,
    ): ExplorationRecord[] {
        return ctx.sessionManager.getBranch().flatMap((entry) => {
            if (
                entry.type !== "custom" ||
                entry.customType !== LEDGER_SESSION_KEY
            )
                return [];
            if (
                !entry.data ||
                typeof entry.data !== "object" ||
                Array.isArray(entry.data)
            )
                return [];
            const data = Object.fromEntries(Object.entries(entry.data));
            return data.runId === currentRunId &&
                isExplorationRecord(data.record) &&
                data.record.runId === currentRunId
                ? [data.record]
                : [];
        });
    }

    function missingPendingVerificationReferences(
        pending: PendingVerificationRun,
    ): { claimIds: string[]; evidenceIds: string[] } {
        const records = explorationLedger?.getRecords() ?? [];
        const claimIds = new Set(
            records
                .filter((record) => record.kind === "claim")
                .map((record) => record.id),
        );
        const evidenceIds = new Set(
            records
                .filter((record) => record.kind === "evidence")
                .map((record) => record.id),
        );
        return {
            claimIds: [
                ...new Set([
                    ...pending.claimIds,
                    ...pending.expectedSteps.flatMap((step) => step.claimIds),
                ]),
            ].filter((id) => !claimIds.has(id)),
            evidenceIds: [
                ...new Set(
                    pending.expectedSteps.flatMap((step) => step.evidenceIds),
                ),
            ].filter((id) => !evidenceIds.has(id)),
        };
    }

    function restoreState(ctx: ExtensionContext): void {
        resetState();
        const data = latestSessionData(ctx) as
            | {
                  active?: boolean;
                  phase?: string;
                  topic?: TopicState | string;
                  evidence?: Evidence;
                  runId?: string;
                  startedAt?: string;
                  artifacts?: ArtifactCheckpoints;
                  pendingVerification?: unknown;
                  lastTerminalRunId?: string | null;
              }
            | undefined;
        if (!data || data.active === false) return;
        if (data.phase && (PHASES as readonly string[]).includes(data.phase)) {
            activePhase = data.phase as Phase;
            const restoredTopic = data.topic;
            topic =
                typeof restoredTopic === "string"
                    ? {
                          raw: restoredTopic,
                          display: summarizeTopicForUi(restoredTopic),
                      }
                    : (restoredTopic ?? { raw: "", display: "" });
            evidence = data.evidence ?? EMPTY_EVIDENCE();
            runId = data.runId ?? `brainstorm-${randomUUID()}`;
            startedAt = data.startedAt ?? new Date().toISOString();
            artifacts = data.artifacts ?? {};
            artifactStore = null;
            explorationLedger = createExplorationLedger({
                runId,
                initialRecords: restoredLedgerRecords(ctx, runId),
            });
            const restoredPending = data.pendingVerification;
            pendingVerification =
                isPendingVerificationRun(restoredPending) &&
                restoredPending.brainstormRunId === runId &&
                restoredPending.ownerSessionId ===
                    ctx.sessionManager.getSessionId() &&
                restoredPending.ownerSessionFile ===
                    ctx.sessionManager.getSessionFile()
                    ? restoredPending
                    : null;
            if (
                restoredPending !== undefined &&
                restoredPending !== null &&
                !pendingVerification
            ) {
                const restoredRunId =
                    typeof restoredPending === "object" &&
                    !Array.isArray(restoredPending) &&
                    typeof (restoredPending as { runId?: unknown }).runId ===
                        "string"
                        ? (restoredPending as { runId: string }).runId
                        : "unknown";
                saveState(ctx);
                ctx.ui.notify(
                    boundedVerificationWarning(
                        `Restored verification ${boundedSingleLine(restoredRunId, 96)} quarantined: ownership metadata does not exactly match the active session UUID and session file. Pending cleared without ledger audit.`,
                    ),
                    "warning",
                );
            }
            if (
                typeof data.lastTerminalRunId === "string" ||
                data.lastTerminalRunId === null
            )
                lastTerminalRunId = data.lastTerminalRunId;
            terminalRecoveryBlockedRunId = null;
            if (pendingVerification) {
                const recovery = recoverTerminalVerificationCommit(
                    pendingVerification,
                    ctx,
                );
                if (recovery === "failed")
                    terminalRecoveryBlockedRunId = pendingVerification.runId;
            }
            if (pendingVerification) {
                const missing =
                    missingPendingVerificationReferences(pendingVerification);
                if (
                    missing.claimIds.length > 0 ||
                    missing.evidenceIds.length > 0
                ) {
                    const pendingRunId = pendingVerification.runId;
                    const reasons = [
                        ...(missing.claimIds.length > 0
                            ? [
                                  `${summarizeIds(missing.claimIds)} ${missing.claimIds.length === 1 ? "is" : "are"} absent from the active branch claim history`,
                              ]
                            : []),
                        ...(missing.evidenceIds.length > 0
                            ? [
                                  `${summarizeIds(missing.evidenceIds)} ${missing.evidenceIds.length === 1 ? "is" : "are"} absent from the active branch evidence history`,
                              ]
                            : []),
                    ];
                    pendingVerification = null;
                    saveState(ctx);
                    ctx.ui.notify(
                        boundedVerificationWarning(
                            `Restored verification ${boundedSingleLine(pendingRunId, 96)} quarantined: ${reasons.join("; ")}. Pending cleared without ledger audit.`,
                        ),
                        "warning",
                    );
                }
            }
            ceilingManager.register(ctx.sessionManager.getSessionId() ?? "");
        }
    }

    async function reconcilePendingVerification(
        ctx: ExtensionContext,
    ): Promise<void> {
        const pending = pendingVerification;
        if (!pending) return;
        const stillOwnsPending = () =>
            pendingVerification === pending && activeContext === ctx;
        if (!stillOwnsPending()) return;
        if (terminalRecoveryBlockedRunId === pending.runId) return;
        auditVerificationFailure(
            pending,
            "failed",
            "Verification was interrupted by an extension reload; foreground delegation attempts are not recoverable across extension contexts.",
            ctx,
        );
    }

    function startPhase(
        topicText: string,
        ctx: ExtensionContext,
        immediate: boolean,
    ): void {
        activeContext = ctx;
        activePhase = "discovery";
        topic = { raw: topicText, display: summarizeTopicForUi(topicText) };
        evidence = EMPTY_EVIDENCE();
        runId = `brainstorm-${randomUUID()}`;
        startedAt = new Date().toISOString();
        artifactStore = null;
        artifacts = {};
        explorationLedger = createExplorationLedger({ runId });
        ceilingManager.register(ctx.sessionManager.getSessionId() ?? "");
        refreshGroups();
        saveState(ctx);
        ctx.ui.notify(
            `Brainstorm ${immediate ? "started" : "armed"}: Discovery (1/${PHASES.length})`,
            "info",
        );
        if (immediate) {
            if (ctx.isIdle()) {
                pi.sendUserMessage(topic.raw);
            } else {
                pi.sendUserMessage(topic.raw, { deliverAs: "followUp" });
                ctx.ui.notify(
                    "Queued brainstorm topic as follow-up turn.",
                    "info",
                );
            }
        }
    }

    async function confirmExploringOverride(
        command: string,
        targetPhase: Phase,
        ctx: ExtensionContext,
    ): Promise<boolean> {
        const reason = (
            await ctx.ui.input(
                `Reason for overriding the Exploring gate before ${PHASE_LABELS[targetPhase]}?`,
            )
        )?.trim();
        if (!reason) {
            ctx.ui.notify(
                "Exploring override cancelled: a non-empty user reason is required.",
                "warning",
            );
            return false;
        }
        if (!activePhase) throw new Error("No active brainstorming run.");
        const blocker = artifactCompletionBlocker("exploring");
        const blockers = blocker
            ? [blocker]
            : ["User requested a force transition from Exploring."];
        const choice = await ctx.ui.select(
            [
                `Approve forced transition to ${PHASE_LABELS[targetPhase]}?`,
                `Reason: ${reason}`,
                `Bypassed blockers: ${blockers.join(" | ")}`,
            ].join("\n"),
            ["Approve override", "Cancel"],
        );
        if (choice !== "Approve override") {
            ctx.ui.notify("Exploring override cancelled.", "warning");
            return false;
        }
        explorationLedger ??= createExplorationLedger({ runId });
        const record = explorationLedger.recordOverride({
            command,
            blockers,
            reason,
            fromPhase: activePhase,
            toPhase: targetPhase,
        });
        pi.appendEntry(LEDGER_SESSION_KEY, { runId, record });
        return true;
    }

    pi.registerCommand("brainstorm", {
        description:
            "Brainstorm workflow. /brainstorm <topic> starts immediately. " +
            "/brainstorm arm <topic> arms only. /brainstorm next | force-next | status | stop",
        getArgumentCompletions: (prefix: string) => {
            const trimmed = prefix.trimStart().toLowerCase();
            const phaseOptions = PHASES.map((phase, index) => ({
                value: `phase ${phase}`,
                label: `phase ${phase}`,
                description: `Jump to ${PHASE_LABELS[phase]} (${index + 1}/${PHASES.length})`,
            }));
            const base = [
                {
                    value: "status",
                    label: "status",
                    description:
                        "Show current phase, evidence, and restrictions",
                },
                {
                    value: "artifacts",
                    label: "artifacts",
                    description:
                        "List durable artifact revisions for the active brainstorm",
                },
                {
                    value: "review",
                    label: "review",
                    description: "Open the active artifact inside Pi",
                },
                {
                    value: "stop",
                    label: "stop",
                    description: "Disable brainstorming workflow",
                },
                {
                    value: "next",
                    label: "next",
                    description:
                        "Advance one phase if completion criteria are met",
                },
                {
                    value: "previous",
                    label: "previous",
                    description: "Return to previous phase",
                },
                {
                    value: "arm ",
                    label: "arm",
                    description:
                        "Arm workflow only; do not send message to model",
                },
                {
                    value: "start ",
                    label: "start",
                    description:
                        "Arm workflow and immediately send topic to model",
                },
                ...phaseOptions,
            ];
            if (!trimmed) return base;
            const filtered = base.filter((item) =>
                item.value.toLowerCase().startsWith(trimmed),
            );
            return filtered.length > 0 ? filtered : null;
        },
        handler: async (args, ctx) => {
            const raw = args.trim();
            const [first, ...rest] = raw.split(/\s+/).filter(Boolean);
            const tail = rest.join(" ").trim();

            if (!raw || raw === "status") {
                if (!activePhase) {
                    ctx.ui.notify(
                        "No active brainstorming session. Use /brainstorm <topic> or /brainstorm start <topic>.",
                        "info",
                    );
                    return;
                }
                const blocker = artifactCompletionBlocker(activePhase);
                const ledgerLines =
                    activePhase === "exploring"
                        ? `\n${explorationStatusLines().join("\n")}`
                        : "";
                ctx.ui.notify(
                    `Brainstorm: ${topic.display} — ${PHASE_LABELS[activePhase]} (${PHASES.indexOf(activePhase) + 1}/${PHASES.length})` +
                        `\nResearch calls: ${evidence.researchCalls} | Questions: ${evidence.questionCalls}` +
                        ledgerLines +
                        `\nRestrictions: ${phaseRestrictionSummary(activePhase)}` +
                        (blocker
                            ? `\nNext blocked: ${blocker}`
                            : "\nNext allowed."),
                    blocker ? "warning" : "info",
                );
                return;
            }

            if (raw === "review") {
                if (!activePhase) {
                    ctx.ui.notify("No active brainstorming session.", "info");
                    return;
                }
                const checkpoint = artifacts[activePhase];
                if (!checkpoint) {
                    ctx.ui.notify(
                        `${PHASE_LABELS[activePhase]} has no submitted artifact yet.`,
                        "warning",
                    );
                    return;
                }
                if (ctx.mode !== "tui") {
                    ctx.ui.notify(
                        `Active artifact: ${checkpoint.path}`,
                        "info",
                    );
                    return;
                }
                const revision = String(checkpoint.revision).padStart(3, "0");
                await openArtifactOverlay(
                    checkpoint,
                    `${PHASE_LABELS[activePhase]} r${revision}`,
                    ["Close"],
                    "Close",
                    ctx,
                );
                return;
            }

            if (raw === "artifacts") {
                if (!activePhase) {
                    ctx.ui.notify("No active brainstorming session.", "info");
                    return;
                }
                const manifest = getArtifactStore(ctx).getManifest();
                const revisions = manifest.revisions.map(
                    (revision) =>
                        `${revision.status === "active" ? "active" : "stale"} — ${revision.path}`,
                );
                ctx.ui.notify(
                    `Brainstorm artifacts: ${manifest.root}\n${revisions.length > 0 ? revisions.join("\n") : "No artifacts submitted yet."}`,
                    "info",
                );
                return;
            }

            if (raw === "stop" || raw === "off" || raw === "quit") {
                if (pendingVerification)
                    verificationCoordinator.stop(pendingVerification.runId);
                resetState();
                saveState(ctx);
                ctx.ui.notify("Brainstorming mode off.", "info");
                return;
            }

            if (first === "arm") {
                if (!tail) {
                    ctx.ui.notify("Usage: /brainstorm arm <topic>", "error");
                    return;
                }
                startPhase(tail, ctx, false);
                return;
            }

            if (first === "start") {
                if (!tail) {
                    ctx.ui.notify("Usage: /brainstorm start <topic>", "error");
                    return;
                }
                startPhase(tail, ctx, true);
                return;
            }

            if (first === "phase") {
                const target = tail;
                if (!target) {
                    ctx.ui.notify(
                        "Usage: /brainstorm phase <name|number>",
                        "error",
                    );
                    return;
                }
                const resolved = findPhase(target);
                if (!resolved) {
                    ctx.ui.notify(`Unknown phase "${target}".`, "error");
                    return;
                }
                const exploringIndex = PHASES.indexOf("exploring");
                const crossesExploringGate =
                    activePhase !== null &&
                    PHASES.indexOf(activePhase) <= exploringIndex &&
                    PHASES.indexOf(resolved) > exploringIndex;
                if (
                    crossesExploringGate &&
                    !(await confirmExploringOverride(
                        `/brainstorm phase ${resolved}`,
                        resolved,
                        ctx,
                    ))
                )
                    return;
                activePhase = resolved;
                saveState(ctx);
                ctx.ui.notify(
                    `Jumped to ${PHASE_LABELS[resolved]} (${PHASES.indexOf(resolved) + 1}/${PHASES.length}).`,
                    "info",
                );
                return;
            }

            if (first === "next") {
                if (!activePhase) {
                    ctx.ui.notify("No active brainstorming session.", "error");
                    return;
                }
                if (!tail) {
                    notifyAdjacentTransition("next", ctx);
                    return;
                }
                if (tail !== "--force") {
                    ctx.ui.notify(
                        "Usage: /brainstorm next [--force]. Use /brainstorm phase <name> for explicit jumps.",
                        "error",
                    );
                    return;
                }
                const next = nextPhase(activePhase);
                if (!next) {
                    ctx.ui.notify("Already at final phase.", "info");
                    return;
                }
                if (
                    activePhase === "exploring" &&
                    !(await confirmExploringOverride(
                        "/brainstorm next --force",
                        next,
                        ctx,
                    ))
                )
                    return;
                activePhase = next;
                saveState(ctx);
                ctx.ui.notify(
                    `Advanced to ${PHASE_LABELS[next]} (${PHASES.indexOf(next) + 1}/${PHASES.length}) (forced).`,
                    "warning",
                );
                return;
            }

            if (first === "previous") {
                if (tail) {
                    ctx.ui.notify(
                        "Usage: /brainstorm previous. Use /brainstorm phase <name> for explicit jumps.",
                        "error",
                    );
                    return;
                }
                notifyAdjacentTransition("previous", ctx);
                return;
            }

            if (raw === "force-next") {
                // Deprecated alias — now use /brainstorm next --force
                if (!activePhase) {
                    ctx.ui.notify("No active brainstorming session.", "error");
                    return;
                }
                const idx = PHASES.indexOf(activePhase);
                const next = PHASES[idx + 1];
                if (!next) {
                    ctx.ui.notify("Already at final phase.", "info");
                    return;
                }
                if (
                    activePhase === "exploring" &&
                    !(await confirmExploringOverride(
                        "/brainstorm force-next",
                        next,
                        ctx,
                    ))
                )
                    return;
                activePhase = next;
                saveState(ctx);
                ctx.ui.notify(
                    `Force-advanced to ${PHASE_LABELS[next]} (${idx + 2}/${PHASES.length}).`,
                    "warning",
                );
                return;
            }

            // Bare topic => start immediately
            startPhase(raw, ctx, true);
        },
    });

    pi.on("resources_discover", async () => {
        return { skillPaths: [`${__dirname}/skills`] };
    });

    pi.on("context", async (event, ctx) => {
        const messages = event.messages.filter(
            (message) =>
                message.role !== "custom" ||
                message.customType !== "brainstorm-forcer-status",
        );
        if (!activePhase) return { messages };
        const manifest = getArtifactStore(ctx).getManifest();
        const activeArtifacts = PHASES.flatMap((phase) => {
            const checkpoint = artifacts[phase];
            return checkpoint
                ? [
                      `- ${PHASE_LABELS[phase]}: r${checkpoint.revision} ${checkpoint.complete ? "complete" : "incomplete"} — ${checkpoint.path}`,
                  ]
                : [];
        });
        const staleArtifacts = manifest.revisions
            .filter((revision) => revision.status === "stale")
            .map(
                (revision) =>
                    `- ${PHASE_LABELS[revision.phase]} r${revision.revision}: ${revision.path}`,
            );
        const blocker = artifactCompletionBlocker(activePhase);
        const content = [
            "[Brainstorm status — mandatory workflow context]",
            `Topic: ${topic.raw}`,
            `Phase: ${PHASE_LABELS[activePhase]} (${PHASES.indexOf(activePhase) + 1}/${PHASES.length})`,
            `Required submission tool: ${expectedSubmissionTool(activePhase)}`,
            `Transition tool: brainstorm_transition (next|previous|status; no force or skipping)`,
            `Artifacts root: ${manifest.root}`,
            `Current gate: ${blocker ?? "ready for next transition"}`,
            ...(activePhase === "exploring"
                ? [
                      ...explorationStatusLines(),
                      ...(pendingVerification
                          ? [
                                `Owned verification ${pendingVerification.runId}: inspect with /brainstorm status or cancel with /brainstorm stop; ask_user_question waits for terminal RV-* processing.`,
                            ]
                          : []),
                  ]
                : []),
            "Active artifacts:",
            ...(activeArtifacts.length > 0 ? activeArtifacts : ["- None yet."]),
            "Stale artifacts:",
            ...(staleArtifacts.length > 0 ? staleArtifacts : ["- None."]),
            "Scope: produce design artifacts only. Never create an implementation plan, choose a planning workflow, or implement code.",
        ].join("\n");
        return {
            messages: [
                ...messages,
                {
                    role: "custom" as const,
                    customType: "brainstorm-forcer-status",
                    content,
                    display: false,
                    details: { phase: activePhase, runId, root: manifest.root },
                    timestamp: Date.now(),
                },
            ],
        };
    });

    pi.on("session_start", async (_event, ctx) => {
        activeContext = ctx;
        widget = createWidget(pi, {
            id: WIDGET_ID,
            label: "Brainstorm",
            description:
                "Shows brainstorming phase, topic, and evidence counters.",
            row: 0,
            order: 8,
            align: "left",
            render: () => widgetText,
        });
        refreshGroups();
        restoreState(ctx);
        updateWidget(ctx);
        await reconcilePendingVerification(ctx);
    });

    pi.on("session_tree", async (_event, ctx) => {
        const oldPending = pendingVerification;
        if (oldPending) verificationCoordinator.stop(oldPending.runId);
        activeContext = ctx;
        restoreState(ctx);
        updateWidget(ctx);
        await reconcilePendingVerification(ctx);
    });

    pi.on("session_shutdown", async (_event, ctx) => {
        widget?.remove(ctx);
        widget = null;
        widgetText = null;
        ceilingManager.dispose();
        unsubscribeCompletion();
        verificationCoordinator.dispose();
        activeContext = null;
    });

    pi.on("tool_call", async (event, ctx) => {
        if (!activePhase) return;
        if (
            canUseTool(
                activePhase,
                event.toolName,
                groups,
                event.input,
                pendingVerification,
            )
        )
            return;
        const phaseLabel = PHASE_LABELS[activePhase];
        const allowedTools = [
            "non-mutating research/question tools",
            ...(activePhase === "exploring"
                ? [...EXPLORING_WORKFLOW_TOOLS]
                : []),
            expectedSubmissionTool(activePhase),
            "brainstorm_transition",
        ].join(", ");
        const baseReason = pendingVerificationToolBlockReason(
            activePhase,
            event.toolName,
            event.input,
            pendingVerification,
        );
        const reason =
            (baseReason &&
            !pendingVerification &&
            lastTerminalRunId &&
            baseReason.includes("No owned verification run is pending")
                ? `BLOCKED: Verification run ${lastTerminalRunId} already completed and was audited. No pending verification run. Inspect the gate status for missing reviews or proceed to the final approach choice.`
                : baseReason) ??
            [
                `BLOCKED: ${event.toolName} is not allowed in the ${phaseLabel} phase.`,
                `Allowed tools: ${allowedTools}.`,
                `Generic mutation, shell, and planning tools remain blocked for the entire brainstorm.`,
                `Submit the current phase artifact, then request an adjacent transition.`,
                ``,
                `Current restriction: ${phaseRestrictionSummary(activePhase)}`,
            ].join("\n");
        if (ctx.hasUI) {
            ctx.ui.notify(`Blocked ${event.toolName}`, "warning");
        }
        return { block: true, reason };
    });

    pi.on("tool_result", async (event, ctx) => {
        if (!activePhase) return undefined;
        if (groups.research.has(event.toolName)) evidence.researchCalls += 1;
        if (groups.questioning.has(event.toolName)) evidence.questionCalls += 1;

        if (
            activePhase === "exploring" &&
            !event.toolName.startsWith("brainstorm_") &&
            !EXPLORING_ORCHESTRATION_TOOLS.has(event.toolName) &&
            canUseTool(
                activePhase,
                event.toolName,
                groups,
                event.input,
                pendingVerification,
            )
        ) {
            explorationLedger ??= createExplorationLedger({ runId });
            const record = explorationLedger.captureEvidence({
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                input: event.input,
                content: event.content,
                details: event.details,
                isError: event.isError,
            });
            appendExplorationRecord(record, ctx);
            const cancelledQuestion =
                event.toolName === "ask_user_question" &&
                !event.isError &&
                typeof event.details === "object" &&
                event.details !== null &&
                "cancelled" in event.details &&
                event.details.cancelled === true;
            const evidenceStatus = cancelledQuestion
                ? `transport=${record.status}; semantic=cancelled; final-choice=ineligible`
                : record.status;
            return {
                content: [
                    ...event.content,
                    {
                        type: "text" as const,
                        text: `[brainstorm evidence] Captured as ${record.id} (${evidenceStatus}).`,
                    },
                ],
            };
        }
        // Detect blocked mutation tool — inject follow-up to LLM so it knows why
        const blocked =
            event.isError &&
            !canUseTool(
                activePhase,
                event.toolName,
                groups,
                event.input,
                pendingVerification,
            );
        if (blocked && ctx.hasUI) {
            pi.appendEntry(SESSION_KEY, {
                ...stateSnapshot(),
                blockFeedback: {
                    tool: event.toolName,
                    phase: activePhase,
                    phaseLabel: PHASE_LABELS[activePhase],
                },
            });
        }
        return undefined;
    });

    pi.on("message_end", async (event) => {
        if (!activePhase) return;
        if (event.message.role !== "assistant") return;
        evidence.assistantTurnsByPhase[activePhase] += 1;
    });

    pi.on("before_agent_start", async (event, ctx) => {
        if (!activePhase) return;
        const data = latestSessionData(ctx) as
            | {
                  blockFeedback?: {
                      tool: string;
                      phase: string;
                      phaseLabel: string;
                  };
              }
            | undefined;
        const blockNote = data?.blockFeedback
            ? `\n\nPREVIOUS TOOL BLOCKED: Your last call to \`${data.blockFeedback.tool}\` was blocked in ${data.blockFeedback.phaseLabel}. Generic mutation and planning tools are never allowed during brainstorming. Use the current phase submission tool and brainstorm_transition instead.`
            : "";
        return {
            systemPrompt: `${event.systemPrompt}\n\n${phasePrompt(activePhase, topic, evidence)}${blockNote}`,
            message: {
                customType: SESSION_KEY,
                content: phaseBanner(activePhase, topic),
                display: true,
                details: {
                    phase: activePhase,
                    topic,
                    restriction: phaseRestrictionSummary(activePhase),
                    researchCalls: evidence.researchCalls,
                    questionCalls: evidence.questionCalls,
                },
            },
        };
    });
}
