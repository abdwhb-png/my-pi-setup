import { describe, expect, it } from 'bun:test';
import {
    createWarningDeduplicator,
    warningKeyFor,
} from './warnings';

// ---------------------------------------------------------------------------
// Task 10 — session warnings are deduplicated by a stable backend/reason key,
// and the dedupe state resets when a new session starts.
// ---------------------------------------------------------------------------

describe('Task 10 warning deduplication', () => {
    it('keys warnings by stable backend/reason', () => {
        expect(warningKeyFor({ backend: 'headroom', reason: 'timeout' })).toBe(
            'headroom/timeout',
        );
        expect(warningKeyFor({ backend: 'edgee', reason: 'http_error' })).toBe(
            'edgee/http_error',
        );
    });

    it('falls back to policy/unknown when backend or reason is missing', () => {
        expect(warningKeyFor({ reason: 'service_error' })).toBe(
            'policy/service_error',
        );
        expect(warningKeyFor({ backend: 'headroom' })).toBe('headroom/unknown');
        expect(warningKeyFor({})).toBe('policy/unknown');
    });

    it('warns once per key and dedupes repeats within a session', () => {
        const dedupe = createWarningDeduplicator();

        expect(dedupe.shouldWarn('headroom/timeout')).toBe(true);
        expect(dedupe.shouldWarn('headroom/timeout')).toBe(false);
        expect(dedupe.shouldWarn('headroom/http_503')).toBe(true);
        expect(dedupe.shouldWarn('headroom/http_503')).toBe(false);
    });

    it('reset clears dedupe state for a new session', () => {
        const dedupe = createWarningDeduplicator();

        expect(dedupe.shouldWarn('headroom/timeout')).toBe(true);
        dedupe.reset();
        expect(dedupe.shouldWarn('headroom/timeout')).toBe(true);
    });
});
