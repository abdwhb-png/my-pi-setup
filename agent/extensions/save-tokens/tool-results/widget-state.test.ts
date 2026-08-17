import { describe, expect, it } from 'bun:test';
import {
    createCompressionMetrics,
    createCompressionMetricsFromEvents,
    deriveRecentState,
    formatStatsWidgetLines,
} from './metrics';

// ---------------------------------------------------------------------------
// Task 10 — the widget shows the active engine (not a base URL) and its
// derived state comes from bounded recent observations, never health polling.
// ---------------------------------------------------------------------------

describe('Task 10 widget engine and derived state', () => {
    it('widget shows the active engine, not the base URL', () => {
        const metrics = createCompressionMetrics();
        metrics.record({
            kind: 'compressed',
            toolName: 'read',
            originalLength: 100,
            compressedLength: 40,
        });

        const lines = formatStatsWidgetLines(metrics.snapshot(), 'headroom');

        expect(lines[0]).toBe('compressor headroom');
        expect(lines[0]).not.toContain('http');
    });

    it('derives widget state from recent observations', () => {
        const metrics = createCompressionMetrics();
        metrics.record({
            kind: 'compressed',
            toolName: 'read',
            originalLength: 100,
            compressedLength: 40,
            latencyMs: 20,
        });
        metrics.record({
            kind: 'failed',
            toolName: 'bash',
            originalLength: 50,
            compressedLength: 0,
            latencyMs: 1000,
        });

        const snapshot = metrics.snapshot();
        expect(snapshot.recentCalls).toHaveLength(2);

        const state = deriveRecentState(snapshot.recentCalls);
        expect(state).toMatchObject({
            ok: 1,
            skipped: 0,
            failed: 1,
            savedBytes: 60,
            avgLatencyMs: 510,
        });

        const lineTwo = formatStatsWidgetLines(snapshot, 'headroom')[1];
        expect(lineTwo).toContain('ok 1');
        expect(lineTwo).toContain('fail 1');
        expect(lineTwo).toContain('avg 510ms');
    });

    it('bounds recent-call state and drops the oldest calls', () => {
        const metrics = createCompressionMetrics();
        for (let i = 0; i < 25; i++) {
            metrics.record({
                kind: 'skipped',
                toolName: 'read',
                originalLength: 10,
                compressedLength: 0,
            });
        }

        const snapshot = metrics.snapshot();
        expect(snapshot.recentCalls).toHaveLength(20);
        // Oldest dropped: the first recorded call (kind skipped, idx 0) is gone.
        expect(snapshot.recentCalls[0]?.originalLength).toBe(10);
    });

    it('clears recent-call state on reset', () => {
        const metrics = createCompressionMetrics();
        metrics.record({
            kind: 'compressed',
            toolName: 'read',
            originalLength: 100,
            compressedLength: 40,
        });

        metrics.reset();

        expect(metrics.snapshot().recentCalls).toEqual([]);
        expect(formatStatsWidgetLines(metrics.snapshot(), 'headroom')[1]).toBe(
            'no calls yet',
        );
    });

    it('rebuilds recent-call state from persisted enriched events', () => {
        const metrics = createCompressionMetricsFromEvents([
            {
                toolCallId: 'a',
                toolName: 'read',
                timestamp: 1,
                kind: 'compressed',
                originalLength: 100,
                compressedLength: 40,
                savedBytes: 60,
                savedPct: 60,
                latencyMs: 30,
            },
        ]);

        expect(metrics.snapshot().recentCalls).toEqual([
            {
                kind: 'compressed',
                toolName: 'read',
                originalLength: 100,
                compressedLength: 40,
                latencyMs: 30,
            },
        ]);
    });
});
