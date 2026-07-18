/**
 * Tests for catalog drift reporting.
 *
 * Covers:
 *   - silent flag suppresses all output
 *   - first drift pass logs one summary line and grows the reported set
 *   - identical second pass logs nothing (dedup)
 *   - newly seen models on second pass produce a fresh single summary
 *   - missing static fallback (dynamic lacks a static id) logs even when no new ids
 */

import { afterEach, describe, expect, it, mock } from 'bun:test';
import type { ProviderModelConfig } from '@earendil-works/pi-coding-agent';
import { reportCatalogDiff, type CatalogDiffCounts } from './catalog-diff.ts';

function mkModel(id: string): ProviderModelConfig {
    return {
        id,
        name: id,
        reasoning: false,
        input: ['text'],
        contextWindow: 1000,
        maxTokens: 100,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
}

const staticModels = ['alpha', 'beta'].map(mkModel);

type DiffSink = (counts: CatalogDiffCounts) => void;

type SinkMock = ReturnType<typeof mock<DiffSink>>;

function createSinkMock(): SinkMock {
    return mock<DiffSink>(() => {});
}

function callCounts(sink: SinkMock, callIndex = 0): CatalogDiffCounts {
    const call = sink.mock.calls[callIndex];
    return (
        (call?.[0] as CatalogDiffCounts) ?? {
            newCount: -1,
            missingFallbackCount: -1,
        }
    );
}

describe('reportCatalogDiff', () => {
    afterEach(() => {
        mock.restore();
    });

    it('stays silent when silent=true', () => {
        const sink = createSinkMock();
        const reported = new Set<string>();
        reportCatalogDiff([mkModel('gamma')], staticModels, {
            silent: true,
            reported,
            sink,
        });
        expect(sink).not.toHaveBeenCalled();
        expect(reported.size).toBe(0);
    });

    it('reports first drift counts and grows the reported set', () => {
        const sink = createSinkMock();
        const reported = new Set<string>();
        // Live contains gamma+delta (new) AND alpha+beta (kept static).
        // Static list = alpha+beta → 0 missing fallback.
        const live = [mkModel('gamma'), mkModel('delta'), ...staticModels];
        reportCatalogDiff(live, staticModels, {
            silent: false,
            reported,
            sink,
        });
        expect(sink).toHaveBeenCalledTimes(1);
        const counts = callCounts(sink, 0);
        expect(counts).toEqual({ newCount: 2, missingFallbackCount: 0 });
        expect([...reported]).toEqual(
            expect.arrayContaining(['gamma', 'delta']),
        );
        expect(reported.size).toBe(2);
    });

    it('does not log when the same drift recurs (dedup)', () => {
        const sink = createSinkMock();
        const reported = new Set<string>();
        const live = [mkModel('gamma'), ...staticModels];
        reportCatalogDiff(live, staticModels, {
            silent: false,
            reported,
            sink,
        });
        expect(sink).toHaveBeenCalledTimes(1);
        // second call with identical live set
        reportCatalogDiff(live, staticModels, {
            silent: false,
            reported,
            sink,
        });
        expect(sink).toHaveBeenCalledTimes(1);
    });

    it('logs only newly seen models on subsequent passes', () => {
        const sink = createSinkMock();
        const reported = new Set<string>();
        // first pass: gamma is new
        reportCatalogDiff([mkModel('gamma')], staticModels, {
            silent: false,
            reported,
            sink,
        });
        expect(sink).toHaveBeenCalledTimes(1);
        // second pass: gamma already seen, delta + epsilon are new
        reportCatalogDiff(
            [mkModel('gamma'), mkModel('delta'), mkModel('epsilon')],
            staticModels,
            { silent: false, reported, sink },
        );
        expect(sink).toHaveBeenCalledTimes(2);
        expect(callCounts(sink, 1)).toEqual({
            newCount: 2,
            missingFallbackCount: 2,
        });
    });

    it('logs even with zero new ids when static fallbacks are missing', () => {
        const sink = createSinkMock();
        const reported = new Set<string>();
        // live set lacks 'alpha' and 'beta' from static
        reportCatalogDiff([], staticModels, {
            silent: false,
            reported,
            sink,
        });
        expect(sink).toHaveBeenCalledTimes(1);
        expect(callCounts(sink, 0)).toEqual({
            newCount: 0,
            missingFallbackCount: 2,
        });
    });

    it('logs nothing when live matches static exactly', () => {
        const sink = createSinkMock();
        const reported = new Set<string>();
        reportCatalogDiff(staticModels, staticModels, {
            silent: false,
            reported,
            sink,
        });
        expect(sink).not.toHaveBeenCalled();
    });
});
