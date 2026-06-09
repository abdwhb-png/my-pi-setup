/**
 * Subagents Overview — /subagents-overview command + persistent widget
 *
 * Fully programmatic. No LLM involvement.
 * Reads agent configs, settings overrides, parses frontmatter,
 * and renders the overview directly into the conversation.
 * Also shows a persistent status widget in the Pi UI.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

// ── ANSI color constants ──────────────────────────────

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const BLUE = "\x1b[34m";
const MAGENTA = "\x1b[35m";
const RESET = "\x1b[0m"

const WIDGET_ID = "subagent-overview-widget";

// ── Types ──────────────────────────────────────────────

interface AgentInfo {
  name: string;
  description: string;
  tools: string[];
  model: string | null;
  skills: string[];
  source: "builtin" | "user" | "project";
  context: string | null;
}

interface AgentOverride {
  tools?: string[] | false;
  model?: string | false;
  skills?: string[] | false;
  [key: string]: unknown;
}

// ── Paths ──────────────────────────────────────────────

const HOME = process.env.HOME || "/home/abdwhb";
const SETTINGS_PATH = path.join(HOME, ".pi", "agent", "settings.json");
const USER_AGENTS_DIR = path.join(HOME, ".pi", "agent", "agents");
const BUILTIN_AGENTS_DIR = path.join(
  HOME,
  ".pi",
  "agent",
  "npm",
  "node_modules",
  "pi-subagents",
  "agents",
);

// ── Frontmatter Parsing ────────────────────────────────

function parseAgentFile(filePath: string): Record<string, string> | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const { frontmatter } = parseFrontmatter<Record<string, string>>(raw);
    return frontmatter;
  } catch {
    return null;
  }
}

// ── Data Collection ────────────────────────────────────

function readOverrides(): Record<string, AgentOverride> {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, "utf-8");
    const parsed = JSON.parse(raw) as {
      subagents?: { agentOverrides?: Record<string, AgentOverride> };
    };
    return parsed?.subagents?.agentOverrides ?? {};
  } catch {
    return {};
  }
}

/**
 * Return the effective tool list for an agent, applying overrides from settings.json.
 * If the override has a `tools` array, that completely replaces the original tool list.
 * If the override sets tools to `false`, the agent has no tools.
 * Otherwise the original tools are returned unchanged.
 */
function getEffectiveTools(
  agent: AgentInfo,
  overrides: Record<string, AgentOverride>,
): string[] {
  const override = overrides[agent.name];
  if (!override) return agent.tools;
  if (override.tools === false) return [];
  if (Array.isArray(override.tools)) return override.tools;
  return agent.tools;
}

function readBuiltinAgents(): AgentInfo[] {
  const agents: AgentInfo[] = [];
  const builtinNames = [
    "scout",
    "researcher",
    "planner",
    "worker",
    "reviewer",
    "context-builder",
    "oracle",
    "delegate",
  ];

  for (const name of builtinNames) {
    const filePath = path.join(BUILTIN_AGENTS_DIR, `${name}.md`);
    if (!fs.existsSync(filePath)) continue;
    const fm = parseAgentFile(filePath);
    if (!fm) continue;

    const toolsRaw = fm.tools || "";
    const tools = toolsRaw
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const skillsRaw = fm.skills || "";
    const skills = skillsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    agents.push({
      name: fm.name || name,
      description: fm.description || "",
      tools,
      model: fm.model || null,
      skills,
      source: "builtin",
      context: fm.defaultContext || null,
    });
  }

  return agents;
}

function readUserAgents(): AgentInfo[] {
  const agents: AgentInfo[] = [];
  if (!fs.existsSync(USER_AGENTS_DIR)) return agents;

  for (const entry of fs.readdirSync(USER_AGENTS_DIR)) {
    if (!entry.endsWith(".md")) continue;
    const filePath = path.join(USER_AGENTS_DIR, entry);
    const fm = parseAgentFile(filePath);
    if (!fm) continue;

    const toolsRaw = fm.tools || "";
    const tools = toolsRaw
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const skillsRaw = fm.skills || "";
    const skills = skillsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    agents.push({
      name: fm.name || entry.replace(/\.md$/, ""),
      description: fm.description || "",
      tools,
      model: fm.model || null,
      skills,
      source: "user",
      context: fm.defaultContext || null,
    });
  }

  return agents;
}

// ── Widget formatting ─────────────────────────────────

function buildWidgetLine(): string {
  const overrides = readOverrides();
  const builtins = readBuiltinAgents();
  const users = readUserAgents();

  const total = builtins.length + users.length;
  const overrideCount = Object.keys(overrides).length;

  // Agents with safe_bash only (no plain bash) — applying overrides
  const safeBashAgents = [...builtins, ...users]
    .filter(
      (a) =>
        getEffectiveTools(a, overrides).includes("safe_bash") &&
        !getEffectiveTools(a, overrides).includes("bash"),
    )
    .map((a) => a.name);

  const safeBashPart =
    safeBashAgents.length > 0 ? ` · 🔒 sb: ${safeBashAgents.join(",")}` : "";

  const overridePart =
    overrideCount > 0 ? ` · ${overrideCount} ovr` : "";

  // Check if videographer agent exists
  const hasVideographer = users.some((a) => a.name === "videographer");
  const videoPart = hasVideographer ? " · 🎬 video" : "";

  return `🧠 Subagents: ${builtins.length}B/${users.length}U${safeBashPart}${overridePart}${videoPart} (total ${total})`;
}

function updateWidget(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  try {
    const line = buildWidgetLine();
    ctx.ui.setWidget(WIDGET_ID, [line]);
  } catch {
    ctx.ui.setWidget(WIDGET_ID, undefined);
  }
}

// ── Formatting ─────────────────────────────────────────

function formatAgentBlock(
  agent: AgentInfo,
  overrides: Record<string, AgentOverride>,
): string[] {
  const lines: string[] = [];
  const override = overrides[agent.name];
  const hasOverride = override !== undefined;

  const paddedName = agent.name.padEnd(16);
  lines.push(`${BOLD}${paddedName}${RESET}${agent.description}`);

  const toolsLabel = hasOverride ? "Tools*" : "Tools";
  const toolsStr = agent.tools.length > 0 ? agent.tools.join(", ") : "—";
  const overrideMarker = hasOverride
    ? `  ${YELLOW}← OVERRIDDEN${RESET}`
    : "";
  lines.push(`  ${DIM}${toolsLabel}:${RESET} ${toolsStr}${overrideMarker}`);

  const modelStr = agent.model ?? `${DIM}(inherited from default)${RESET}`;
  lines.push(`  ${DIM}Model:${RESET} ${modelStr}`);

  const skillsStr = agent.skills.length > 0 ? agent.skills.join(", ") : `${DIM}—${RESET}`;
  lines.push(`  ${DIM}Skills:${RESET} ${skillsStr}`);

  if (agent.context) {
    lines.push(`  ${DIM}Context:${RESET} ${agent.context}`);
  }

  return lines;
}

function formatOverview(): string {
  const overrides = readOverrides();
  const builtins = readBuiltinAgents();
  const users = readUserAgents();

  const lines: string[] = [];

  lines.push("╔══════════════════════════════════════════════════════════╗");
  lines.push(`${CYAN}║                    Subagents Overview                   ║${RESET}`);
  lines.push("╚══════════════════════════════════════════════════════════╝");
  lines.push("");

  // ── Builtin Agents ──
  lines.push(`${BOLD}${CYAN}🏗️  BUILTIN AGENTS${RESET}`);
  lines.push("");
  for (const agent of builtins) {
    lines.push(...formatAgentBlock(agent, overrides));
    lines.push("");
  }

  // ── User Agents ──
  lines.push(`${BOLD}${CYAN}👤  USER AGENTS${RESET}`);
  lines.push("");

  if (users.length === 0) {
    lines.push("  No user agents configured.");
    lines.push("");
  } else {
    const videographer = users.find((a) => a.name === "videographer");
    const others = users.filter((a) => a.name !== "videographer");

    if (videographer) {
      lines.push(...formatAgentBlock(videographer, overrides));
      lines.push("");
    }

    if (others.length > 0) {
      const notable = others.filter(
        (a) =>
          a.tools.length > 0 &&
          !(a.tools.length === 1 && a.tools[0] === "read"),
      );
      const shown = notable.length > 3 ? notable.slice(0, 3) : notable;

      for (const agent of shown) {
        lines.push(...formatAgentBlock(agent, overrides));
        lines.push("");
      }

      const remaining =
        others.length - (videographer ? 0 : 0) - shown.length;
      if (remaining > 0) {
        lines.push(
          `  ... and ${remaining} more user agent(s) (run \`subagent({ action: "list" })\` to see all)`,
        );
        lines.push("");
      }
    }
  }

  // ── Active Overrides ──
  const overrideKeys = Object.keys(overrides);
  lines.push(`${BOLD}${YELLOW}🔧  ACTIVE SETTINGS OVERRIDES${RESET}`);
  lines.push("");

  if (overrideKeys.length === 0) {
    lines.push(`  ${DIM}No overrides configured.${RESET}`);
  } else {
    for (const [agentName, ov] of Object.entries(overrides)) {
      const overriddenFields = Object.entries(ov)
        .filter(([_key, val]) => val !== undefined && val !== null && val !== false)
        .map(([key, val]) => {
          if (Array.isArray(val)) return `    ${DIM}${key}:${RESET} ${val.join(", ")}`;
          return `    ${DIM}${key}:${RESET} ${String(val)}`;
        });
      if (overriddenFields.length > 0) {
        lines.push(`  ${BOLD}${agentName}${RESET}`);
        lines.push(...overriddenFields);
        lines.push("");
      }
    }
  }

  // ── Quick Stats ──
  lines.push(`${BOLD}${GREEN}📊  QUICK STATS${RESET}`);
  lines.push("");

  const totalAgents = builtins.length + users.length;
  lines.push(`  Total agents: ${BOLD}${totalAgents}${RESET}`);
  lines.push(`    ${BLUE}${builtins.length}${RESET} builtin  |  ${BLUE}${users.length}${RESET} user`);

  // Agents with execution tools (applying overrides from settings.json)
  const execTools = ["bash", "safe_bash"];
  const allAgents = [...builtins, ...users];
  const agentsWithExec = allAgents.filter((a) =>
    getEffectiveTools(a, overrides).some((t) => execTools.includes(t)),
  );
  const agentsWithSafeBash = allAgents.filter((a) =>
    getEffectiveTools(a, overrides).includes("safe_bash") &&
    !getEffectiveTools(a, overrides).includes("bash"),
  );
  const agentsWithPlainBash = allAgents.filter((a) =>
    getEffectiveTools(a, overrides).includes("bash"),
  );

  lines.push(
    `  ${GREEN}🔒${RESET} safe_bash enforced: ${BOLD}${agentsWithSafeBash.map((a) => a.name).join(", ") || "none"}${RESET}`,
  );
  lines.push(
    `  ${RED}⚠${RESET} plain bash (not restricted): ${BOLD}${agentsWithPlainBash.map((a) => a.name).join(", ") || "none"}${RESET}`,
  );

  const allSkills = [...builtins, ...users].flatMap((a) => a.skills);
  const uniqueSkills = [...new Set(allSkills)].filter(Boolean);
  const hasYoutube = uniqueSkills.includes("youtube-analysis");
  lines.push(
    `  Skills referenced by agents: ${uniqueSkills.length} (youtube-analysis: ${hasYoutube ? "✅" : "❌"})`,
  );

  lines.push("");
  lines.push(`${DIM}${'─'.repeat(56)}${RESET}`);
  lines.push(
    `  ${DIM}* Tools marked with ← OVERRIDDEN have been modified via settings.json.${RESET}`,
  );

  return lines.join("\n");
}

// ── Extension ──────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Register a renderer for the custom message type
  pi.registerMessageRenderer("subagent-overview", (message, _options, _theme) => {
    const content = typeof message.content === "string" ? message.content : "";
    const lines = content.split("\n");

    return {
      render: (width: number) =>
        lines.map((line) => {
          const vw = visibleWidth(line);
          if (vw <= width) return line;
          return truncateToWidth(line, width);
        }),
      invalidate: () => {},
    };
  });

  // ── Commands ──

  pi.registerCommand("subagents-overview", {
    description: "Show a clean overview of all subagents with tools, models, overrides, and stats",
    handler: async (_args, _ctx) => {
      const overview = formatOverview();
      pi.sendMessage(
        {
          customType: "subagent-overview",
          content: overview,
          display: true,
        },
        { triggerTurn: false },
      );
    },
  });

  pi.registerCommand("subagent-view", {
    description: "Show details for a specific subagent: /subagent-view <name>",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] => {
      const builtins = readBuiltinAgents();
      const users = readUserAgents();
      const allAgents = [...builtins, ...users];

      const lowerPrefix = prefix.toLowerCase();
      return allAgents
        .filter((a) => a.name.toLowerCase().includes(lowerPrefix))
        .map((a) => ({
          value: a.name,
          label: a.name,
          description: `${a.source} — ${a.description.substring(0, 60)}`,
        }))
        .slice(0, 30);
    },
    handler: async (args, _ctx) => {
      const name = args.trim();
      if (!name) {
        pi.sendMessage(
          {
            customType: "subagent-overview",
            content:
              "Usage: /subagent-view <name>\nExample: /subagent-view worker\n\nRun /subagents-overview to see all available agents.",
            display: true,
          },
          { triggerTurn: false },
        );
        return;
      }

      const overrides = readOverrides();
      const allAgents = [...readBuiltinAgents(), ...readUserAgents()];
      const agent = allAgents.find((a) => a.name === name);

      if (!agent) {
        pi.sendMessage(
          {
            customType: "subagent-overview",
            content: `Agent "${name}" not found.\nRun /subagents-overview to see all available agents.`,
            display: true,
          },
          { triggerTurn: false },
        );
        return;
      }

      const lines: string[] = [];
      lines.push("╔══════════════════════════════════════════════╗");
      lines.push(`${CYAN}║  Agent: ${BOLD}${agent.name.padEnd(37)}${RESET}${CYAN}║${RESET}`);
      lines.push("╚══════════════════════════════════════════════╝");
      lines.push("");
      lines.push(`  ${DIM}Description:${RESET} ${agent.description}`);
      lines.push(`  ${DIM}Source:${RESET} ${agent.source}`);

      // Show effective tools (with overrides applied)
      const effectiveTools = getEffectiveTools(agent, overrides);
      const override = overrides[agent.name];
      const hasOverride = override !== undefined;
      const toolsStr = effectiveTools.join(", ") || "—";
      const overrideMarker = hasOverride
        ? `  ${YELLOW}← OVERRIDDEN${RESET}`
        : "";
      lines.push(`  ${DIM}Tools:${RESET} ${toolsStr}${overrideMarker}`);

      lines.push(`  ${DIM}Model:${RESET} ${agent.model ?? `${DIM}(inherited from default)${RESET}`}`);
      lines.push(`  ${DIM}Skills:${RESET} ${agent.skills.join(", ") || `${DIM}—${RESET}`}`);
      if (agent.context) lines.push(`  ${DIM}Default context:${RESET} ${agent.context}`);

      if (hasOverride) {
        lines.push("");
        lines.push(`  ${YELLOW}🔧 Active overrides:${RESET}`);
        for (const [key, val] of Object.entries(override)) {
          if (val === undefined || val === null || val === false) continue;
          const valStr = Array.isArray(val) ? val.join(", ") : String(val);
          lines.push(`    ${DIM}${key}:${RESET} ${valStr}`);
        }
      }

      if (agent.source === "user") {
        const filePath = path.join(USER_AGENTS_DIR, `${agent.name}.md`);
        if (fs.existsSync(filePath)) {
          lines.push("");
          lines.push(`  File: ${filePath}`);
        }
      }

      pi.sendMessage(
        {
          customType: "subagent-overview",
          content: lines.join("\n"),
          display: true,
        },
        { triggerTurn: false },
      );
    },
  });

  // ── Persistent Widget ──

  // Initial update
  pi.on("session_start", async (_event, ctx) => {
    updateWidget(ctx);
  });

  // Refresh on user input and tool execution
  pi.on("input", async (_event, ctx) => {
    updateWidget(ctx);
    return { action: "continue" };
  });

  pi.on("tool_execution_end", async (_event, ctx) => {
    updateWidget(ctx);
  });

  // Clean up on shutdown
  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setWidget(WIDGET_ID, undefined);
  });
}