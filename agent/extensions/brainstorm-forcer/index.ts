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
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
    ExtensionAPI,
    ExtensionContext,
    MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createWidget, type WidgetHandle } from "../_shared/fancy-footer";
import { createUiColors } from "../_shared/ui-colors";
import { createBrainstormArtifactStore } from "./artifacts";

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
const WIDGET_ID = "brainstorm-forcer";
const DEFAULT_REJECTION_REASON =
    "Refine the current phase: investigate remaining gaps, validate assumptions, go deeper, revise its artifact, then request transition again.";

type TopicState = {
    raw: string;
    display: string;
};

function summarizeTopicForUi(raw: string): string {
    const singleLine = raw.replace(/\s+/g, " ").trim();
    if (singleLine.length <= 64) return singleLine;
    return `${singleLine.slice(0, 61).trimEnd()}…`;
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
): boolean {
    if (toolName === "brainstorm_transition") return true;
    if (Object.values(PHASE_SUBMISSION_TOOLS).includes(toolName))
        return toolName === PHASE_SUBMISSION_TOOLS[phase];
    if (ALWAYS_BLOCKED_TOOLS.has(toolName)) return false;
    return !groups.mutation.has(toolName);
}

function phaseRestrictionSummary(phase: Phase): string {
    switch (phase) {
        case "discovery":
            return "Discovery phase. Any non-mutating tool is allowed. Mutation blocked. Gather evidence + produce Research Summary.";
        case "understanding":
            return "Understanding phase. Any non-mutating tool is allowed; prefer ask_user_question to refine requirements. Mutation blocked.";
        case "exploring":
            return "Exploring phase. Any non-mutating tool is allowed. Compare 2-3 approaches with trade-offs. Mutation blocked.";
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
                `Follow the bundled skill \`brainstorm-forcer\`: propose 2-3 approaches with trade-offs, uncertainties, and recommendation. Do not write code.`,
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

export default function brainstormForcer(pi: ExtensionAPI) {
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

    const ApproachSchema = Type.Object(
        {
            title: Type.String({ minLength: 1 }),
            summary: Type.String({ minLength: 1 }),
            tradeoffs: Type.Array(Type.String({ minLength: 1 })),
            uncertainties: Type.Array(Type.String({ minLength: 1 })),
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
                userChoice: Type.String({ minLength: 1 }),
            },
            { additionalProperties: false },
        ),
        async execute(_id, params, _signal, _update, ctx) {
            const approaches = params.approaches.flatMap((approach, index) => [
                `## Approach ${index + 1}: ${approach.title}`,
                "",
                approach.summary,
                "",
                "### Trade-offs",
                "",
                ...markdownList(approach.tradeoffs),
                "",
                "### Critical Uncertainties",
                "",
                ...markdownList(approach.uncertainties),
                "",
                "### Conditions for Failure",
                "",
                ...markdownList(approach.failureConditions),
                "",
            ]);
            const markdown = [
                "# Exploring Approaches",
                "",
                ...approaches,
                "## Recommendation",
                "",
                params.recommendation,
                "",
                "## User Choice",
                "",
                params.userChoice,
            ].join("\n");
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
            const choice = await ctx.ui.select(
                `Approve brainstorm transition: ${PHASE_LABELS[activePhase]} → ${targetLabel}?`,
                ["Approve", "Reject", "Reject with reason"],
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

    function expectedSubmissionTool(phase: Phase): string {
        return PHASE_SUBMISSION_TOOLS[phase];
    }

    function artifactCompletionBlocker(phase: Phase): string | undefined {
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
                        ? `Current brainstorm phase: ${PHASE_LABELS[activePhase]}.`
                        : "Brainstorm completed.",
                },
            ],
            details: {
                phase: activePhase,
                completed,
                artifacts: structuredClone(artifacts),
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

    function resetState() {
        activePhase = null;
        topic = { raw: "", display: "" };
        evidence = EMPTY_EVIDENCE();
        runId = "";
        startedAt = "";
        artifactStore = null;
        artifacts = {};
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
        widgetText = [
            colors.primary(
                `${PHASE_ICONS[activePhase]} ${PHASE_LABELS[activePhase]}`,
            ),
            colors.separator(" • "),
            colors.meta(`p${idx}/${PHASES.length}`),
            colors.separator(" • "),
            colors.text(topic.display),
            colors.separator(" • "),
            colors.meta(`r:${research} q:${questions}`),
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
        };
    }

    function saveState(ctx: ExtensionContext): void {
        pi.appendEntry(SESSION_KEY, stateSnapshot());
        updateWidget(ctx);
    }

    function latestSessionData(ctx: ExtensionContext) {
        const entries = ctx.sessionManager.getEntries();
        for (let i = entries.length - 1; i >= 0; i--) {
            const entry = entries[i];
            if (entry.type === "custom" && entry.customType === SESSION_KEY)
                return entry.data;
        }
        return undefined;
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
        }
    }

    function startPhase(
        topicText: string,
        ctx: ExtensionContext,
        immediate: boolean,
    ): void {
        activePhase = "discovery";
        topic = { raw: topicText, display: summarizeTopicForUi(topicText) };
        evidence = EMPTY_EVIDENCE();
        runId = `brainstorm-${randomUUID()}`;
        startedAt = new Date().toISOString();
        artifactStore = null;
        artifacts = {};
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
                ctx.ui.notify(
                    `Brainstorm: ${topic.display} — ${PHASE_LABELS[activePhase]} (${PHASES.indexOf(activePhase) + 1}/${PHASES.length})` +
                        `\nResearch calls: ${evidence.researchCalls} | Questions: ${evidence.questionCalls}` +
                        `\nRestrictions: ${phaseRestrictionSummary(activePhase)}` +
                        (blocker
                            ? `\nNext blocked: ${blocker}`
                            : "\nNext allowed."),
                    blocker ? "warning" : "info",
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
    });

    pi.on("session_shutdown", async (_event, ctx) => {
        widget?.remove(ctx);
        widget = null;
        widgetText = null;
    });

    pi.on("tool_call", async (event, ctx) => {
        if (!activePhase) return;
        if (canUseTool(activePhase, event.toolName, groups)) return;
        const phaseLabel = PHASE_LABELS[activePhase];
        const reason = [
            `BLOCKED: ${event.toolName} is not allowed in the ${phaseLabel} phase.`,
            `Allowed tools: non-mutating research/question tools, ${expectedSubmissionTool(activePhase)}, and brainstorm_transition.`,
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
        if (!activePhase) return;
        if (groups.research.has(event.toolName)) evidence.researchCalls += 1;
        if (groups.questioning.has(event.toolName)) evidence.questionCalls += 1;
        // Detect blocked mutation tool — inject follow-up to LLM so it knows why
        const blocked =
            event.isError && !canUseTool(activePhase, event.toolName, groups);
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
