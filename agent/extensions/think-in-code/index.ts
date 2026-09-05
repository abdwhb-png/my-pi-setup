/**
 * Think-in-Code native extension.
 *
 * Registers five native Pi tools:
 *   - think_execute: command | content | archives + analyzer
 *   - think_execute_file: a single project file + analyzer
 *   - think_batch_execute: up to 16 commands (concurrency 2) + analyzer
 *   - think_index: explicit text or archive IDs (redacted before storage)
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

import { realpath } from "node:fs/promises";
import { join } from "node:path";
import type {
    AgentToolResult,
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
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
import { buildToolHandlers, SCHEMAS } from "./tools.ts";
import { THINK_TOOL_NAMES, TOOL_NAMES } from "./types.ts";

export default function (pi: ExtensionAPI) {
    let coordinator: ThinkCoordinator | undefined;
    let store: ThinkStore | undefined;
    let config: ThinkInCodeConfig = DEFAULT_THINK_IN_CODE_CONFIG;
    let hooksRegistered = false;
    let hookState: HookState | undefined;

    async function openStore(ctx: ExtensionContext): Promise<void> {
        const canonical = await realpath(ctx.cwd).catch(() => ctx.cwd);
        const segment = hashProjectPath(canonical);
        const root = resolveThinkInCodeRoot();
        const storeRoot = join(root, "projects", segment);
        config = loadThinkInCodeConfig(canonical);
        store = new ThinkStore({
            config,
            storeRoot,
            canonicalPath: canonical,
        });
        coordinator = new ThinkCoordinator({ store, config });
        coordinator.runRetentionSafe();
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
        }
    }

    function registerTools(): void {
        if (!coordinator) return;
        const handlers = buildToolHandlers(coordinator);
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
                "Run a command, inline content, or analyze prior archive IDs through the sandboxed analyzer. Returns bounded derived text; raw output is archived, not exposed.",
            parameters: SCHEMAS.execute,
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
            name: TOOL_NAMES.executeFile,
            label: "🧠 Think Execute File",
            description:
                "Read a single project file (under ctx.cwd, ≤ 64 MiB) and analyze it through the sandboxed analyzer with FILE_CONTENT/FILE_PATH bindings. Worker never receives a filesystem mount.",
            parameters: SCHEMAS.executeFile,
            async execute(toolCallId, params, signal, onUpdate, ctx) {
                return asResult(
                    handlers.executeFile(
                        params as Record<string, unknown>,
                        adaptCtx(ctx, signal),
                        { toolCallId, signal, onUpdate },
                    ),
                );
            },
        });
        pi.registerTool({
            name: TOOL_NAMES.batchExecute,
            label: "🧠 Think Batch",
            description:
                "Run up to 16 commands (global concurrency 2) through the shared safe execution service, archive every result, then run one analyzer over the structured INPUTS array. Per-item blocked/failed status is preserved; raw output never enters the LLM context.",
            parameters: SCHEMAS.batchExecute,
            async execute(toolCallId, params, signal, onUpdate, ctx) {
                return asResult(
                    handlers.batchExecute(
                        params as Record<string, unknown>,
                        adaptCtx(ctx, signal),
                        { toolCallId, signal, onUpdate },
                    ),
                );
            },
        });
        pi.registerTool({
            name: TOOL_NAMES.index,
            label: "🧠 Think Index",
            description:
                "Index bounded text or existing archive IDs (after redaction). Never reads a host path.",
            parameters: SCHEMAS.index,
            async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
                return asResult(
                    handlers.index({
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
                "Search the FTS5 index. Returns bounded ranked snippets plus archive/document IDs. Never returns raw archive bytes. Follow-up analysis uses think_execute with archive IDs.",
            parameters: SCHEMAS.search,
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

    pi.on("session_start", async (_event, ctx) => {
        await openStore(ctx);
        registerTools();
    });

    pi.on("session_shutdown", async () => {
        hookState?.shutdown();
        coordinator?.close();
        store?.close();
        coordinator = undefined;
        store = undefined;
    });
}

export { THINK_TOOL_NAMES };
export type { ThinkInCodeConfig } from "./config.ts";
