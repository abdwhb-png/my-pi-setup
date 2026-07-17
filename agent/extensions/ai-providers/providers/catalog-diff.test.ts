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
import { reportCatalogDiff } from './catalog-diff.ts';

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

type WarnMock = ReturnType<typeof mock<(message: string) => void>>;

function createWarnMock(): WarnMock {
    return mock<(message: string) => void>(() => {});
}

function callMessage(warnMock: WarnMock, callIndex = 0): string {
    const call = warnMock.mock.calls[callIndex];
    return call ? (call[0] as string) : '';
}

describe('reportCatalogDiff', () => {
    afterEach(() => {
        mock.restore();
    });

    it('stays silent when silent=true', () => {
        const warn = createWarnMock();
        const reported = new Set<string>();
        reportCatalogDiff([mkModel('gamma')], staticModels, {
            silent: true,
            reported,
            warn,
        });
        expect(warn).not.toHaveBeenCalled();
        expect(reported.size).toBe(0);
    });

    it('logs one summary line on first drift and grows the reported set', () => {
        const warn = createWarnMock();
        const reported = new Set<string>();
        // Live contains gamma+delta (new) AND alpha+beta (kept static).
        // Static list = alpha+beta → 0 missing fallback.
        const live = [mkModel('gamma'), mkModel('delta'), ...staticModels];
        reportCatalogDiff(live, staticModels, {
            silent: false,
            reported,
            warn,
        });
        expect(warn).toHaveBeenCalledTimes(1);
        const msg = callMessage(warn, 0);
        expect(msg).toMatch(/2 new model/);
        expect(msg).toMatch(/0 missing fallback/);
        expect([...reported]).toEqual(
            expect.arrayContaining(['gamma', 'delta']),
        );
        expect(reported.size).toBe(2);
    });

    it('does not log when the same drift recurs (dedup)', () => {
        const warn = createWarnMock();
        const reported = new Set<string>();
        const live = [mkModel('gamma'), ...staticModels];
        reportCatalogDiff(live, staticModels, {
            silent: false,
            reported,
            warn,
        });
        expect(warn).toHaveBeenCalledTimes(1);
        // second call with identical live set
        reportCatalogDiff(live, staticModels, {
            silent: false,
            reported,
            warn,
        });
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it('logs only newly seen models on subsequent passes', () => {
        const warn = createWarnMock();
        const reported = new Set<string>();
        // first pass: gamma is new
        reportCatalogDiff([mkModel('gamma')], staticModels, {
            silent: false,
            reported,
            warn,
        });
        expect(warn).toHaveBeenCalledTimes(1);
        // second pass: gamma already seen, delta + epsilon are new
        reportCatalogDiff(
            [mkModel('gamma'), mkModel('delta'), mkModel('epsilon')],
            staticModels,
            { silent: false, reported, warn },
        );
        expect(warn).toHaveBeenCalledTimes(2);
        expect(callMessage(warn, 1)).toMatch(/2 new model/);
    });

    it('logs even with zero new ids when static fallbacks are missing', () => {
        const warn = createWarnMock();
        const reported = new Set<string>();
        // live set lacks 'alpha' and 'beta' from static
        reportCatalogDiff([], staticModels, {
            silent: false,
            reported,
            warn,
        });
        expect(warn).toHaveBeenCalledTimes(1);
        const msg = callMessage(warn, 0);
        expect(msg).toMatch(/0 new model/);
        expect(msg).toMatch(/2 missing fallback/);
    });

    it('logs nothing when live matches static exactly', () => {
        const warn = createWarnMock();
        const reported = new Set<string>();
        reportCatalogDiff(staticModels, staticModels, {
            silent: false,
            reported,
            warn,
        });
        expect(warn).not.toHaveBeenCalled();
    });
});
