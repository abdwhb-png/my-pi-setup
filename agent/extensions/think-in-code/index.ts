import { registerToolPolicyContribution } from "../_shared/tool-policy/index.ts";
/**
 * Think-in-Code native extension.
 *
 * Registers two native Pi tools:
 *   - think_execute: command | content | archives | file | batch + analyzer
 *   - think_artifact_search: bounded temporary execution artifacts
 *
 * The extension owns its store and coordinator lifecycle:
 *   - session_start: open the per-project store, run retention, recover any
 *     unconsumed snapshot, register Pi tools.
 *   - session_shutdown: close the store, release the coordinator.
 *
 * No tools duplicate policy, sandbox, storage, or redaction logic. They are
 * thin validators that hand off to the coordinator.
 */

import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import type {
    AgentToolResult,
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
    getSandboxRuntime,
    SandboxUnavailableError,
    subscribeSandboxRuntime,
    type SandboxUnavailableKind,
} from "../_shared/sandbox-runtime/index.ts";
import { registerThinkAuditCommand } from "./audit-command.ts";
import {
    createThinkCommandExecution,
    type ThinkCommandExecution,
} from "./command-policy.ts";
import {
    DEFAULT_THINK_IN_CODE_CONFIG,
    hashProjectPath,
    loadThinkInCodeConfig,
    resolveThinkInCodeRoot,
    type ThinkInCodeConfig,
} from "./config.ts";
import { ThinkCoordinator } from "./coordinator.ts";
import { registerHooks, type HookState } from "./memory/hooks.ts";
import {
    renderThinkArtifactSearchCall,
    renderThinkArtifactSearchResult,
    renderThinkExecuteCall,
    renderThinkExecuteResult,
} from "./render.ts";
import { ThinkStore } from "./storage/store.ts";
import {
    createThinkTelemetryRecorder,
    type ThinkTelemetryRecorder,
} from "./telemetry/recorder.ts";
import { purgeExpiredThinkTelemetry } from "./telemetry/storage.ts";
import { buildToolHandlers, createThinkSchemas } from "./tools.ts";
import { THINK_TOOL_NAMES, TOOL_NAMES } from "./types.ts";

export interface ThinkInCodeRegistrationOptions {
    resolveRoot?: () => string;
}

function sandboxUnavailableError(): SandboxUnavailableError | undefined {
    const runtime = getSandboxRuntime();
    if (runtime.state === "enabled") {
        if (runtime.analysis.state === "ready") return undefined;
        return new SandboxUnavailableError(
            "analysis-unavailable",
            runtime.analysis.diagnostic,
        );
    }
    const kind: SandboxUnavailableKind =
        runtime.state === "disabled"
            ? "disabled"
            : runtime.state === "error"
              ? "initialization-failed"
              : "uninitialized";
    return new SandboxUnavailableError(kind);
}

function sandboxUnavailableReason(): string | undefined {
    return sandboxUnavailableError()?.message;
}

export function registerThinkInCode(
    pi: ExtensionAPI,
    options: ThinkInCodeRegistrationOptions = {},
): void {
    let coordinator: ThinkCoordinator | undefined;
    let store: ThinkStore | undefined;
    let config: ThinkInCodeConfig = DEFAULT_THINK_IN_CODE_CONFIG;
    let hooksRegistered = false;
    let hookState: HookState | undefined;
    let commandExecution: ThinkCommandExecution | undefined;
    let telemetryRecorder: ThinkTelemetryRecorder | null = null;
    let telemetryRoot: string | undefined;
    let telemetrySequence = 0;
    let telemetryWarningReported = false;
    let auditRecommendationTurnActive = false;
    const visibility = registerToolPolicyContribution(
        pi,
        "think-in-code",
        () => ({
            deny: sandboxUnavailableReason() ? THINK_TOOL_NAMES : [],
        }),
    );
    let unsubscribeSandboxRuntime: (() => void) | undefined;

    function syncSandboxToolVisibility(): void {
        visibility.refresh();
    }

    function warnTelemetry(ctx: ExtensionContext, message: string): void {
        if (telemetryWarningReported) return;
        telemetryWarningReported = true;
        if (ctx.hasUI) ctx.ui.notify(message, "warning");
    }

    async function openStore(ctx: ExtensionContext): Promise<void> {
        await telemetryRecorder?.flush();
        hookState?.shutdown();
        coordinator?.close();
        store?.close();
        const canonical = await realpath(ctx.cwd).catch(() => ctx.cwd);
        const segment = hashProjectPath(canonical);
        const root = options.resolveRoot?.() ?? resolveThinkInCodeRoot();
        const storeRoot = join(root, "projects", segment);
        telemetryRoot = join(storeRoot, "telemetry");
        config = loadThinkInCodeConfig(canonical);
        store = new ThinkStore({
            config,
            storeRoot,
            canonicalPath: canonical,
        });
        telemetryRecorder = createThinkTelemetryRecorder({
            config: config.telemetry,
            root: telemetryRoot,
            sessionId: ctx.sessionManager.getSessionId() ?? randomUUID(),
            cwd: canonical,
            sequenceGenerator: () => ++telemetrySequence,
            onError: (message) => warnTelemetry(ctx, message),
        });
        commandExecution = createThinkCommandExecution({
            getConfig: () => config,
            getTelemetryRecorder: () => telemetryRecorder,
        });
        coordinator = new ThinkCoordinator({
            store,
            config,
            commandExecution: commandExecution.service,
        });
        coordinator.runRetentionSafe();
        if (config.telemetry.enabled) {
            try {
                await purgeExpiredThinkTelemetry(
                    telemetryRoot,
                    config.telemetry.retentionDays,
                );
            } catch {
                warnTelemetry(
                    ctx,
                    "think-in-code telemetry retention cleanup failed; command enforcement was unaffected",
                );
            }
        }
        if (!hooksRegistered && store) {
            hookState = registerHooks(pi, {
                store,
                tokenBudget: config.restoreTokenBudget,
                sessionIdAt: (extensionCtx) =>
                    extensionCtx.sessionManager.getSessionId(),
            });
            hookState.start(
                ctx.sessionManager.getSessionId(),
                ctx.sessionManager.getEntries(),
            );
            hooksRegistered = true;
        } else if (hookState) {
            hookState.rebind(store, config.restoreTokenBudget);
        }
    }

    function registerTools(): void {
        if (!coordinator) return;
        const handlers = buildToolHandlers(coordinator);
        const schemas = createThinkSchemas();
        const adaptCtx = (
            ctx: ExtensionContext,
            signal: AbortSignal | undefined,
        ) => ({ ...ctx, cwd: ctx.cwd, signal }) as ExtensionContext;
        // SAFETY: each handler returns a structurally-correct
        // AgentToolResult ({ content: TextContent[]; details }). The two
        // unknown-by-default generics on ToolDefinition accept any value, and
        // the Pi wrapper normalizes the shape at execution time.
        const asResult = async <T>(
            promise: Promise<T>,
        ): Promise<AgentToolResult<unknown>> =>
            (await promise) as AgentToolResult<unknown>;
        pi.registerTool({
            name: TOOL_NAMES.execute,
            label: "🧠 Think Execute",
            description:
                "Derive a bounded result from command output, a project file, inline content, prior Think archives, or up to 16 command outputs without placing the raw source in model context. Use it when only filtering, parsing, aggregation, extraction, comparison, or summarization is needed. Normal results contain a compact JSON status header, including indexStatus, followed by the bounded derivation. Direct source echoes and terminal failures set isError and return a safe JSON code, reason, and recovery. Never use it to edit files or as general memory. Produced derivations are indexed temporarily for artifact search.",
            promptSnippet:
                "Derive a bounded result without placing the raw source in context",
            promptGuidelines: [
                "Use think_execute when only a bounded derivation is needed from source data, such as filtering, extraction, aggregation, comparison, or summarization.",
                "Keep native tools as the natural choice when their exact output must be observed, edited, or reused directly.",
                "Treat expected source size as a secondary signal for context savings, not as a threshold or the definition of think_execute.",
            ],
            parameters: schemas.execute,
            renderCall: renderThinkExecuteCall,
            renderResult: (result, renderOptions, theme, renderContext) =>
                renderThinkExecuteResult(
                    result,
                    renderOptions,
                    theme,
                    renderContext,
                    config.retentionHours,
                ),
            async execute(toolCallId, params, signal, onUpdate, ctx) {
                const unavailable = sandboxUnavailableError();
                if (unavailable !== undefined) {
                    throw unavailable;
                }
                return asResult(
                    handlers.execute(
                        params as Record<string, unknown>,
                        adaptCtx(ctx, signal),
                        { toolCallId, signal, onUpdate },
                    ),
                );
            },
        });
        pi.registerTool({
            name: TOOL_NAMES.artifactSearch,
            label: "🧠 Think Artifact Search",
            description:
                "Search only non-expired derivations and metadata produced by think_execute in this project. Never use it as general memory or to inspect current source. Returns bounded snippets and archive IDs, never raw archive bytes. Store failures set isError and return a safe code and recovery.",
            promptSnippet:
                "Search temporary derivations produced by prior Think executions",
            promptGuidelines: [
                "Use think_artifact_search only for non-expired Think artifacts, never as general memory or current-source discovery.",
            ],
            parameters: schemas.artifactSearch,
            renderCall: renderThinkArtifactSearchCall,
            renderResult: (result, renderOptions, theme, renderContext) =>
                renderThinkArtifactSearchResult(
                    result,
                    renderOptions,
                    theme,
                    renderContext,
                    config.retentionHours,
                ),
            async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
                const unavailable = sandboxUnavailableError();
                if (unavailable !== undefined) {
                    throw unavailable;
                }
                return asResult(
                    handlers.artifactSearch({
                        ...(params as Record<string, unknown>),
                        id: toolCallId,
                    }),
                );
            },
        });
    }

    pi.on("before_agent_start", () => {
        syncSandboxToolVisibility();
    });

    pi.on("session_start", async (_event, ctx) => {
        telemetrySequence = 0;
        telemetryWarningReported = false;
        auditRecommendationTurnActive = false;
        commandExecution?.approvals.clear();
        unsubscribeSandboxRuntime?.();
        unsubscribeSandboxRuntime = subscribeSandboxRuntime(
            visibility.captureRefresh(),
        );
        await openStore(ctx);
        registerTools();
        syncSandboxToolVisibility();
    });

    pi.on("tool_call", async (event) => {
        if (auditRecommendationTurnActive) {
            return {
                block: true as const,
                reason: "think audit is recommendation-only; all tool execution is disabled for this analysis turn.",
            };
        }
        if (
            event.toolName !== TOOL_NAMES.execute &&
            event.toolName !== TOOL_NAMES.artifactSearch
        ) {
            return undefined;
        }
        const reason = sandboxUnavailableReason();
        if (!reason) return undefined;
        syncSandboxToolVisibility();
        return { block: true as const, reason };
    });

    pi.on("agent_end", () => {
        auditRecommendationTurnActive = false;
    });

    pi.on("session_shutdown", async () => {
        auditRecommendationTurnActive = false;
        commandExecution?.approvals.clear();
        unsubscribeSandboxRuntime?.();
        unsubscribeSandboxRuntime = undefined;
        hookState?.shutdown();
        await telemetryRecorder?.flush();
        coordinator?.close();
        store?.close();
        coordinator = undefined;
        store = undefined;
        commandExecution = undefined;
        telemetryRecorder = null;
        telemetryRoot = undefined;
    });

    registerThinkAuditCommand(pi, {
        getConfig: () => config,
        getTelemetryRoot: () => telemetryRoot,
        beginAudit: () => {
            auditRecommendationTurnActive = true;
        },
    });
}

export default function thinkInCodeExtension(pi: ExtensionAPI): void {
    registerThinkInCode(pi);
}

export { THINK_TOOL_NAMES };
export type { ThinkInCodeConfig } from "./config.ts";
