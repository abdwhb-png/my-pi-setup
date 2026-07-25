/**
 * Pure status-bar segment renderers, extracted from session-status-bar.ts.
 *
 * No pi runtime imports — only types — so this module is unit-testable
 * without jiti mocks. The extension wires these into fancy-footer widgets.
 */
import { visibleWidth } from '@earendil-works/pi-tui';
import type { UiColorsCreation } from './ui-colors';

export interface StatusBarState {
    workspace: { shortCwd: string; shortBranch: string };
    context: { tokens: number; window: number; percent: number };
    model: { id: string; provider?: string };
    session: { name?: string };
    cost: { totalUsd: number };
}

export type StatusBarColors = UiColorsCreation;

export function shortenMiddle(text: string, maxWidth: number): string {
    if (maxWidth <= 0) return '';
    if (visibleWidth(text) <= maxWidth) return text;
    if (maxWidth <= 3) return '.'.repeat(maxWidth);
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
    const symbol = colors.primary('$');
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
        : '';
}

export const renderPrefix = "📋session->";

export function renderSessionName(
    state: StatusBarState,
    availableWidth: number,
    colors: StatusBarColors,
): string {
    const name = state.session.name;
    if (!name) return '';
    const maxName = Math.min(20, Math.max(8, availableWidth - 1));
    return colors.meta(`${renderPrefix}${shortenMiddle(name, maxName)}`);
}

export function renderContext(
    state: StatusBarState,
    _availableWidth: number,
    colors: StatusBarColors,
): string {
    const pct = `${Math.round(state.context.percent)}%`;
    return (
        '🔋'+
        colors.pressure(pct, state.context.percent) +
        ' ' +
        colors.pressure(
            formatTokenCount(state.context.tokens),
            state.context.percent,
        ) +
        colors.separator('/') +
        colors.primary(formatTokenCount(state.context.window))
    );
}

export function renderCost(
    state: StatusBarState,
    _availableWidth: number,
    colors: StatusBarColors,
): string {
    return colors.meta(formatUsdCompact(state.cost.totalUsd, colors));
}

export function renderModel(
    state: StatusBarState,
    _availableWidth: number,
    colors: StatusBarColors,
): string {
    const provider = state.model.provider
        ? state.model.provider
        : 'no-provider';
    return colors.subtle(`(${provider}) `) + colors.model(state.model.id);
}
