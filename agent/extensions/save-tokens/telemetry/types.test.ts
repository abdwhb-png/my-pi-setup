import { describe, expect, it } from 'bun:test';
import {
    TELEMETRY_SCHEMA_VERSION,
    type TelemetryEvent,
    type TelemetrySessionStart,
    type TelemetrySessionEnd,
    type TelemetryAgentRunStart,
    type TelemetryAgentRunEnd,
    type TelemetryTurnStart,
    type TelemetryTurnEnd,
    type TelemetryRawToolResult,
    type TelemetryFinalToolResult,
    type TelemetryModeChange,
    type TelemetryExperimentTag,
    type TelemetryConfigSnapshot,
    type CompressionSnapshotField,
    type JsonValue,
    type UsageMetrics,
    type CompressionDetails,
} from './types';

describe('telemetry types — schema version', () => {
    it('exports a numeric schema version', () => {
        expect(typeof TELEMETRY_SCHEMA_VERSION).toBe('number');
        expect(Number.isFinite(TELEMETRY_SCHEMA_VERSION)).toBe(true);
        expect(TELEMETRY_SCHEMA_VERSION).toBeGreaterThanOrEqual(1);
    });
});

describe('telemetry types — identity fields', () => {
    const now = new Date().toISOString();
    const base: TelemetrySessionStart = {
        schemaVersion: 1,
        eventId: 'evt-001',
        timestamp: now,
        sessionId: 'sess-abc',
        event: 'session_start',
    };

    it('every event carries schemaVersion, eventId, timestamp, sessionId', () => {
        expect(base.schemaVersion).toBe(1);
        expect(base.eventId).toBe('evt-001');
        expect(base.timestamp).toBe(now);
        expect(base.sessionId).toBe('sess-abc');
    });

    it('session_start can carry optional model, extensions, configSnapshot', () => {
        const full: TelemetrySessionStart = {
            ...base,
            model: 'claude-sonnet-4-6',
            extensions: ['caveman', 'ponytail'],
            configSnapshot: {
                enabled: true,
                captureContent: true,
                redactSecrets: true,
                retentionDays: 90,
            },
        };
        expect(full.model).toBe('claude-sonnet-4-6');
        expect(full.extensions).toHaveLength(2);
        expect(full.configSnapshot?.retentionDays).toBe(90);
    });

    it('session_end requires durationMs and toolCallCount', () => {
        const ev: TelemetrySessionEnd = {
            schemaVersion: 1,
            eventId: 'evt-002',
            timestamp: now,
            sessionId: 'sess-abc',
            event: 'session_end',
            durationMs: 1_234_000,
            toolCallCount: 42,
        };
        expect(ev.durationMs).toBe(1_234_000);
        expect(ev.toolCallCount).toBe(42);
    });
});

describe('telemetry types — agent run and turn', () => {
    const now = new Date().toISOString();

    it('agent_run_start requires runId', () => {
        const ev: TelemetryAgentRunStart = {
            schemaVersion: 1,
            eventId: 'evt-010',
            timestamp: now,
            sessionId: 'sess-abc',
            event: 'agent_run_start',
            runId: 'run-001',
        };
        expect(ev.runId).toBe('run-001');
    });

    it('agent_run_end requires runId, durationMs, turnCount', () => {
        const ev: TelemetryAgentRunEnd = {
            schemaVersion: 1,
            eventId: 'evt-011',
            timestamp: now,
            sessionId: 'sess-abc',
            event: 'agent_run_end',
            runId: 'run-001',
            durationMs: 45_000,
            turnCount: 12,
        };
        expect(ev.turnCount).toBe(12);
    });

    it('turn_start requires runId and turnIndex', () => {
        const ev: TelemetryTurnStart = {
            schemaVersion: 1,
            eventId: 'evt-020',
            timestamp: now,
            sessionId: 'sess-abc',
            event: 'turn_start',
            runId: 'run-001',
            turnIndex: 0,
        };
        expect(ev.turnIndex).toBe(0);
    });

    it('turn_end carries toolCallCount and optional durationMs', () => {
        const ev: TelemetryTurnEnd = {
            schemaVersion: 1,
            eventId: 'evt-021',
            timestamp: now,
            sessionId: 'sess-abc',
            event: 'turn_end',
            runId: 'run-001',
            turnIndex: 0,
            toolCallCount: 3,
        };
        expect(ev.toolCallCount).toBe(3);
        expect(ev.durationMs).toBeUndefined();
    });
});

describe('telemetry types — tool results', () => {
    const now = new Date().toISOString();

    it('raw_tool_result requires toolCallId, toolName, contentLength', () => {
        const ev: TelemetryRawToolResult = {
            schemaVersion: 1,
            eventId: 'evt-030',
            timestamp: now,
            sessionId: 'sess-abc',
            event: 'raw_tool_result',
            runId: 'run-001',
            turnIndex: 0,
            toolCallId: 'tc-001',
            toolName: 'read',
            contentLength: 15000,
        };
        expect(ev.toolCallId).toBe('tc-001');
        expect(ev.contentLength).toBe(15000);
    });

    it('final_tool_result supports compressors snapshot', () => {
        const csf: CompressionSnapshotField = {
            compressor: 'caveman',
            configured: { level: 'full' },
            requested: { level: 'ultra' },
            effective: { level: 'full' },
        };
        const ev: TelemetryFinalToolResult = {
            schemaVersion: 1,
            eventId: 'evt-031',
            timestamp: now,
            sessionId: 'sess-abc',
            event: 'final_tool_result',
            runId: 'run-001',
            turnIndex: 0,
            toolCallId: 'tc-001',
            toolName: 'grep',
            contentLength: 5000,
            compressors: [csf],
        };
        expect(ev.compressors).toHaveLength(1);
        expect(ev.compressors![0]!.compressor).toBe('caveman');
        expect(ev.compressors![0]!.configured).toEqual({ level: 'full' });
    });
});

describe('telemetry types — mode change and experiment tag', () => {
    const now = new Date().toISOString();

    it('mode_change requires component, requested, previous, next', () => {
        const ev: TelemetryModeChange = {
            schemaVersion: 1,
            eventId: 'evt-040',
            timestamp: now,
            sessionId: 'sess-abc',
            event: 'mode_change',
            component: 'caveman',
            requested: 'full',
            previous: 'normal',
            next: 'caveman',
        };
        expect(ev.component).toBe('caveman');
        expect(ev.requested).toBe('full');
        expect(ev.previous).toBe('normal');
        expect(ev.next).toBe('caveman');
    });

    it('experiment_tag carries tag and optional value', () => {
        const ev: TelemetryExperimentTag = {
            schemaVersion: 1,
            eventId: 'evt-050',
            timestamp: now,
            sessionId: 'sess-abc',
            event: 'experiment_tag',
            tag: 'compression_ratio',
            value: 0.45,
        };
        expect(ev.tag).toBe('compression_ratio');
        expect(ev.value).toBe(0.45);
    });
});

describe('telemetry types — discriminated union', () => {
    const now = new Date().toISOString();

    it('dispatches on event discriminant', () => {
        const events: TelemetryEvent[] = [
            {
                schemaVersion: 1,
                eventId: 'e1',
                timestamp: now,
                sessionId: 's',
                event: 'session_start',
            } satisfies TelemetrySessionStart,
            {
                schemaVersion: 1,
                eventId: 'e2',
                timestamp: now,
                sessionId: 's',
                event: 'session_end',
                durationMs: 1000,
                toolCallCount: 5,
            } satisfies TelemetrySessionEnd,
            {
                schemaVersion: 1,
                eventId: 'e3',
                timestamp: now,
                sessionId: 's',
                event: 'experiment_tag',
                tag: 'test',
            } satisfies TelemetryExperimentTag,
        ];

        const types = events.map((e) => e.event);
        expect(types).toEqual([
            'session_start',
            'session_end',
            'experiment_tag',
        ]);
    });
});

describe('telemetry types — config snapshot', () => {
    it('holds boolean flags and retentionDays', () => {
        const cs: TelemetryConfigSnapshot = {
            enabled: true,
            captureContent: true,
            redactSecrets: false,
            retentionDays: 30,
        };
        expect(cs.enabled).toBe(true);
        expect(cs.retentionDays).toBe(30);
    });
});

describe('telemetry types — compression snapshot field', () => {
    it('supports local-compressor', () => {
        const csf: CompressionSnapshotField = {
            compressor: 'local-compressor',
            configured: { baseUrl: 'http://localhost:8320' },
            requested: {},
            effective: {},
        };
        expect(csf.compressor).toBe('local-compressor');
    });

    it('uses configured/requested/effective fields', () => {
        const csf: CompressionSnapshotField = {
            compressor: 'ponytail',
            configured: { defaultMode: 'full' },
            requested: { defaultMode: 'ultra' },
            effective: { defaultMode: 'full' },
        };
        expect(csf.configured).toEqual({ defaultMode: 'full' });
        expect(csf.requested).toEqual({ defaultMode: 'ultra' });
        expect(csf.effective).toEqual({ defaultMode: 'full' });
    });
});

describe('telemetry types — runtime context', () => {
    const now = new Date().toISOString();

    it('agent_run_start carries provider, model, thinkingLevel, cwd, project, experimentTag', () => {
        const ev: TelemetryAgentRunStart = {
            schemaVersion: 1,
            eventId: 'evt-ctx-01',
            timestamp: now,
            sessionId: 'sess-abc',
            event: 'agent_run_start',
            runId: 'run-001',
            provider: 'anthropic',
            model: 'claude-sonnet-4-6',
            thinkingLevel: 'high',
            cwd: '/home/user/project',
            project: 'my-project',
            experimentTag: 'v2-compressor-test',
        };
        expect(ev.provider).toBe('anthropic');
        expect(ev.model).toBe('claude-sonnet-4-6');
        expect(ev.thinkingLevel).toBe('high');
        expect(ev.cwd).toBe('/home/user/project');
        expect(ev.project).toBe('my-project');
        expect(ev.experimentTag).toBe('v2-compressor-test');
    });

    it('turn_start carries cwd and project from runtime context', () => {
        const ev: TelemetryTurnStart = {
            schemaVersion: 1,
            eventId: 'evt-ctx-02',
            timestamp: now,
            sessionId: 'sess-abc',
            event: 'turn_start',
            runId: 'run-001',
            turnIndex: 0,
            cwd: '/home/user/project',
            project: 'my-project',
        };
        expect(ev.cwd).toBe('/home/user/project');
        expect(ev.project).toBe('my-project');
    });
});

describe('telemetry types — usage metrics', () => {
    it('UsageMetrics has optional input/output/cacheRead/cacheWrite/totalTokens/cost', () => {
        const usage: UsageMetrics = {
            inputTokens: 500,
            outputTokens: 200,
            cacheReadTokens: 100,
            cacheWriteTokens: 50,
            totalTokens: 700,
            cost: 0.015,
        };
        expect(usage.inputTokens).toBe(500);
        expect(usage.outputTokens).toBe(200);
        expect(usage.cacheReadTokens).toBe(100);
        expect(usage.cacheWriteTokens).toBe(50);
        expect(usage.totalTokens).toBe(700);
        expect(usage.cost).toBe(0.015);
    });
});

describe('telemetry types — tool result content', () => {
    const now = new Date().toISOString();

    it('raw_tool_result allows isError, content, input, details', () => {
        const ev: TelemetryRawToolResult = {
            schemaVersion: 1,
            eventId: 'evt-060',
            timestamp: now,
            sessionId: 'sess-abc',
            event: 'raw_tool_result',
            runId: 'run-001',
            turnIndex: 0,
            toolCallId: 'tc-060',
            toolName: 'read',
            contentLength: 5000,
            isError: true,
            content: { file: '/etc/passwd' },
            input: { path: '/etc/passwd' } as JsonValue,
            details: { error: 'permission denied' } as JsonValue,
        };
        expect(ev.isError).toBe(true);
        expect(ev.content).toEqual({ file: '/etc/passwd' });
        expect(ev.input).toEqual({ path: '/etc/passwd' });
        expect(ev.details).toEqual({ error: 'permission denied' });
    });

    it('final_tool_result allows isError, content, input, details, compressionDetails', () => {
        const cd: CompressionDetails = {
            originalLength: 10000,
            compressedLength: 2500,
            savedBytes: 7500,
            savedPct: 75,
        };
        const ev: TelemetryFinalToolResult = {
            schemaVersion: 1,
            eventId: 'evt-061',
            timestamp: now,
            sessionId: 'sess-abc',
            event: 'final_tool_result',
            runId: 'run-001',
            turnIndex: 0,
            toolCallId: 'tc-061',
            toolName: 'grep',
            contentLength: 2500,
            isError: false,
            content: { results: ['line1', 'line2'] } as JsonValue,
            input: { pattern: 'foo' } as JsonValue,
            compressionDetails: cd,
        };
        expect(ev.isError).toBe(false);
        expect(ev.compressionDetails?.originalLength).toBe(10000);
        expect(ev.compressionDetails?.savedPct).toBe(75);
    });

    it('CompressionDetails allows optional archivePath, kind, reason', () => {
        const cd: CompressionDetails = {
            originalLength: 5000,
            compressedLength: 1000,
            savedBytes: 4000,
            savedPct: 80,
            archivePath: '/tmp/archive.jsonl',
            kind: 'edgee',
            reason: 'exceeds threshold',
        };
        expect(cd.archivePath).toBe('/tmp/archive.jsonl');
        expect(cd.kind).toBe('edgee');
        expect(cd.reason).toBe('exceeds threshold');
    });
});

describe('telemetry types — mode change with component and source', () => {
    const now = new Date().toISOString();

    it('mode_change distinguishes component, requested/effective, previous/next, source', () => {
        const ev: TelemetryModeChange = {
            schemaVersion: 1,
            eventId: 'evt-070',
            timestamp: now,
            sessionId: 'sess-abc',
            event: 'mode_change',
            component: 'caveman',
            requested: 'ultra',
            effective: 'full',
            previous: 'normal',
            next: 'caveman',
            source: 'user_command',
        };
        expect(ev.component).toBe('caveman');
        expect(ev.requested).toBe('ultra');
        expect(ev.effective).toBe('full');
        expect(ev.previous).toBe('normal');
        expect(ev.next).toBe('caveman');
        expect(ev.source).toBe('user_command');
    });
});
