/**
 * Subagents Overview — /subagents-overview command + persistent widget
 *
 * Fully programmatic. No LLM involvement.
 * Reads agent configs, settings overrides, parses frontmatter,
 * and renders the overview directly into the conversation.
 * Also shows a persistent status widget in the Pi UI.
 *
 * Handles agent discovery filtering:
 * - Excludes `.agents/skills/` subdirectory (skill files aren't agents)
 * - Intercepts subagent({ action: "list" }) tool results to filter
 *   skill-derived agents from the LLM-visible agent list
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
const RESET = "\x1b[0m"

const WIDGET_ID = "pi-subagents-overview-widget";

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
const PROJECT_AGENTS_DIR = path.join(HOME, ".agents");
const SKILLS_DIR = path.join(HOME, ".agents", "skills");

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

// ── Skill Agent Names ─────────────────────────────────
// Cache of agent names derived from `.agents/skills/` files.
// These are skill reference docs, not real agents.

let cachedSkillAgentNames: Set<string> | null = null;

function getSkillAgentNames(): Set<string> {
  if (cachedSkillAgentNames) return cachedSkillAgentNames;

  const names = new Set<string>();

  if (!fs.existsSync(SKILLS_DIR)) {
    cachedSkillAgentNames = names;
    return names;
  }

  function walkDir(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (!entry.name.endsWith(".md")) continue;

      const fm = parseAgentFile(fullPath);
      if (fm && fm.name && fm.description) {
        names.add(fm.name);
      }
    }
  }

  walkDir(SKILLS_DIR);
  cachedSkillAgentNames = names;
  return names;
}

function clearSkillAgentCache(): void {
  cachedSkillAgentNames = null;
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

    agents.push({
      name: fm.name || name,
      description: fm.description || "",
      tools,
      model: fm.model || null,
      skills: [],
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

    agents.push({
      name: fm.name || entry.replace(/\.md$/, ""),
      description: fm.description || "",
      tools: (fm.tools || "").split(",").map((t) => t.trim()).filter(Boolean),
      model: fm.model || null,
      skills: (fm.skills || "").split(",").map((s) => s.trim()).filter(Boolean),
      source: "user",
      context: fm.defaultContext || null,
    });
  }

  return agents;
}

/**
 * Read project agents from `.agents/` directory, EXCLUDING the `skills/`
 * subdirectory (those are skill definitions, not agents).
 */
function readProjectAgents(): AgentInfo[] {
  const agents: AgentInfo[] = [];
  if (!fs.existsSync(PROJECT_AGENTS_DIR)) return agents;

  function walkDir(dir: string, depth: number): void {
    if (depth > 5) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      // Skip the skills/ subdirectory entirely
      if (entry.isDirectory()) {
        if (entry.name === "skills" && dir === PROJECT_AGENTS_DIR) continue;
        walkDir(fullPath, depth + 1);
        continue;
      }

      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (!entry.name.endsWith(".md")) continue;

      const fm = parseAgentFile(fullPath);
      if (!fm || !fm.name || !fm.description) continue;

      agents.push({
        name: fm.name,
        description: fm.description || "",
        tools: (fm.tools || "").split(",").map((t) => t.trim()).filter(Boolean),
        model: fm.model || null,
        skills: (fm.skills || "").split(",").map((s) => s.trim()).filter(Boolean),
        source: "project",
        context: fm.defaultContext || null,
      });
    }
  }

  walkDir(PROJECT_AGENTS_DIR, 0);
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
  lines.push(
    `  ${DIM}* Skill-derived agents (from .agents/skills/) are hidden from the LLM list.${RESET}`,
  );

  return lines.join("\n");
}

// ── Tool Result Interception ──────────────────────────

/**
 * Build a regex pattern that matches lines containing skill-derived agent names
 * in the subagent list output.
 * Pattern matches lines like: "- agent-name (project):" or "- agent-name (user):"
 */
function buildSkillAgentFilterPattern(skillNames: Set<string>): RegExp | null {
  if (skillNames.size === 0) return null;

  // Escape special regex characters in agent names
  const escapedNames: string[] = [];
  for (const name of skillNames) {
    escapedNames.push(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  }

  // Match lines that start with "- <name> (" (the subagent list format)
  const pattern = `^- (${escapedNames.join("|")})\\s*\\(`;
  return new RegExp(pattern, "m");
}

// ── Extension ──────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Register a renderer for the custom message type
  pi.registerMessageRenderer("pi-subagents-overview", (message, _options, _theme) => {
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

  // ── Intercept subagent tool results ──

  pi.on("tool_result", (event) => {
    // Check if this is the subagent tool's list action
    // CustomToolResultEvent has toolName: string
    const ev = event as Record<string, unknown>;
    if (ev.toolName !== "subagent") return;

    const input = ev.input as Record<string, unknown> | undefined;
    if (!input || input.action !== "list") return;

    const content = ev.content as Array<Record<string, unknown>> | undefined;
    if (!content || content.length === 0) return;

    const skillNames = getSkillAgentNames();
    if (skillNames.size === 0) return;

    const filterPattern = buildSkillAgentFilterPattern(skillNames);
    if (!filterPattern) return;

    const filteredContent = content.map((entry) => {
      if (entry.type !== "text") return entry;

      const text = entry.text as string;
      if (!text.includes("(project)") && !text.includes("(user)")) {
        return entry; // Only filter list entries with scope markers
      }

      // Filter out lines matching skill-derived agent names
      const lines = text.split("\n");
      const filteredLines = lines.filter((line) => {
        const trimmed = line.trim();
        // Check if line matches "- <skill-agent-name> ("
        return !filterPattern.test(trimmed);
      });

      return { ...entry, text: filteredLines.join("\n") };
    });

    return { content: filteredContent };
  });

  // ── Commands ──

  pi.registerCommand("subagents-overview", {
    description: "Show a clean overview of all subagents with tools, models, overrides, and stats",
    handler: async (_args, _ctx) => {
      const overview = formatOverview();
      pi.sendMessage(
        {
          customType: "pi-subagents-overview",
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
            customType: "pi-subagents-overview",
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
            customType: "pi-subagents-overview",
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
      lines.push(`  ${DIM}Tools:${RESET} ${getEffectiveTools(agent, overrides).join(", ") || "—"}`);
      lines.push(`  ${DIM}Model:${RESET} ${agent.model ?? `${DIM}(inherited from default)${RESET}`}`);
      lines.push(`  ${DIM}Skills:${RESET} ${agent.skills.join(", ") || `${DIM}—${RESET}`}`);
      if (agent.context) lines.push(`  ${DIM}Default context:${RESET} ${agent.context}`);

      const override = overrides[agent.name];
      if (override) {
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
          customType: "pi-subagents-overview",
          content: lines.join("\n"),
          display: true,
        },
        { triggerTurn: false },
      );
    },
  });

  // ── Persistent Widget ──

  pi.on("session_start", async (_event, ctx) => {
    clearSkillAgentCache();
    updateWidget(ctx);
  });

  pi.on("input", async (_event, ctx) => {
    updateWidget(ctx);
    return { action: "continue" };
  });

  pi.on("tool_execution_end", async (_event, ctx) => {
    updateWidget(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.setWidget(WIDGET_ID, undefined);
  });
}