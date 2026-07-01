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

import type {
  ExtensionAPI,
  ExtensionContext,
  MessageRenderer,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createUiColors } from "../_shared/ui-colors";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PHASES = ["discovery", "understanding", "exploring", "presenting", "documenting"] as const;
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

const SESSION_KEY = "brainstorm-forcer";
const STATUS_ID = "brainstorm";

type ToolGroups = {
  research: Set<string>;
  questioning: Set<string>;
  mutation: Set<string>;
};

type Evidence = {
  researchCalls: number;
  questionCalls: number;
  approvalsCaptured: number;
  assistantTurnsByPhase: Record<Phase, number>;
};

const EMPTY_EVIDENCE = (): Evidence => ({
  researchCalls: 0,
  questionCalls: 0,
  approvalsCaptured: 0,
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

function canUseTool(phase: Phase, toolName: string, groups: ToolGroups): boolean {
  if (phase === "documenting") return true;
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
      return "Write approved design doc. All tools allowed.";
  }
}

function phaseBanner(phase: Phase, topic: string): string {
  return `${PHASE_ICONS[phase]} Brainstorm ${PHASE_LABELS[phase]} (${PHASES.indexOf(phase) + 1}/${PHASES.length}) — ${topic}`;
}

function phasePrompt(phase: Phase, topic: string, evidence: Evidence): string {
  const completed: string[] = [];
  const idx = PHASES.indexOf(phase);
  for (let i = 0; i < idx; i++) {
    completed.push(`- COMPLETED: ${PHASE_LABELS[PHASES[i]!]}`);
  }

  const evidenceLine = `Evidence so far — researchCalls=${evidence.researchCalls}, questionCalls=${evidence.questionCalls}, approvals=${evidence.approvalsCaptured}`;

  switch (phase) {
    case "discovery":
      return [
        `Current topic: ${topic}`,
        `Current phase: DISCOVERY`,
        `Use the bundled skill \`brainstorm-forcer\` and research tools to understand the codebase and produce a Research Summary with Files Accessed / Key Findings / Gaps.`,
        evidenceLine,
      ].join("\n\n");
    case "understanding":
      return [
        `Current topic: ${topic}`,
        `Current phase: UNDERSTANDING`,
        `Use the bundled skill \`brainstorm-forcer\` and ask_user_question to ask one clarifying question at a time. Do not write code.`,
        evidenceLine,
        ...completed,
      ].join("\n\n");
    case "exploring":
      return [
        `Current topic: ${topic}`,
        `Current phase: EXPLORING`,
        `Follow the bundled skill \`brainstorm-forcer\`: propose 2-3 approaches with trade-offs, uncertainties, and recommendation. Do not write code.`,
        evidenceLine,
        ...completed,
      ].join("\n\n");
    case "presenting":
      return [
        `Current topic: ${topic}`,
        `Current phase: PRESENTING`,
        `Follow the bundled skill \`brainstorm-forcer\`: present design in 200-300 word sections. Validate sections with user using ask_user_question when appropriate. Do not write code.`,
        evidenceLine,
        ...completed,
      ].join("\n\n");
    case "documenting":
      return [
        `Current topic: ${topic}`,
        `Current phase: DOCUMENTING`,
        `Follow the bundled skill \`brainstorm-forcer\` and write approved design doc to docs/plans/.`,
        evidenceLine,
        ...completed,
      ].join("\n\n");
  }
}

function completionBlocker(phase: Phase, evidence: Evidence): string | undefined {
  switch (phase) {
    case "discovery":
      return evidence.researchCalls > 0
        ? undefined
        : "Discovery incomplete: no research tool calls observed yet.";
    case "understanding":
      return evidence.questionCalls > 0
        ? undefined
        : "Understanding incomplete: ask_user_question has not been used yet.";
    case "exploring":
      return evidence.assistantTurnsByPhase.exploring > 0
        ? undefined
        : "Exploring incomplete: no exploring-phase assistant response observed yet.";
    case "presenting":
      return evidence.approvalsCaptured > 0
        ? undefined
        : "Presenting incomplete: no ask_user_question approval/validation captured yet.";
    case "documenting":
      return undefined;
  }
}

const brainstormMessageRenderer: MessageRenderer = (message, { expanded }, theme) => {
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
  let topic = "";
  let evidence = EMPTY_EVIDENCE();
  let groups: ToolGroups = {
    research: new Set(),
    questioning: new Set(),
    mutation: new Set(),
  };

  function refreshGroups() {
    groups = buildToolGroups(pi);
  }

  function resetState() {
    activePhase = null;
    topic = "";
    evidence = EMPTY_EVIDENCE();
    refreshGroups();
  }

  function updateFooter(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    const colors = createUiColors(ctx.ui.theme);
    if (!activePhase) {
      ctx.ui.setStatus(STATUS_ID, "");
      return;
    }
    const idx = PHASES.indexOf(activePhase) + 1;
    const research = evidence.researchCalls;
    const questions = evidence.questionCalls;
    const status = [
      colors.primary(`${PHASE_ICONS[activePhase]} ${PHASE_LABELS[activePhase]}`),
      colors.separator(" • "),
      colors.meta(`phase ${idx}/${PHASES.length}`),
      colors.separator(" • "),
      colors.text(topic),
      colors.separator(" • "),
      colors.meta(`r:${research} q:${questions}`),
    ].join("");
    ctx.ui.setStatus(STATUS_ID, status);
  }

  function saveState(ctx: ExtensionContext): void {
    if (activePhase) {
      pi.appendEntry(SESSION_KEY, {
        active: true,
        phase: activePhase,
        topic,
        evidence,
      });
    } else {
      pi.appendEntry(SESSION_KEY, { active: false });
    }
    updateFooter(ctx);
  }

  function restoreState(ctx: ExtensionContext): void {
    resetState();
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type !== "custom" || entry.customType !== SESSION_KEY) continue;
      const data = entry.data as { active?: boolean; phase?: string; topic?: string; evidence?: Evidence } | undefined;
      if (!data || data.active === false) return;
      if (data.phase && (PHASES as readonly string[]).includes(data.phase)) {
        activePhase = data.phase as Phase;
        topic = data.topic ?? "";
        evidence = data.evidence ?? EMPTY_EVIDENCE();
      }
      return;
    }
  }

  function startPhase(topicText: string, ctx: ExtensionContext, immediate: boolean): void {
    activePhase = "discovery";
    topic = topicText;
    evidence = EMPTY_EVIDENCE();
    refreshGroups();
    saveState(ctx);
    ctx.ui.notify(`Brainstorm ${immediate ? "started" : "armed"}: "${topic}" — Phase 1/${PHASES.length}: Discovery`, "info");
    if (immediate) {
      if (ctx.isIdle()) {
        pi.sendUserMessage(topic);
      } else {
        pi.sendUserMessage(topic, { deliverAs: "followUp" });
        ctx.ui.notify("Queued brainstorm topic as follow-up turn.", "info");
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
        { value: "status", label: "status", description: "Show current phase, evidence, and restrictions" },
        { value: "stop", label: "stop", description: "Disable brainstorming workflow" },
        { value: "next", label: "next", description: "Advance if completion criteria are met" },
        { value: "force-next", label: "force-next", description: "Advance even if completion criteria are not met" },
        { value: "arm ", label: "arm", description: "Arm workflow only; do not send message to model" },
        { value: "start ", label: "start", description: "Arm workflow and immediately send topic to model" },
        ...phaseOptions,
      ];
      if (!trimmed) return base;
      const filtered = base.filter((item) => item.value.toLowerCase().startsWith(trimmed));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const raw = args.trim();
      const [first, ...rest] = raw.split(/\s+/).filter(Boolean);
      const tail = rest.join(" ").trim();

      if (!raw || raw === "status") {
        if (!activePhase) {
          ctx.ui.notify("No active brainstorming session. Use /brainstorm <topic> or /brainstorm start <topic>.", "info");
          return;
        }
        const blocker = completionBlocker(activePhase, evidence);
        ctx.ui.notify(
          `Brainstorm: "${topic}" — ${PHASE_LABELS[activePhase]} (${PHASES.indexOf(activePhase) + 1}/${PHASES.length})` +
            `\nResearch calls: ${evidence.researchCalls} | Questions: ${evidence.questionCalls} | Approvals: ${evidence.approvalsCaptured}` +
            `\nRestrictions: ${phaseRestrictionSummary(activePhase)}` +
            (blocker ? `\nNext blocked: ${blocker}` : "\nNext allowed."),
          blocker ? "warning" : "info",
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
          ctx.ui.notify("Usage: /brainstorm phase <name|number>", "error");
          return;
        }
        let resolved: Phase | null = null;
        const n = Number(target);
        if (Number.isInteger(n) && n >= 1 && n <= PHASES.length) resolved = PHASES[n - 1]!;
        else {
          const lower = target.toLowerCase();
          resolved = PHASES.find((p) => p === lower || PHASE_LABELS[p].toLowerCase() === lower || p.startsWith(lower)) ?? null;
        }
        if (!resolved) {
          ctx.ui.notify(`Unknown phase "${target}".`, "error");
          return;
        }
        activePhase = resolved;
        saveState(ctx);
        ctx.ui.notify(`Jumped to ${PHASE_LABELS[resolved]} (${PHASES.indexOf(resolved) + 1}/${PHASES.length}).`, "info");
        return;
      }

      if (raw === "next") {
        if (!activePhase) {
          ctx.ui.notify("No active brainstorming session.", "error");
          return;
        }
        const blocker = completionBlocker(activePhase, evidence);
        if (blocker) {
          ctx.ui.notify(blocker, "warning");
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
        ctx.ui.notify(`Advanced to ${PHASE_LABELS[next]} (${idx + 2}/${PHASES.length}).`, "info");
        return;
      }

      if (raw === "force-next") {
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
        ctx.ui.notify(`Force-advanced to ${PHASE_LABELS[next]} (${idx + 2}/${PHASES.length}).`, "warning");
        return;
      }

      // Bare topic => start immediately
      startPhase(raw, ctx, true);
    },
  });

  pi.on("resources_discover", async () => {
    return { skillPaths: [`${__dirname}/skills`] };
  });

  pi.on("session_start", async (_event, ctx) => {
    refreshGroups();
    restoreState(ctx);
    updateFooter(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_ID, "");
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!activePhase) return;
    if (canUseTool(activePhase, event.toolName, groups)) return;
    const reason = phaseRestrictionSummary(activePhase);
    if (ctx.hasUI) {
      ctx.ui.notify(`Blocked ${event.toolName}: ${reason}`, "warning");
    }
    return { block: true, reason };
  });

  pi.on("tool_result", async (event) => {
    if (!activePhase) return;
    if (groups.research.has(event.toolName)) evidence.researchCalls += 1;
    if (groups.questioning.has(event.toolName)) {
      evidence.questionCalls += 1;
      if (activePhase === "presenting") evidence.approvalsCaptured += 1;
    }
  });

  pi.on("message_end", async (event) => {
    if (!activePhase) return;
    if (event.message.role !== "assistant") return;
    evidence.assistantTurnsByPhase[activePhase] += 1;
  });

  pi.on("before_agent_start", async (event) => {
    if (!activePhase) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${phasePrompt(activePhase, topic, evidence)}`,
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
