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

  // Agents with safe_bash only (no plain bash)
  const safeBashAgents = [...builtins, ...users]
    .filter((a) => a.tools.includes("safe_bash") && !a.tools.includes("bash"))
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
  lines.push(`${paddedName}${agent.description}`);

  const toolsLabel = hasOverride ? "Tools*" : "Tools";
  const toolsStr = agent.tools.length > 0 ? agent.tools.join(", ") : "—";
  const overrideMarker = hasOverride ? "  ← OVERRIDDEN" : "";
  lines.push(`  ${toolsLabel}: ${toolsStr}${overrideMarker}`);

  const modelStr = agent.model ?? "(inherited from default)";
  lines.push(`  Model: ${modelStr}`);

  const skillsStr = agent.skills.length > 0 ? agent.skills.join(", ") : "—";
  lines.push(`  Skills: ${skillsStr}`);

  if (agent.context) {
    lines.push(`  Context: ${agent.context}`);
  }

  return lines;
}

function formatOverview(): string {
  const overrides = readOverrides();
  const builtins = readBuiltinAgents();
  const users = readUserAgents();

  const lines: string[] = [];

  lines.push("╔══════════════════════════════════════════════════════════╗");
  lines.push("║                    Subagents Overview                   ║");
  lines.push("╚══════════════════════════════════════════════════════════╝");
  lines.push("");

  // ── Builtin Agents ──
  lines.push("🏗️  BUILTIN AGENTS");
  lines.push("");
  for (const agent of builtins) {
    lines.push(...formatAgentBlock(agent, overrides));
    lines.push("");
  }

  // ── User Agents ──
  lines.push("👤  USER AGENTS");
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
  lines.push("🔧  ACTIVE SETTINGS OVERRIDES");
  lines.push("");

  if (overrideKeys.length === 0) {
    lines.push("  No overrides configured.");
  } else {
    for (const [agentName, ov] of Object.entries(overrides)) {
      const overriddenFields = Object.entries(ov)
        .filter(([_key, val]) => val !== undefined && val !== null && val !== false)
        .map(([key, val]) => {
          if (Array.isArray(val)) return `    ${key}: ${val.join(", ")}`;
          return `    ${key}: ${String(val)}`;
        });
      if (overriddenFields.length > 0) {
        lines.push(`  ${agentName}`);
        lines.push(...overriddenFields);
        lines.push("");
      }
    }
  }

  // ── Quick Stats ──
  lines.push("📊  QUICK STATS");
  lines.push("");

  const totalAgents = builtins.length + users.length;
  lines.push(`  Total agents: ${totalAgents}`);
  lines.push(`    Builtin: ${builtins.length}  |  User: ${users.length}`);

  const execTools = ["bash", "safe_bash"];
  const agentsWithExec = [...builtins, ...users].filter((a) =>
    a.tools.some((t) => execTools.includes(t)),
  );
  const agentsWithSafeBash = [...builtins, ...users].filter((a) =>
    a.tools.includes("safe_bash"),
  );
  const agentsWithPlainBash = agentsWithExec.filter((a) =>
    a.tools.includes("bash"),
  );

  lines.push(
    `  Agents with execution tools: ${agentsWithExec.map((a) => a.name).join(", ") || "none"}`,
  );
  lines.push(
    `  Agents with safe_bash only (no plain bash): ${agentsWithSafeBash
      .filter((a) => !a.tools.includes("bash"))
      .map((a) => a.name)
      .join(", ") || "none"}`,
  );
  lines.push(
    `  Agents with plain bash (not restricted): ${agentsWithPlainBash.map((a) => a.name).join(", ") || "none"}`,
  );

  const allSkills = [...builtins, ...users].flatMap((a) => a.skills);
  const uniqueSkills = [...new Set(allSkills)].filter(Boolean);
  const hasYoutube = uniqueSkills.includes("youtube-analysis");
  lines.push(
    `  Skills referenced by agents: ${uniqueSkills.length} (youtube-analysis: ${hasYoutube ? "✅" : "❌"})`,
  );

  lines.push("");
  lines.push("─".repeat(56));
  lines.push(
    "  * Tools marked with ← OVERRIDDEN have been modified via settings.json.",
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
      lines.push(`║  Agent: ${agent.name.padEnd(37)}║`);
      lines.push("╚══════════════════════════════════════════════╝");
      lines.push("");
      lines.push(`  Description: ${agent.description}`);
      lines.push(`  Source: ${agent.source}`);
      lines.push(`  Tools: ${agent.tools.join(", ") || "—"}`);
      lines.push(`  Model: ${agent.model ?? "(inherited from default)"}`);
      lines.push(`  Skills: ${agent.skills.join(", ") || "—"}`);
      if (agent.context) lines.push(`  Default context: ${agent.context}`);

      const override = overrides[agent.name];
      if (override) {
        lines.push("");
        lines.push("  🔧 Active overrides:");
        for (const [key, val] of Object.entries(override)) {
          if (val === undefined || val === null || val === false) continue;
          const valStr = Array.isArray(val) ? val.join(", ") : String(val);
          lines.push(`    ${key}: ${valStr}`);
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