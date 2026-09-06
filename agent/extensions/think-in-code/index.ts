/**
 * Think-in-Code native extension.
 *
 * Registers three native Pi tools:
 *   - think_execute: command | content | archives | file | batch + analyzer
 *   - think_note: one concise durable conclusion with optional provenance
 *   - think_search: bounded snippets + archive IDs
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
import { getSandboxRuntime } from "../_shared/sandbox-runtime/index.ts";
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
    let restoreExecuteWhenSandboxAvailable = false;

    function syncSandboxToolVisibility(): void {
        const activeTools = new Set(pi.getActiveTools());
        if (getSandboxRuntime().state !== "enabled") {
            if (activeTools.delete(TOOL_NAMES.execute)) {
                restoreExecuteWhenSandboxAvailable = true;
                pi.setActiveTools([...activeTools]);
            }
            return;
        }
        if (restoreExecuteWhenSandboxAvailable) {
            activeTools.add(TOOL_NAMES.execute);
            restoreExecuteWhenSandboxAvailable = false;
            pi.setActiveTools([...activeTools]);
        }
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
        const handlers = buildToolHandlers(
            coordinator,
            config.indexedSnippetChars,
        );
        const schemas = createThinkSchemas(config.indexedSnippetChars);
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
                "Analyze one source with action=command|content|archives|file|batch. Return a bounded derivation, never copied raw input. File results require think_note for durable indexing.",
            parameters: schemas.execute,
            async execute(toolCallId, params, signal, onUpdate, ctx) {
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
            name: TOOL_NAMES.note,
            label: "🧠 Think Note",
            description:
                "Store one concise redacted note. source and text are required; archiveIds may link provenance but are never used as note text.",
            parameters: schemas.note,
            async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
                return asResult(
                    handlers.note({
                        ...(params as Record<string, unknown>),
                        id: toolCallId,
                    }),
                );
            },
        });
        pi.registerTool({
            name: TOOL_NAMES.search,
            label: "🧠 Think Search",
            description:
                "Search prior indexed analyses and notes. Returns bounded ranked snippets plus archive/document IDs and distinguishes an empty project corpus from zero matches. Never returns raw archive bytes.",
            parameters: schemas.search,
            async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
                return asResult(
                    handlers.search({
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
        await openStore(ctx);
        registerTools();
        syncSandboxToolVisibility();
    });

    pi.on("tool_call", async () => {
        if (!auditRecommendationTurnActive) return undefined;
        return {
            block: true as const,
            reason: "think audit is recommendation-only; all tool execution is disabled for this analysis turn.",
        };
    });

    pi.on("agent_end", () => {
        auditRecommendationTurnActive = false;
    });

    pi.on("session_shutdown", async () => {
        auditRecommendationTurnActive = false;
        commandExecution?.approvals.clear();
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
