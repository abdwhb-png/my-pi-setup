import type {
    ExtensionAPI,
    ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { appendCompressionEvent } from '../_shared/compression-protocol';
import { createWidget } from '../_shared/fancy-footer';
import { getLocalCompressorConfig } from './config-runtime';

/** Marker for idempotent system-prompt injection (§7 AXI). */
const ARCHIVE_CONVENTION_MARKER = '# Tool Result Compression';
const ARCHIVE_CONVENTION_PROMPT = [
    ARCHIVE_CONVENTION_MARKER,
    '',
    'Tool results may be compressed to save tokens. The original output is archived;',
    'run `read <archivePath>` to retrieve the full content.',
].join('\n');
import {
    archiveOriginalToolResult,
    pruneToolResultArchive,
    resolveToolResultArchiveRoot,
} from './tool-results/archive';
import {
    chooseCompressionRoute,
    createToolResultHandler,
    extractCompressibleText,
    isCompressibleToolName,
} from './tool-results/core';
import {
    createCompressionMetrics,
    createCompressionMetricsFromEvents,
    formatDetailedStats,
    formatSavedBytes,
    formatStatsStatus,
    formatStatsWidgetLines,
} from './tool-results/metrics';
import {
    restoreMetricsFromSession,
    toCompressionEventPayload,
} from './tool-results/session';
import type {
    CompressionObservation,
    LocalCompressorConfig,
} from './tool-results/types';
import {
    formatCompressionNotificationSummary,
    formatTurnNotification,
    STATUS_ID,
    summarizeCompressionEvents,
    updateUi,
    WIDGET_ID,
} from './tool-results/ui';

export {
    createCompressionMetrics,
    createCompressionMetricsFromEvents,
    formatDetailedStats,
    formatSavedBytes,
    formatStatsStatus,
    formatStatsWidgetLines,
    createToolResultHandler,
    chooseCompressionRoute,
    extractCompressibleText,
    getLocalCompressorConfig,
    isCompressibleToolName,
    summarizeCompressionEvents,
};

export function shouldNotifyCompressionSummary(
    granularity: LocalCompressorConfig['summaryGranularity'],
    scope: 'turn' | 'agent',
): boolean {
    return granularity === 'all' || granularity === scope;
}

export default function localToolResultCompressor(
    pi: ExtensionAPI,
    configOverride?: Partial<LocalCompressorConfig>,
): void {
    const loadConfig = (): LocalCompressorConfig => {
        const loaded = getLocalCompressorConfig();
        if (!configOverride) return loaded;
        return {
            ...loaded,
            ...configOverride,
            minBytesByGroup: {
                ...loaded.minBytesByGroup,
                ...configOverride.minBytesByGroup,
            },
            archiveRetention: {
                ...loaded.archiveRetention,
                ...configOverride.archiveRetention,
            },
        };
    };
    let latestCtx: ExtensionContext | null = null;
    let config = loadConfig();
    let metrics = createCompressionMetrics();
    let widgetText = '';
    let pendingTurnEvents: CompressionObservation[] = [];
    let pendingAgentEvents: CompressionObservation[] = [];
    const widget = createWidget(pi, {
        id: WIDGET_ID,
        label: 'Compressor',
        description: 'Local tool-result compression stats.',
        row: 0,
        order: 12,
        align: 'left',
        grow: true,
        render: () => widgetText,
    });
    const setWidgetText = (text: string) => {
        widgetText = text;
    };

    const handleObservation = (event: CompressionObservation) => {
        metrics.record(event);
        const snapshot = metrics.snapshot();
        updateUi(
            latestCtx,
            snapshot,
            config.baseUrl,
            widget,
            setWidgetText,
            config.showStatus,
            config.showWidget,
            event,
        );

        appendCompressionEvent(pi, toCompressionEventPayload(event));
        pendingTurnEvents.push(event);
        pendingAgentEvents.push(event);
    };

    let handler = createToolResultHandler({
        baseUrl: config.baseUrl,
        agent: config.agent,
        timeoutMs: config.timeoutMs,
        archiveOriginal: config.archiveOriginal
            ? archiveOriginalToolResult
            : undefined,
        capFallbackBytes: config.capFallbackBytes,
        routingStrategy: config.routingStrategy,
        enabled: config.enabled,
        excludeTools: config.excludeTools,
        minBytesByGroup: config.minBytesByGroup,
        aggregates: config.aggregates,
        capErrors: config.capErrors,
        onObservation: handleObservation,
    });

    pi.on('session_start', async (_event, ctx) => {
        latestCtx = ctx;
        config = loadConfig();
        if (config.archiveOriginal) {
            try {
                await pruneToolResultArchive({
                    archiveRoot: resolveToolResultArchiveRoot(),
                    maxAgeDays: config.archiveRetention.maxAgeDays,
                    maxBytes: config.archiveRetention.maxBytes,
                });
            } catch (error) {
                const message = `Tool-result archive cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
                if (ctx.hasUI) ctx.ui.notify(message, 'warning');
                else console.warn(message);
            }
        }
        metrics = restoreMetricsFromSession(ctx);
        pendingTurnEvents = [];
        pendingAgentEvents = [];
        handler = createToolResultHandler({
            baseUrl: config.baseUrl,
            agent: config.agent,
            timeoutMs: config.timeoutMs,
            archiveOriginal: config.archiveOriginal
                ? archiveOriginalToolResult
                : undefined,
            capFallbackBytes: config.capFallbackBytes,
            routingStrategy: config.routingStrategy,
            enabled: config.enabled,
            excludeTools: config.excludeTools,
            minBytesByGroup: config.minBytesByGroup,
            aggregates: config.aggregates,
            capErrors: config.capErrors,
            onObservation: handleObservation,
        });
        updateUi(
            latestCtx,
            metrics.snapshot(),
            config.baseUrl,
            widget,
            setWidgetText,
            config.showStatus,
            config.showWidget,
        );
    });

    // §7 AXI — Inject archive convention into system prompt at agent start.
    // Makes the escape hatch reliable by telling the LLM about compression
    // and the `read <archivePath>` retrieval pattern (~30 tokens/session).
    pi.on('before_agent_start', async (event) => {
        config = loadConfig();
        if (!config.enabled || !config.archiveOriginal) return;
        if (event.systemPrompt.includes(ARCHIVE_CONVENTION_MARKER)) return;
        return {
            systemPrompt: `${event.systemPrompt}\n\n${ARCHIVE_CONVENTION_PROMPT}`,
        };
    });

    pi.on('agent_start', async () => {
        pendingAgentEvents = [];
    });

    pi.on('turn_start', async () => {
        pendingTurnEvents = [];
    });

    pi.on('turn_end', async (_event, ctx) => {
        latestCtx = ctx;
        if (
            !ctx.hasUI ||
            pendingTurnEvents.length === 0 ||
            !shouldNotifyCompressionSummary(config.summaryGranularity, 'turn')
        )
            return;
        const summary = formatTurnNotification(pendingTurnEvents);
        ctx.ui.notify(summary.message, summary.type);
        pendingTurnEvents = [];
    });

    pi.on('agent_end', async (_event, ctx) => {
        latestCtx = ctx;
        if (
            !ctx.hasUI ||
            pendingAgentEvents.length === 0 ||
            !shouldNotifyCompressionSummary(config.summaryGranularity, 'agent')
        )
            return;
        const summary = formatCompressionNotificationSummary(
            'agent',
            pendingAgentEvents,
        );
        ctx.ui.notify(summary.message, summary.type);
        pendingAgentEvents = [];
    });

    pi.registerCommand('compressor-stats', {
        description:
            'Show or reset local tool-result compressor stats. Usage: /compressor-stats [reset]',
        handler: async (args, ctx) => {
            latestCtx = ctx;
            const command = args.trim().toLowerCase();
            if (command === 'reset') {
                metrics.reset();
                updateUi(
                    latestCtx,
                    metrics.snapshot(),
                    config.baseUrl,
                    widget,
                    setWidgetText,
                    config.showStatus,
                    config.showWidget,
                );
                ctx.ui.notify('compressor stats reset', 'info');
                return;
            }

            ctx.ui.notify(
                formatDetailedStats(metrics.snapshot(), config.baseUrl),
                'info',
            );
        },
    });

    pi.on('tool_result', async (event, ctx) => {
        latestCtx = ctx;
        const result = await handler(event, ctx.signal);
        return result;
    });

    pi.on('session_shutdown', async () => {
        if (latestCtx?.hasUI) {
            latestCtx.ui.setStatus(STATUS_ID, undefined);
            widget.remove(latestCtx);
        }
        latestCtx = null;
    });
}
