/**
 * Session Status Bar Extension
 *
 * Shows a compact session status line via ctx.ui.setWidget().
 * Reads extension statuses, git branch, model, context usage, cost, and session name.
 *
 * Originally forked from aldoborrero/pi-agent-kit footer.ts, converted from
 * ctx.ui.setFooter() to ctx.ui.setWidget() so it works alongside pi-fancy-footer.
 *
 * Config: ~/.pi/agent/session-status-bar.json
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { createWidget } from "../_shared/fancy-footer";
import {
  createUiColors,
  DEFAULT_ERROR_PERCENT,
  DEFAULT_WARNING_PERCENT,
} from "../_shared/ui-colors";

// ── Types ──────────────────────────────────────────────────────────────

const ANSI_REGEX = /\x1b\[[0-9;]*m/g;
const WIDGET_ID = "session-status-bar";
const DEFAULT_REFRESH_MS = 3000;
const MIN_LEFT_SPACE = 12;
const MAX_BRANCH_WIDTH = 18;

type StatusPriority = "error" | "warning" | "info";

type StatusBarState = {
  workspace: { shortCwd: string; shortBranch: string };
  context: { tokens: number; window: number; percent: number };
  model: { id: string };
  session: { name?: string };
  cost: { totalUsd: number };
  statuses: Array<{ raw: string; text: string; priority: StatusPriority }>;
};

type StatusBarConfig = {
  enabled: boolean;
  twoLine: boolean;
  showContext: boolean;
  showCost: boolean;
  showModel: boolean;
  showCwd: boolean;
  showBranch: boolean;
  showSessionName: boolean;
  showExtensionStatuses: boolean;
  refreshMs: number;
};

const DEFAULT_CONFIG: StatusBarConfig = {
  enabled: true,
  twoLine: false,
  showContext: true,
  showCost: true,
  showModel: true,
  showCwd: true,
  showBranch: true,
  showSessionName: true,
  showExtensionStatuses: true,
  refreshMs: DEFAULT_REFRESH_MS,
};

// ── Config ──────────────────────────────────────────────────────────────

function getConfigPath(): string {
  const agentDir = process.env.PI_AGENT_DIR || join(process.env.HOME || "/home", ".pi", "agent");
  return join(agentDir, "session-status-bar.json");
}

function loadConfig(): StatusBarConfig {
  const path = getConfigPath();
  if (!existsSync(path)) return { ...DEFAULT_CONFIG };
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    return { ...DEFAULT_CONFIG, ...raw };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

// ── Text helpers ────────────────────────────────────────────────────────

function sanitizeStatusText(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "");
}

function shortenMiddle(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(text) <= maxWidth) return text;
  if (maxWidth <= 3) return ".".repeat(maxWidth);
  const keep = maxWidth - 1;
  const left = Math.ceil(keep / 2);
  const right = Math.floor(keep / 2);
  return `${text.slice(0, left)}…${text.slice(text.length - right)}`;
}

function classifyStatus(text: string): StatusPriority {
  const normalized = text.toLowerCase();
  if (
    normalized.includes("error") ||
    normalized.includes("missing") ||
    normalized.includes("unconfigured") ||
    normalized.includes("locked") ||
    normalized.includes("off")
  ) return "error";
  if (
    normalized.includes("warning") ||
    normalized.includes("no-key") ||
    normalized.includes("setup")
  ) return "warning";
  return "info";
}

function styleStatus(
  priority: StatusPriority,
  text: string,
  colors: ReturnType<typeof createUiColors>,
): string {
  if (priority === "error") return colors.danger(`● ${text}`);
  if (priority === "warning") return colors.warning(`! ${text}`);
  return colors.meta(text);
}

function formatTokenCount(n: number): string {
  if (n < 1000) return n.toString();
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1000000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1000000).toFixed(1)}M`;
}

function formatUsdCompact(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "$0.00";
  if (value < 0.01) return "<$0.01";
  return `$${value.toFixed(2)}`;
}

// ── Status formatting ───────────────────────────────────────────────────

function formatStatuses(
  statuses: StatusBarState["statuses"],
  maxWidth: number,
  separator: string,
  overflow: (s: string) => string,
  colors: ReturnType<typeof createUiColors>,
): string {
  if (statuses.length === 0 || maxWidth <= 0) return "";

  const ordered = [...statuses].toSorted((a, b) => {
    const rank = { error: 0, warning: 1, info: 2 } satisfies Record<StatusPriority, number>;
    return rank[a.priority] - rank[b.priority] || a.text.localeCompare(b.text);
  });

  const parts: string[] = [];
  let used = 0;

  for (let i = 0; i < ordered.length; i++) {
    const next = (parts.length === 0 ? "" : separator) + styleStatus(ordered[i].priority, ordered[i].text, colors);
    const nextWidth = visibleWidth(next);
    const remaining = ordered.length - (i + 1);
    const overflowText = remaining > 0
      ? `${parts.length > 0 ? separator : ""}${overflow(`+${remaining}`)}`
      : "";
    const overflowWidth = remaining > 0 ? visibleWidth(overflowText) : 0;

    if (used + nextWidth + overflowWidth > maxWidth) {
      const hidden = ordered.length - i;
      if (hidden > 0) {
        const compact = `${parts.length > 0 ? separator : ""}${overflow(`+${hidden}`)}`;
        if (used + visibleWidth(compact) <= maxWidth) {
          parts.push(compact);
        }
      }
      break;
    }
    parts.push(next);
    used += nextWidth;
  }
  return parts.join("");
}

// ── State building ──────────────────────────────────────────────────────

function isSessionMessageEntry(e: SessionEntry): e is SessionMessageEntry {
  return e.type === "message";
}

function buildState(
  ctx: ExtensionContext,
  footerData: {
    getGitBranch(): string | null;
    getExtensionStatuses(): ReadonlyMap<string, string>;
  },
  config: StatusBarConfig,
): StatusBarState {
  const messages = ctx.sessionManager.getBranch()
    .filter(isSessionMessageEntry)
    .map((e) => e.message as AssistantMessage)
    .filter((m) => m.stopReason !== "aborted");

  const lastMessage = messages[messages.length - 1];
  const totalUsd = messages.reduce(
    (sum, m) => sum + (m.usage.cost?.total ?? 0), 0,
  );

  const contextTokens = lastMessage
    ? lastMessage.usage.input + lastMessage.usage.output +
      lastMessage.usage.cacheRead + lastMessage.usage.cacheWrite
    : 0;
  const contextWindow = ctx.model?.contextWindow || 0;
  const percent = contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0;

  const cwd = process.cwd();
  const home = process.env.HOME || "";
  const shortCwd = home && cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd;

  const branch = config.showBranch ? footerData.getGitBranch() : null;
  const shortBranch = branch ? shortenMiddle(branch, MAX_BRANCH_WIDTH) : "";

  const statuses = config.showExtensionStatuses
    ? Array.from(footerData.getExtensionStatuses().values())
        .map((raw) => {
          const text = sanitizeStatusText(stripAnsi(raw));
          return { raw, text, priority: classifyStatus(text) };
        })
        .filter((s) => s.text.length > 0)
    : [];

  return {
    workspace: { shortCwd, shortBranch },
    context: { tokens: contextTokens, window: contextWindow, percent },
    model: { id: ctx.model?.id || "no-model" },
    session: { name: ctx.sessionManager.getSessionName() },
    cost: { totalUsd },
    statuses,
  };
}

// ── Rendering ───────────────────────────────────────────────────────────

function buildRightSide(
  state: StatusBarState,
  config: StatusBarConfig,
  colors: ReturnType<typeof createUiColors>,
): string {
  const parts: string[] = [];

  if (config.showContext) {
    const pct = `${Math.round(state.context.percent)}%`;
    parts.push(
      colors.pressure(pct, state.context.percent, DEFAULT_WARNING_PERCENT, DEFAULT_ERROR_PERCENT) +
      " " +
      colors.pressure(
        formatTokenCount(state.context.tokens),
        state.context.percent,
        DEFAULT_WARNING_PERCENT,
        DEFAULT_ERROR_PERCENT,
      ) +
      colors.separator("/") +
      colors.primary(formatTokenCount(state.context.window)),
    );
  }

  if (config.showCost && state.cost.totalUsd > 0) {
    parts.push(colors.separator(" │ ") + colors.meta(formatUsdCompact(state.cost.totalUsd)));
  }

  if (config.showModel) {
    parts.push(colors.separator(" │ ") + colors.model(state.model.id));
  }

  return parts.join("");
}

function buildLeftIdentity(
  state: StatusBarState,
  availableLeft: number,
  config: StatusBarConfig,
  colors: ReturnType<typeof createUiColors>,
): { left: string; width: number } {
  const leftParts: string[] = [];

  if (config.showCwd) {
    leftParts.push(colors.meta(shortenMiddle(state.workspace.shortCwd, availableLeft)));
  }

  let leftWidth = visibleWidth(leftParts.join(""));

  if (config.showBranch && state.workspace.shortBranch) {
    const segment = colors.separator(" │ ") + colors.primary(state.workspace.shortBranch);
    if (leftWidth + visibleWidth(segment) <= availableLeft) {
      leftParts.push(segment);
      leftWidth += visibleWidth(segment);
    }
  }

  if (config.showSessionName && state.session.name) {
    const segment = colors.separator(" │ ") + colors.meta(
      `@${shortenMiddle(state.session.name, Math.min(20, Math.max(8, availableLeft - leftWidth - 1)))}`,
    );
    if (leftWidth + visibleWidth(segment) <= availableLeft) {
      leftParts.push(segment);
      leftWidth += visibleWidth(segment);
    }
  }

  let left = leftParts.join("");
  if (visibleWidth(left) > availableLeft) {
    left = truncateToWidth(left, availableLeft);
    leftWidth = visibleWidth(left);
  }
  return { left, width: leftWidth };
}

function renderCompact(
  state: StatusBarState,
  width: number,
  config: StatusBarConfig,
  colors: ReturnType<typeof createUiColors>,
): string {
  const right = buildRightSide(state, config, colors);
  const rightWidth = visibleWidth(right);
  const availableLeft = Math.max(0, width - rightWidth - 1);

  if (availableLeft <= MIN_LEFT_SPACE) return truncateToWidth(right, width);

  const identity = buildLeftIdentity(state, availableLeft, config, colors);
  let left = identity.left;
  let leftWidth = identity.width;

  if (config.showExtensionStatuses) {
    const remaining = Math.max(0, availableLeft - leftWidth - visibleWidth(colors.separator(" │ ")));
    const statusStr = formatStatuses(state.statuses, remaining, colors.separator(" │ "), colors.meta, colors);
    if (statusStr) {
      left = identity.left + colors.separator(" │ ") + statusStr;
      left = visibleWidth(left) > availableLeft ? truncateToWidth(left, availableLeft) : left;
      leftWidth = visibleWidth(left);
    }
  }

  const pad = " ".repeat(Math.max(1, width - leftWidth - rightWidth));
  return truncateToWidth(left + pad + right, width);
}

function renderTwoLine(
  state: StatusBarState,
  width: number,
  config: StatusBarConfig,
  colors: ReturnType<typeof createUiColors>,
): string[] {
  const right = buildRightSide(state, config, colors);
  const rightWidth = visibleWidth(right);
  const availableLeft = Math.max(0, width - rightWidth - 1);

  if (availableLeft <= MIN_LEFT_SPACE) return [truncateToWidth(right, width)];

  const identity = buildLeftIdentity(state, availableLeft, config, colors);
  const pad = " ".repeat(Math.max(1, width - identity.width - rightWidth));
  const firstLine = truncateToWidth(identity.left + pad + right, width);

  if (!config.showExtensionStatuses || state.statuses.length === 0) {
    return [firstLine];
  }

  const statusLine = formatStatuses(state.statuses, width, colors.separator(" │ "), colors.meta, colors);
  return [firstLine, truncateToWidth(statusLine, width)];
}

// ── Widget renderer ─────────────────────────────────────────────────────

function buildWidgetText(
  ctx: ExtensionContext,
  footerData: {
    getGitBranch(): string | null;
    getExtensionStatuses(): ReadonlyMap<string, string>;
  },
  config: StatusBarConfig,
  colors: ReturnType<typeof createUiColors>,
): string | null {
  if (!config.enabled) return null;
  const state = buildState(ctx, footerData, config);
  const width = process.stdout.columns || 120;
  if (config.twoLine) {
    return renderTwoLine(state, width, config, colors).join("\n");
  }
  return renderCompact(state, width, config, colors);
}

// ── Extension ───────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let config = DEFAULT_CONFIG;
  let footerData: {
    getGitBranch(): string | null;
    getExtensionStatuses(): ReadonlyMap<string, string>;
    onBranchChange(cb: () => void): () => void;
  } | null = null;
  let unsubBranch: (() => void) | null = null;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let latestCtx: ExtensionContext | null = null;
  let widgetText: string | null = null;

  const w = createWidget(pi, {
    id: WIDGET_ID,
    label: "Status",
    description: "Session status bar with context, cost, model, cwd, git branch, and extension statuses.",
    row: 0,
    order: 0,
    align: "left",
    grow: true,
    render: () => widgetText,
  });

  function updateWidget() {
    if (!latestCtx?.hasUI) return;
    try {
      config = loadConfig();
      if (!footerData) {
        widgetText = null;
      } else {
        const colors = createUiColors(latestCtx.ui.theme);
        widgetText = buildWidgetText(latestCtx, footerData, config, colors);
      }
    } catch {
      widgetText = null;
    }
    w.update(latestCtx);
  }

  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;
    config = loadConfig();
    if (!config.enabled || !ctx.hasUI) return;

    // Capture FooterDataProvider via temporary setFooter, then restore
    ctx.ui.setFooter((_tui, _theme, fd) => {
      footerData = fd;
      unsubBranch = fd.onBranchChange(() => updateWidget());
      // Immediately restore the default footer — we just wanted the data provider
      ctx.ui.setFooter(undefined);
      return { dispose() {}, invalidate() {}, render: () => [] };
    });

    // Start periodic refresh
    if (refreshTimer) clearInterval(refreshTimer);
    updateWidget();
    refreshTimer = setInterval(updateWidget, config.refreshMs);
  });

  pi.on("agent_end", async (_event, ctx) => {
    latestCtx = ctx;
    updateWidget();
  });

  pi.on("session_shutdown", async (_event) => {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    if (unsubBranch) {
      unsubBranch();
      unsubBranch = null;
    }
    footerData = null;
    latestCtx = null;
  });
}
