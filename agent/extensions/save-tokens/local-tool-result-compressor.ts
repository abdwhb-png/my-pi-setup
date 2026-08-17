import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { appendCompressionEvent } from "../_shared/compression-protocol";
import { createWidget } from "../_shared/fancy-footer";
import { loadCompressorConfig } from "./config";
import {
    getLocalCompressorConfig,
    resolveCompressorConfig,
} from "./config-runtime";
import type { ConfigDiagnostic } from "./config-runtime";
import { CompressionBackendRegistry } from "./tool-results/registry";
import {
    COMPRESSION_BACKEND_VERSIONS,
    type CompressionBackend,
    type CompressionObservation,
    type CompressorModel,
    type LocalCompressorConfig,
} from "./tool-results/types";

/** Marker for idempotent system-prompt injection (§7 AXI). */
const ARCHIVE_CONVENTION_MARKER = "# Tool Result Compression";
const ARCHIVE_CONVENTION_PROMPT = [
    ARCHIVE_CONVENTION_MARKER,
    "",
    "Tool results may be compressed to save tokens. The original output is archived;",
    "run `read <archivePath>` to retrieve the full content.",
].join("\n");
import {
    archiveOriginalToolResult,
    pruneToolResultArchive,
    resolveToolResultArchiveRoot,
} from "./tool-results/archive";
import {
    chooseCompressionRoute,
    createToolResultHandler,
    extractCompressibleText,
    isCompressibleToolName,
} from "./tool-results/core";
import {
    createCompressionMetrics,
    createCompressionMetricsFromEvents,
    formatDetailedStats,
    formatSavedBytes,
    formatStatsStatus,
    formatStatsWidgetLines,
} from "./tool-results/metrics";
import {
    restoreMetricsFromSession,
    toCompressionEventPayload,
} from "./tool-results/session";
import {
    formatCompressionNotificationSummary,
    formatTurnNotification,
    STATUS_ID,
    summarizeCompressionEvents,
    updateUi,
    WIDGET_ID,
} from "./tool-results/ui";
import {
    createWarningDeduplicator,
    warningKeyFor,
} from "./tool-results/warnings";

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
    granularity: LocalCompressorConfig["summaryGranularity"],
    scope: "turn" | "agent",
): boolean {
    return granularity === "all" || granularity === scope;
}

/** Placeholder model used when Pi reports no active model. */
const UNKNOWN_MODEL: CompressorModel = {
    provider: "unknown",
    id: "unknown",
    contextWindow: 0,
};

/**
 * Extracts the exact active model as a {@link CompressorModel}.
 *
 * Pi declares `ExtensionContext.model` as `Model<any> | undefined`
 * (node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:230),
 * where `Model<TApi>` carries `id: string`, `provider: ProviderId` and
 * `contextWindow: number` (@earendil-works/pi-ai/dist/types.d.ts:647).
 * The optionality is handled with a guard rather than a cast.
 */
export function resolveModel(ctx: ExtensionContext): CompressorModel {
    const model = ctx.model;
    if (!model) return UNKNOWN_MODEL;
    return {
        provider: model.provider,
        id: model.id,
        contextWindow: model.contextWindow,
    };
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
    let widgetText = "";
    let pendingTurnEvents: CompressionObservation[] = [];
    let pendingAgentEvents: CompressionObservation[] = [];
    // Per-session warning dedupe, reset on session_start.
    const warningDedupe = createWarningDeduplicator();

    // Backend selection happens once per extension setup. Exactly one backend
    // is selected from the resolved config; an invalid config yields null and
    // the policy fails open to cap/archive. Diagnostics are retained for
    // surfacing in a later task.
    const registry = new CompressionBackendRegistry(
        resolveCompressorConfig(loadCompressorConfig()),
    );
    const backend: CompressionBackend | null = registry.getBackend();
    // Widget identity: the active engine (never the base URL).
    const engine = backend?.id ?? "none";
    const backendVersion = backend
        ? COMPRESSION_BACKEND_VERSIONS[backend.id]
        : undefined;
    const configDiagnostics: readonly ConfigDiagnostic[] =
        registry.getConfig().diagnostics;
    const backendFailureReason = configDiagnostics.some(
        (diagnostic) => diagnostic.id === "invalid_backend",
    )
        ? "invalid_backend" as const
        : undefined;
    const widget = createWidget(pi, {
        id: WIDGET_ID,
        label: "Compressor",
        description: "Local tool-result compression stats.",
        row: 0,
        order: 12,
        align: "left",
        grow: true,
        render: () => widgetText,
    });
    const setWidgetText = (text: string) => {
        widgetText = text;
    };

    const handleObservation = (event: CompressionObservation) => {
        metrics.record(event);
        const snapshot = metrics.snapshot();
        // Failures warn at most once per session per stable backend/reason key.
        if (event.kind === "failed") {
            const key = warningKeyFor(event);
            if (warningDedupe.shouldWarn(key)) {
                const message = `compression failed (${key}) — keeping original output`;
                if (latestCtx?.hasUI) latestCtx.ui.notify(message, "warning");
                else console.warn(message);
            }
        }
        updateUi(
            latestCtx,
            snapshot,
            engine,
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

    const buildHandler = () =>
        createToolResultHandler({
            backend,
            backendFailureReason,
            backendVersion,
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

    let handler = buildHandler();

    pi.on("session_start", async (_event, ctx) => {
        latestCtx = ctx;
        config = loadConfig();
        // New session → warnings can surface again.
        warningDedupe.reset();

        for (const diagnostic of configDiagnostics) {
            if (ctx.hasUI) ctx.ui.notify(diagnostic.message, "warning");
            else console.warn(diagnostic.message);
        }

        if (config.archiveOriginal) {
            try {
                await pruneToolResultArchive({
                    archiveRoot: resolveToolResultArchiveRoot(),
                    maxAgeDays: config.archiveRetention.maxAgeDays,
                    maxBytes: config.archiveRetention.maxBytes,
                });
            } catch (error) {
                const message = `Tool-result archive cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
                if (ctx.hasUI) ctx.ui.notify(message, "warning");
                else console.warn(message);
            }
        }
        metrics = restoreMetricsFromSession(ctx);
        pendingTurnEvents = [];
        pendingAgentEvents = [];
        handler = buildHandler();
        updateUi(
            latestCtx,
            metrics.snapshot(),
            engine,
            widget,
            setWidgetText,
            config.showStatus,
            config.showWidget,
        );
    });

    // §7 AXI — Inject archive convention into system prompt at agent start.
    // Makes the escape hatch reliable by telling the LLM about compression
    // and the `read <archivePath>` retrieval pattern (~30 tokens/session).
    pi.on("before_agent_start", async (event) => {
        config = loadConfig();
        if (!config.enabled || !config.archiveOriginal) return;
        if (event.systemPrompt.includes(ARCHIVE_CONVENTION_MARKER)) return;
        return {
            systemPrompt: `${event.systemPrompt}\n\n${ARCHIVE_CONVENTION_PROMPT}`,
        };
    });

    pi.on("agent_start", async () => {
        pendingAgentEvents = [];
    });

    pi.on("turn_start", async () => {
        pendingTurnEvents = [];
    });

    pi.on("turn_end", async (_event, ctx) => {
        latestCtx = ctx;
        if (
            !ctx.hasUI ||
            pendingTurnEvents.length === 0 ||
            !shouldNotifyCompressionSummary(config.summaryGranularity, "turn")
        )
            return;
        const summary = formatTurnNotification(pendingTurnEvents);
        ctx.ui.notify(summary.message, summary.type);
        pendingTurnEvents = [];
    });

    pi.on("agent_end", async (_event, ctx) => {
        latestCtx = ctx;
        if (
            !ctx.hasUI ||
            pendingAgentEvents.length === 0 ||
            !shouldNotifyCompressionSummary(config.summaryGranularity, "agent")
        )
            return;
        const summary = formatCompressionNotificationSummary(
            "agent",
            pendingAgentEvents,
        );
        ctx.ui.notify(summary.message, summary.type);
        pendingAgentEvents = [];
    });

    pi.registerCommand("compressor-stats", {
        description:
            "Show or reset local tool-result compressor stats. Usage: /compressor-stats [reset]",
        handler: async (args, ctx) => {
            latestCtx = ctx;
            const command = args.trim().toLowerCase();
            if (command === "reset") {
                metrics.reset();
                updateUi(
                    latestCtx,
                    metrics.snapshot(),
                    engine,
                    widget,
                    setWidgetText,
                    config.showStatus,
                    config.showWidget,
                );
                ctx.ui.notify("compressor stats reset", "info");
                return;
            }

            ctx.ui.notify(
                formatDetailedStats(metrics.snapshot(), engine),
                "info",
            );
        },
    });

    pi.on("tool_result", async (event, ctx) => {
        latestCtx = ctx;
        // Resolved on every tool_result — never captured at registration time,
        // because the active model can change mid-session.
        const result = await handler(event, resolveModel(ctx), ctx.signal);
        return result;
    });

    pi.on("session_shutdown", async () => {
        if (latestCtx?.hasUI) {
            latestCtx.ui.setStatus(STATUS_ID, undefined);
            widget.remove(latestCtx);
        }
        latestCtx = null;
    });
}
