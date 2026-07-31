import type { Theme } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import type { LiveRun, LiveRunSnapshot } from './fleet-store.ts';

const MAX_WIDGET_LINES = 5;
const COMPLETION_LINGER_MS = 5_000;

function pad(content: string, width: number): string {
    const safe = truncateToWidth(content, width, '');
    return `${safe}${' '.repeat(Math.max(0, width - visibleWidth(safe)))}`;
}

function frameRule(
    left: string,
    right: string,
    label: string,
    width: number,
    theme: Theme,
): string {
    const innerWidth = Math.max(1, width - 2);
    const safeLabel = truncateToWidth(label, innerWidth, '');
    const rule = `${safeLabel}${'─'.repeat(
        Math.max(0, innerWidth - visibleWidth(safeLabel)),
    )}`;
    return theme.fg('border', left) + rule + theme.fg('border', right);
}

export function formatDuration(milliseconds: number): string {
    const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m${seconds % 60}s`;
}

export function formatTokens(tokens: number): string {
    if (tokens < 1_000) return `${tokens}t`;
    if (tokens < 10_000) return `${(tokens / 1_000).toFixed(1)}kt`;
    return `${Math.round(tokens / 1_000)}kt`;
}

function active(run: LiveRun): boolean {
    return run.source === 'fleet' || run.state === 'running';
}

function visibleRuns(snapshot: LiveRunSnapshot, now: number): LiveRun[] {
    return snapshot.runs.filter(
        (run) =>
            active(run) ||
            (run.source === 'async' &&
                run.completedAt !== undefined &&
                now - run.completedAt <= COMPLETION_LINGER_MS),
    );
}

export function hasVisibleLiveRuns(
    snapshot: LiveRunSnapshot,
    now = Date.now(),
): boolean {
    return visibleRuns(snapshot, now).length > 0;
}

function statusDot(run: LiveRun, theme: Theme): string {
    if (run.source === 'fleet' || run.state === 'running') {
        return theme.fg('accent', '●');
    }
    if (run.state === 'complete') return theme.fg('success', '✓');
    if (run.state === 'failed') return theme.fg('error', '✕');
    return theme.fg('warning', '■');
}

function renderRun(run: LiveRun, theme: Theme, width: number, now: number): string {
    const innerWidth = Math.max(1, width - 2);
    const durationEnd =
        run.source === 'async' && run.completedAt !== undefined
            ? run.completedAt
            : now;
    const metadata = `${formatDuration(durationEnd - run.startedAt)} · ${formatTokens(run.tokens.total)}`;
    const label = `${statusDot(run, theme)} ${theme.bold(run.agent)}${run.role ? `:${run.role}` : ''}`;
    const goal = run.goal ? ` — ${run.goal}` : '';
    const reserved = visibleWidth(metadata) + 1;
    const left = truncateToWidth(
        `${label}${goal}`,
        Math.max(1, innerWidth - reserved),
        '…',
    );
    const spaces = ' '.repeat(
        Math.max(1, innerWidth - visibleWidth(left) - visibleWidth(metadata)),
    );
    return (
        theme.fg('border', '│') +
        pad(`${left}${spaces}${theme.fg('dim', metadata)}`, innerWidth) +
        theme.fg('border', '│')
    );
}

export function renderLiveWidget(
    snapshot: LiveRunSnapshot,
    theme: Theme,
    width: number,
    now = Date.now(),
): string[] {
    const safeWidth = Math.max(20, width);
    const runs = visibleRuns(snapshot, now);
    if (runs.length === 0) return [];
    const bodyLimit = MAX_WIDGET_LINES - 2;
    const shown = runs.slice(0, bodyLimit);
    const overflow = snapshot.omitted + Math.max(0, runs.length - shown.length);
    const activeCount = runs.filter(active).length;
    return [
        frameRule(
            '╭',
            '╮',
            ` ${theme.fg('accent', '👥 Subagents Live')} · ${activeCount} active `,
            safeWidth,
            theme,
        ),
        ...shown.map((run) => renderRun(run, theme, safeWidth, now)),
        frameRule(
            '╰',
            '╯',
            ` /subagents-overview${overflow > 0 ? ` · +${overflow} more` : ''} `,
            safeWidth,
            theme,
        ),
    ];
}
