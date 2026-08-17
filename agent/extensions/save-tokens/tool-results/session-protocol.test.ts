import { describe, expect, it } from 'bun:test';
import {
    COMPRESSION_EVENT_ENTRY_TYPE,
    listCompressionEvents,
} from '../../_shared/compression-protocol';
import { toCompressionEventPayload } from './session';
import type { CompressionObservation } from './types';

// ---------------------------------------------------------------------------
// Task 10 — enriched observation fields must persist through the canonical
// session protocol and old entries (without the new fields) must keep parsing.
// ---------------------------------------------------------------------------

const HEADROOM_PIN = '322425c43bffde1ed0b64fecf3cf5951565dd82b';

describe('Task 10 session protocol persistence', () => {
    it('persists backend, version, latency, native metrics and tokenizer on compressed payloads', () => {
        const obs: CompressionObservation = {
            kind: 'compressed',
            toolCallId: 't1',
            toolName: 'read',
            originalLength: 100,
            compressedLength: 40,
            backend: 'headroom',
            backendVersion: HEADROOM_PIN,
            latencyMs: 42,
            nativeMetrics: {
                tokensBefore: 100,
                tokensAfter: 40,
                transforms: ['dedup'],
            },
            tokenizer: 'claude-3-5-sonnet-20241022',
        };

        const payload = toCompressionEventPayload(obs);

        expect(payload).toMatchObject({
            kind: 'compressed',
            toolCallId: 't1',
            toolName: 'read',
            originalLength: 100,
            compressedLength: 40,
            backend: 'headroom',
            backendVersion: HEADROOM_PIN,
            latencyMs: 42,
            nativeMetrics: {
                tokensBefore: 100,
                tokensAfter: 40,
                transforms: ['dedup'],
            },
            tokenizer: 'claude-3-5-sonnet-20241022',
        });
    });

    it('persists exact failed reason and backend fields on failed payloads', () => {
        const obs: CompressionObservation = {
            kind: 'failed',
            toolCallId: 'f1',
            toolName: 'grep',
            originalLength: 50,
            compressedLength: 0,
            reason: 'timeout',
            backend: 'edgee',
            backendVersion: '0.1.3',
            latencyMs: 800,
        };

        const payload = toCompressionEventPayload(obs);

        expect(payload).toMatchObject({
            kind: 'failed',
            reason: 'timeout',
            backend: 'edgee',
            backendVersion: '0.1.3',
            latencyMs: 800,
        });
    });

    it('round-trips enriched payloads through the protocol list', () => {
        const obs: CompressionObservation = {
            kind: 'skipped',
            toolCallId: 's1',
            toolName: 'ls',
            originalLength: 10,
            compressedLength: 0,
            reason: 'unsupported_tool',
            backend: 'edgee',
            backendVersion: '0.1.3',
        };

        const events = listCompressionEvents([
            {
                type: 'custom',
                customType: COMPRESSION_EVENT_ENTRY_TYPE,
                data: toCompressionEventPayload(obs),
            },
        ]);

        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            kind: 'skipped',
            reason: 'unsupported_tool',
            backend: 'edgee',
            backendVersion: '0.1.3',
        });
    });

    it('replays old session entries that lack the enriched fields', () => {
        const events = listCompressionEvents([
            {
                type: 'custom',
                customType: COMPRESSION_EVENT_ENTRY_TYPE,
                data: {
                    kind: 'skipped',
                    toolCallId: 'old-1',
                    toolName: 'grep',
                    timestamp: 1,
                    originalLength: 20,
                    reason: 'no_change',
                },
            },
        ]);

        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ kind: 'skipped', reason: 'no_change' });
        expect(events[0]).not.toHaveProperty('backend');
        expect(events[0]).not.toHaveProperty('latencyMs');
    });

    it('does not persist empty native metrics or absent optional fields', () => {
        const payload = toCompressionEventPayload({
            kind: 'compressed',
            toolCallId: 't2',
            toolName: 'read',
            originalLength: 100,
            compressedLength: 40,
        });

        expect(payload).not.toHaveProperty('nativeMetrics');
        expect(payload).not.toHaveProperty('backend');
        expect(payload).not.toHaveProperty('latencyMs');
        expect(payload).not.toHaveProperty('tokenizer');
    });
});
