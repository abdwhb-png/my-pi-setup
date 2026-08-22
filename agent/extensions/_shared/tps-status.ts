/**
 * Pure status renderers for the TPS tracker.
 *
 * No pi runtime imports — only the colour interface type — so this module is
 * unit-testable without jiti mocks. The extension wires these into the `tps`
 * footer status and the agent-run summary event.
 */
import { buildTokenContent } from "./status-segments.ts";
import type { StatusBarColors } from "./status-segments.ts";

export interface TpsState {
    /** Input tokens for the rendered scope: live message or cumulative agent run. */
    input: number;
    /** Output tokens of the current agent run (cumulative `usage.output`). */
    output: number;
    /** Tokens per second across the run's streamed output. */
    tps: number;
    /** Total streaming time in milliseconds. */
    elapsedMs: number;
    /** True when no usage was observed (nothing to show). */
    empty?: boolean;
}

function durLabel(colors: StatusBarColors, elapsedMs: number): string {
    return colors.subtle(`(${(elapsedMs / 1000).toFixed(1)}s)`);
}

/**
 * Live-rendered footer status shown while the model is streaming:
 * `tps tok/s · in↓ input · out↑ output · (dur)`.
 */
export function buildTpsStatus(
    state: TpsState,
    colors: StatusBarColors,
): string {
    if (state.empty) return colors.subtle("⏱ generating...");
    const pair = buildTokenContent(state.input, state.output, colors);
    const tpsLabel =
        state.tps > 0
            ? colors.primary(`${state.tps} tok/s`)
            : colors.subtle("…");
    return `${tpsLabel} · ${pair} · ${durLabel(colors, state.elapsedMs)}`;
}

/**
 * Final agent-end summary (TpsSummaryEvent text):
 * `tps tok/s · in↓ input · out↑ output · in Xs streaming`.
 */
export function buildTpsSummary(
    state: TpsState,
    colors: StatusBarColors,
): string {
    const tpsLabel =
        state.tps > 0
            ? colors.primary(`${state.tps} tok/s`)
            : colors.subtle("N/A");
    const pair = buildTokenContent(state.input, state.output, colors);
    const detail = colors.subtle(
        `in ${(state.elapsedMs / 1000).toFixed(1)}s streaming`,
    );
    return `${tpsLabel} · ${pair} · ${detail}`;
}
