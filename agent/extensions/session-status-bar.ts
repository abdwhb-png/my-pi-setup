/**
 * Session Status Bar Extension
 *
 * Shows a compact session status line via ctx.ui.setWidget().
 * Reads git branch, model, context usage, cost, and session name.
 *
 * Extension statuses are now handled by the built-in extension-statuses widget
 * in pi-fancy-footer (rendered above the editor).
 *
 * Originally forked from aldoborrero/pi-agent-kit footer.ts, converted from
 * ctx.ui.setFooter() to ctx.ui.setWidget() so it works alongside pi-fancy-footer.
 *
 * Config: ~/.pi/agent/session-status-bar.json
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path";
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { getBranch } from "../_shared/git-helper";
import { createWidget } from "../_shared/fancy-footer";
import {
  type UiColorsCreation,
  createUiColors,
  DEFAULT_ERROR_PERCENT,
  DEFAULT_WARNING_PERCENT,
} from "../_shared/ui-colors";

// ── Types ──────────────────────────────────────────────────────────────

const WIDGET_ID = "session-status-bar";
const DEFAULT_REFRESH_MS = 3000;
const MIN_LEFT_SPACE = 12;
const MAX_BRANCH_WIDTH = 18;

type StatusBarState = {
  workspace: { shortCwd: string; shortBranch: string };
  context: { tokens: number; window: number; percent: number };
  model: { id: string };
  session: { name?: string };
  cost: { totalUsd: number };
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
  refreshMs: DEFAULT_REFRESH_MS,
};

// ── Config ──────────────────────────────────────────────────────────────

function getConfigPath(): string {
  return join(getAgentDir(), "session-status-bar.json");
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

function shortenMiddle(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(text) <= maxWidth) return text;
  if (maxWidth <= 3) return ".".repeat(maxWidth);
  const keep = maxWidth - 1;
  const left = Math.ceil(keep / 2);
  const right = Math.floor(keep / 2);
  return `${text.slice(0, left)}…${text.slice(text.length - right)}`;
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

// ── State building ──────────────────────────────────────────────────────

function isSessionMessageEntry(e: SessionEntry): e is SessionMessageEntry {
  return e.type === "message";
}

function buildState(
  ctx: ExtensionContext,
  branchName: string | null,
  config: StatusBarConfig,
): StatusBarState {
  const messages = ctx.sessionManager.getBranch()
    .filter(isSessionMessageEntry)
    .map((e) => e.message as AssistantMessage)
    .filter((m) => m.stopReason !== "aborted");

  const lastMessage = messages[messages.length - 1];
  const totalUsd = messages.reduce(
    (sum, m) => sum + (m.usage?.cost?.total ?? 0), 0,
  );

  const contextTokens = lastMessage?.usage
    ? lastMessage.usage.input + lastMessage.usage.output +
      lastMessage.usage.cacheRead + lastMessage.usage.cacheWrite
    : 0;
  const contextWindow = ctx.model?.contextWindow || 0;
  const percent = contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0;

  const cwd = ctx.cwd;
  const home = process.env.HOME || "";
  const shortCwd = home && cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd;

  const branch = config.showBranch ? branchName : null;
  const shortBranch = branch ? shortenMiddle(branch, MAX_BRANCH_WIDTH) : "";

  return {
    workspace: { shortCwd, shortBranch },
    context: { tokens: contextTokens, window: contextWindow, percent },
    model: { id: ctx.model?.id || "no-model" },
    session: { name: ctx.sessionManager.getSessionName() },
    cost: { totalUsd },
  };
}

// ── Rendering ───────────────────────────────────────────────────────────

function buildRightSide(
  state: StatusBarState,
  config: StatusBarConfig,
  colors: UiColorsCreation,
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

  if (config.showCost && state.cost.totalUsd >= 0) {
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
  colors: UiColorsCreation,
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
  colors: UiColorsCreation,
): string {
  const right = buildRightSide(state, config, colors);
  const rightWidth = visibleWidth(right);
  const availableLeft = Math.max(0, width - rightWidth - 1);

  if (availableLeft <= MIN_LEFT_SPACE) return truncateToWidth(right, width);

  const identity = buildLeftIdentity(state, availableLeft, config, colors);
  let left = identity.left;
  let leftWidth = identity.width;

  const pad = " ".repeat(Math.max(1, width - leftWidth - rightWidth));
  return truncateToWidth(left + pad + right, width);
}

function renderTwoLine(
  state: StatusBarState,
  width: number,
  config: StatusBarConfig,
  colors: UiColorsCreation,
): string[] {
  const right = buildRightSide(state, config, colors);
  const rightWidth = visibleWidth(right);
  const availableLeft = Math.max(0, width - rightWidth - 1);

  if (availableLeft <= MIN_LEFT_SPACE) return [truncateToWidth(right, width)];

  const identity = buildLeftIdentity(state, availableLeft, config, colors);
  const pad = " ".repeat(Math.max(1, width - identity.width - rightWidth));
  const firstLine = truncateToWidth(identity.left + pad + right, width);

  return [firstLine];
}

// ── Extension ───────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let config = DEFAULT_CONFIG;
  let latestCtx: ExtensionContext | null = null;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let widgetText: string | null = null;

  const w = createWidget(pi, {
    id: WIDGET_ID,
    label: "Status",
    description: "Session status bar with context, cost, model, cwd, git branch, and session name.",
    row: 0,
    order: 0,
    align: "left",
    grow: true,
    render: () => widgetText,
  });

  async function buildWidgetText(ctx: ExtensionContext): Promise<string | null> {
    const colors = createUiColors(ctx.ui.theme);
    if (!config.enabled) return colors.warning("Session Status Bar disabled in config");
    const branchName = await getBranch(ctx.cwd).catch(() => null);
    const state = buildState(ctx, branchName, config);
    const width = process.stdout.columns || 120;
    if (config.twoLine) {
      return renderTwoLine(state, width, config, colors).join("\n");
    }
    return renderCompact(state, width, config, colors);
  }

  async function updateWidget() {
    if (!latestCtx?.hasUI) return;
    try {
      config = loadConfig();
      widgetText = await buildWidgetText(latestCtx);
    } catch {
      widgetText = null;
    }
    w.update(latestCtx);
  }

  pi.on("session_start", async (_event, ctx) => {
    latestCtx = ctx;
    config = loadConfig();
    if (!config.enabled || !ctx.hasUI) return;

    updateWidget();
    if (refreshTimer) clearInterval(refreshTimer);
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
    latestCtx = null;
  });
}
