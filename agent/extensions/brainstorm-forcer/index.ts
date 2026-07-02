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
import { createWidget, type WidgetHandle } from "../_shared/fancy-footer";

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
const WIDGET_ID = "brainstorm-forcer";

type TopicState = {
  raw: string;
  display: string;
};

function summarizeTopicForUi(raw: string): string {
  const singleLine = raw.replace(/\s+/g, " ").trim();
  if (singleLine.length <= 64) return singleLine;
  return `${singleLine.slice(0, 61).trimEnd()}…`;
}

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
  approvalsByPhase: Record<Phase, number>;
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
  approvalsByPhase: {
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

function phaseBanner(phase: Phase, topic: TopicState): string {
  return `${PHASE_ICONS[phase]} Brainstorm ${PHASE_LABELS[phase]} (${PHASES.indexOf(phase) + 1}/${PHASES.length}) — ${topic.display}`;
}

function phasePrompt(phase: Phase, topic: TopicState, evidence: Evidence): string {
  const completed: string[] = [];
  const idx = PHASES.indexOf(phase);
  for (let i = 0; i < idx; i++) {
    completed.push(`- COMPLETED: ${PHASE_LABELS[PHASES[i]!]}`);
  }

  const evidenceLine = `Evidence so far — researchCalls=${evidence.researchCalls}, questionCalls=${evidence.questionCalls}, approvals=${evidence.approvalsCaptured}`;

  switch (phase) {
    case "discovery":
      return [
        `Current topic: ${topic.raw}`,
        `Current phase: DISCOVERY`,
        `Use the bundled skill \`brainstorm-forcer\` and research tools to understand the codebase and produce a Research Summary with Files Accessed / Key Findings / Gaps.`,
        evidenceLine,
      ].join("\n\n");
    case "understanding":
      return [
        `Current topic: ${topic.raw}`,
        `Current phase: UNDERSTANDING`,
        `Use the bundled skill \`brainstorm-forcer\` and ask_user_question to ask one clarifying question at a time. Do not write code.`,
        evidenceLine,
        ...completed,
      ].join("\n\n");
    case "exploring":
      return [
        `Current topic: ${topic.raw}`,
        `Current phase: EXPLORING`,
        `Follow the bundled skill \`brainstorm-forcer\`: propose 2-3 approaches with trade-offs, uncertainties, and recommendation. Do not write code.`,
        evidenceLine,
        ...completed,
      ].join("\n\n");
    case "presenting":
      return [
        `Current topic: ${topic.raw}`,
        `Current phase: PRESENTING`,
        `Follow the bundled skill \`brainstorm-forcer\`: present design in 200-300 word sections. Validate sections with user using ask_user_question when appropriate. Do not write code.`,
        evidenceLine,
        ...completed,
      ].join("\n\n");
    case "documenting":
      return [
        `Current topic: ${topic.raw}`,
        `Current phase: DOCUMENTING`,
        `Use the \`writing-plans\` skill to create a detailed implementation plan at \`docs/plans/YYYY-MM-DD-<topic>-design.md\` (relative to CWD).`,
        `If \`writing-plans\` skill is not loaded, ask user to load it with /skill writing-plans.`,
        `If docs/plans/ does not exist, create it first.`,
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
      return evidence.approvalsByPhase.exploring > 0
        ? undefined
        : "Exploring incomplete: ask_user_question approval not captured yet. Ask user for preference on proposed approaches.";
    case "presenting":
      return evidence.approvalsByPhase.presenting > 0
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
  let topic: TopicState = { raw: "", display: "" };
  let evidence = EMPTY_EVIDENCE();
  let groups: ToolGroups = {
    research: new Set(),
    questioning: new Set(),
    mutation: new Set(),
  };
  let widgetText: string | null = null;
  let widget: WidgetHandle | null = null;

  function refreshGroups() {
    groups = buildToolGroups(pi);
  }

  function resetState() {
    activePhase = null;
    topic = { raw: "", display: "" };
    evidence = EMPTY_EVIDENCE();
    refreshGroups();
  }

  function nextPhase(phase: Phase): Phase | null {
    const idx = PHASES.indexOf(phase) + 1;
    return idx < PHASES.length ? PHASES[idx]! : null;
  }

  function previousPhase(phase: Phase): Phase | null {
    const idx = PHASES.indexOf(phase) - 1;
    return idx >= 0 ? PHASES[idx]! : null;
  }

  function findPhase(text: string): Phase | null {
    const lower = text.trim().toLowerCase();
    const byName = PHASES.find((p) => p === lower || PHASE_LABELS[p].toLowerCase() === lower || p.startsWith(lower));
    if (byName) return byName;
    const n = Number(lower);
    if (Number.isInteger(n) && n >= 1 && n <= PHASES.length) return PHASES[n - 1]!;
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
      colors.primary(`${PHASE_ICONS[activePhase]} ${PHASE_LABELS[activePhase]}`),
      colors.separator(" • "),
      colors.meta(`p${idx}/${PHASES.length}`),
      colors.separator(" • "),
      colors.text(topic.display),
      colors.separator(" • "),
      colors.meta(`r:${research} q:${questions}`),
    ].join("");
    widget?.update(ctx, widgetText);
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
    updateWidget(ctx);
  }

  function restoreState(ctx: ExtensionContext): void {
    resetState();
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type !== "custom" || entry.customType !== SESSION_KEY) continue;
      const data = entry.data as { active?: boolean; phase?: string; topic?: TopicState | string; evidence?: Evidence } | undefined;
      if (!data || data.active === false) return;
      if (data.phase && (PHASES as readonly string[]).includes(data.phase)) {
        activePhase = data.phase as Phase;
        const restoredTopic = data.topic;
        topic = typeof restoredTopic === "string"
          ? { raw: restoredTopic, display: summarizeTopicForUi(restoredTopic) }
          : restoredTopic ?? { raw: "", display: "" };
        evidence = data.evidence ?? EMPTY_EVIDENCE();
        // Ensure new fields exist on restored evidence (backward compat)
        if (!evidence.approvalsByPhase) {
          evidence.approvalsByPhase = EMPTY_EVIDENCE().approvalsByPhase;
        }
      }
      return;
    }
  }

  function startPhase(topicText: string, ctx: ExtensionContext, immediate: boolean): void {
    activePhase = "discovery";
    topic = { raw: topicText, display: summarizeTopicForUi(topicText) };
    evidence = EMPTY_EVIDENCE();
    refreshGroups();
    saveState(ctx);
    ctx.ui.notify(`Brainstorm ${immediate ? "started" : "armed"}: Discovery (1/${PHASES.length})`, "info");
    if (immediate) {
      if (ctx.isIdle()) {
        pi.sendUserMessage(topic.raw);
      } else {
        pi.sendUserMessage(topic.raw, { deliverAs: "followUp" });
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
      const currentIdx = activePhase ? PHASES.indexOf(activePhase) : -1;
      const phaseOptions = PHASES.map((phase, index) => ({
        value: `phase ${phase}`,
        label: `phase ${phase}`,
        description: `Jump to ${PHASE_LABELS[phase]} (${index + 1}/${PHASES.length})`,
      }));
      const nextOptions = PHASES.filter((p) => PHASES.indexOf(p) > currentIdx).map((phase) => ({
        value: `next ${phase}`,
        label: `next ${phase}`,
        description: `Advance directly to ${PHASE_LABELS[phase]} (${PHASES.indexOf(phase) + 1}/${PHASES.length})`,
      }));
      const previousOptions = PHASES.filter((p) => currentIdx >= 0 && PHASES.indexOf(p) < currentIdx).map((phase) => ({
        value: `previous ${phase}`,
        label: `previous ${phase}`,
        description: `Return directly to ${PHASE_LABELS[phase]} (${PHASES.indexOf(phase) + 1}/${PHASES.length})`,
      }));
      const base = [
        { value: "status", label: "status", description: "Show current phase, evidence, and restrictions" },
        { value: "stop", label: "stop", description: "Disable brainstorming workflow" },
        { value: "next", label: "next", description: "Advance one phase if completion criteria are met" },
        { value: "previous", label: "previous", description: "Return to previous phase" },
        { value: "arm ", label: "arm", description: "Arm workflow only; do not send message to model" },
        { value: "start ", label: "start", description: "Arm workflow and immediately send topic to model" },
        ...nextOptions,
        ...previousOptions,
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
          `Brainstorm: ${topic.display} — ${PHASE_LABELS[activePhase]} (${PHASES.indexOf(activePhase) + 1}/${PHASES.length})` +
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
        const resolved = findPhase(target);
        if (!resolved) {
          ctx.ui.notify(`Unknown phase "${target}".`, "error");
          return;
        }
        activePhase = resolved;
        saveState(ctx);
        ctx.ui.notify(`Jumped to ${PHASE_LABELS[resolved]} (${PHASES.indexOf(resolved) + 1}/${PHASES.length}).`, "info");
        return;
      }

      if (first === "next") {
        if (!activePhase) {
          ctx.ui.notify("No active brainstorming session.", "error");
          return;
        }
        const force = tail.includes("--force");
        const phaseArg = tail.replace(/--force/g, "").trim();
        if (!force) {
          const blocker = completionBlocker(activePhase, evidence);
          if (blocker) {
            ctx.ui.notify(blocker, "warning");
            return;
          }
        }
        let next: Phase | null;
        if (phaseArg) {
          const resolved = findPhase(phaseArg);
          if (!resolved) {
            ctx.ui.notify(`Unknown phase "${phaseArg}".`, "error");
            return;
          }
          if (PHASES.indexOf(resolved) <= PHASES.indexOf(activePhase)) {
            ctx.ui.notify(`Phase "${resolved}" is not after ${PHASE_LABELS[activePhase]}.`, "warning");
            return;
          }
          next = resolved;
        } else {
          next = nextPhase(activePhase);
        }
        if (!next) {
          ctx.ui.notify("Already at final phase.", "info");
          return;
        }
        activePhase = next;
        saveState(ctx);
        ctx.ui.notify(`Advanced to ${PHASE_LABELS[next]} (${PHASES.indexOf(next) + 1}/${PHASES.length})${force ? " (forced)" : ""}.`, force ? "warning" : "info");
        return;
      }

      if (first === "previous") {
        if (!activePhase) {
          ctx.ui.notify("No active brainstorming session.", "error");
          return;
        }
        const force = tail.includes("--force");
        const phaseArg = tail.replace(/--force/g, "").trim();
        let previous: Phase | null;
        if (phaseArg) {
          const resolved = findPhase(phaseArg);
          if (!resolved) {
            ctx.ui.notify(`Unknown phase "${phaseArg}".`, "error");
            return;
          }
          if (PHASES.indexOf(resolved) >= PHASES.indexOf(activePhase)) {
            ctx.ui.notify(`Phase "${resolved}" is not before ${PHASE_LABELS[activePhase]}.`, "warning");
            return;
          }
          previous = resolved;
        } else {
          previous = previousPhase(activePhase);
        }
        if (!previous) {
          ctx.ui.notify("Already at first phase.", "info");
          return;
        }
        activePhase = previous;
        saveState(ctx);
        ctx.ui.notify(`Returned to ${PHASE_LABELS[previous]} (${PHASES.indexOf(previous) + 1}/${PHASES.length})${force ? " (forced)" : ""}.`, force ? "warning" : "info");
        return;
      }

      if (raw === "force-next") {
        // Deprecated alias — now use /brainstorm next --force
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
    widget = createWidget(pi, {
      id: WIDGET_ID,
      label: "Brainstorm",
      description: "Shows brainstorming phase, topic, and evidence counters.",
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
      `Allowed tools: non-mutating only (read, search, ask_user_question, web_search, fetch_content, grep, find, ls, etc.).`,
      `Mutation tools (write, edit, bash, etc.) are blocked until the Documenting phase.`,
      `To skip to Documenting: /brainstorm next --force`,
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
    if (groups.questioning.has(event.toolName)) {
      evidence.questionCalls += 1;
      evidence.approvalsCaptured += 1;
      evidence.approvalsByPhase[activePhase] += 1;
    }
    // Detect blocked mutation tool — inject follow-up to LLM so it knows why
    const blocked = event.isError && groups.mutation.has(event.toolName) && activePhase !== "documenting";
    if (blocked && ctx.hasUI) {
      pi.appendEntry(SESSION_KEY, {
        active: true,
        phase: activePhase,
        topic,
        evidence,
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
    // Check for recent block feedback in session entries
    let blockNote = "";
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type !== "custom" || entry.customType !== SESSION_KEY) continue;
      const data = entry.data as { blockFeedback?: { tool: string; phase: string; phaseLabel: string } } | undefined;
      if (data?.blockFeedback) {
        const bf = data.blockFeedback;
        blockNote = `\n\n⚠️  PREVIOUS TOOL BLOCKED: Your last call to \`${bf.tool}\` was blocked because you are in the ${bf.phaseLabel} phase. Mutation tools are not allowed until the Documenting phase. To proceed with writing files, advance to Documenting with /brainstorm next --force. Otherwise, continue with non-mutating tools only.`;
        break;
      }
    }
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
