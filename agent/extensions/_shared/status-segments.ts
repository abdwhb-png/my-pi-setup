/**
 * Pure status-bar segment renderers, extracted from session-status-bar.ts.
 *
 * No pi runtime imports — only types — so this module is unit-testable
 * without jiti mocks. The extension wires these into fancy-footer widgets.
 */
import { visibleWidth } from "@earendil-works/pi-tui";
import type { UiColorsCreation } from "./ui/ui-colors";

const ARROW_DOWN = "↓";
const ARROW_UP = "↑";

export interface StatusBarState {
    workspace: { shortCwd: string; shortBranch: string };
    context: { tokens: number; window: number; percent: number };
    model: { id: string; provider?: string };
    session: { name?: string };
    cost: { totalUsd: number };
    tokens: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
    };
}

export type StatusBarColors = UiColorsCreation;

export function shortenMiddle(text: string, maxWidth: number): string {
    if (maxWidth <= 0) return "";
    if (visibleWidth(text) <= maxWidth) return text;
    if (maxWidth <= 3) return ".".repeat(maxWidth);
    const keep = maxWidth - 1;
    const left = Math.ceil(keep / 2);
    const right = Math.floor(keep / 2);
    return `${text.slice(0, left)}…${text.slice(text.length - right)}`;
}

export function formatTokenCount(n: number): string {
    if (n < 1000) return n.toString();
    if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
    if (n < 1000000) return `${Math.round(n / 1000)}k`;
    return `${(n / 1000000).toFixed(1)}M`;
}

export function formatUsdCompact(
    value: number,
    colors: StatusBarColors,
): string {
    const symbol = colors.primary("$");
    if (!Number.isFinite(value) || value <= 0) return `${symbol} 0.00`;
    if (value < 0.01) return `<${symbol} 0.01`;
    return `${symbol} ${value.toFixed(2)}`;
}

export function renderCwd(
    state: StatusBarState,
    availableWidth: number,
    colors: StatusBarColors,
): string {
    return colors.meta(shortenMiddle(state.workspace.shortCwd, availableWidth));
}

export function renderBranch(
    state: StatusBarState,
    _availableWidth: number,
    colors: StatusBarColors,
): string {
    return state.workspace.shortBranch
        ? colors.primary(state.workspace.shortBranch)
        : "";
}

export const sessionNamePrefix = "📋->";

export function renderSessionName(
    state: StatusBarState,
    availableWidth: number,
    colors: StatusBarColors,
): string {
    const name = state.session.name;
    if (!name) return "";
    const maxName = Math.min(25, Math.max(8, availableWidth - 1));
    return colors.meta(`${sessionNamePrefix}${shortenMiddle(name, maxName)}`);
}

export const buildContextContent = (
    percent: number,
    tokens: number,
    window: number,
    colors: StatusBarColors,
) => {
    const pct = `${Math.round(percent)}%`;
    const icon = percent > 80 ? "🪫" : "🔋";
    return (
        icon +
        colors.pressure(formatTokenCount(tokens), percent) +
        colors.separator("/") +
        colors.primary(formatTokenCount(window)) +
        colors.meta("(") +
        colors.meta(pct) +
        colors.meta(")")
    );
};

export function renderContext(
    state: StatusBarState,
    _availableWidth: number,
    colors: StatusBarColors,
): string {
    return buildContextContent(
        state.context.percent,
        state.context.tokens,
        state.context.window,
        colors,
    );
}

export function renderCost(
    state: StatusBarState,
    _availableWidth: number,
    colors: StatusBarColors,
): string {
    return colors.meta(formatUsdCompact(state.cost.totalUsd, colors));
}

export const buildTokenContent = (
    input: number,
    output: number,
    colors: StatusBarColors,
): string => {
    return (
        colors.primary(`in${ARROW_DOWN}`) +
        colors.muted(formatTokenCount(input)) +
        colors.separator("/") +
        colors.model(`out${ARROW_UP}`) +
        colors.muted(formatTokenCount(output))
    );
};

export const buildSessionTokenContent = (
    input: number,
    output: number,
    cacheRead: number,
    cacheWrite: number,
    colors: StatusBarColors,
): string => {
    return (
        colors.meta("Σ ") +
        buildTokenContent(input, output, colors) +
        colors.separator(" · ") +
        colors.subtle("cache R") +
        colors.muted(formatTokenCount(cacheRead)) +
        colors.separator("/") +
        colors.subtle("W") +
        colors.muted(formatTokenCount(cacheWrite))
    );
};

export function renderTokenCounts(
    state: StatusBarState,
    _availableWidth: number,
    colors: StatusBarColors,
): string {
    const { input, output, cacheRead, cacheWrite } = state.tokens;
    return buildSessionTokenContent(
        input,
        output,
        cacheRead,
        cacheWrite,
        colors,
    );
}

export function renderModel(
    state: StatusBarState,
    _availableWidth: number,
    colors: StatusBarColors,
): string {
    const provider = state.model.provider
        ? state.model.provider
        : "no-provider";
    return colors.subtle(`(${provider}) `) + colors.model(state.model.id);
}
