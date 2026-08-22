/**
 * Slow Mode Extension
 *
 * Overrides the built-in write and edit tools, and hooks tool_call to confirm
 * bash/safe_bash tools. Users review proposed changes before they are applied.
 *
 * In non-interactive mode (no UI) or RPC mode, slow mode is a no-op.
 */

import {
    mkdirSync,
    mkdtempSync,
    writeFileSync,
    readFileSync,
    unlinkSync,
    rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, basename, join, resolve, extname } from "node:path";
import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
    createWriteTool,
    createEditTool,
} from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { createMcpRefResolver } from "pi-mcp-adapter";
import { isDangerous } from "../_shared/bash/guard";
import { createWidget } from "../_shared/fancy-footer.ts";
import { createUiColors } from "../_shared/ui/ui-colors.ts";
import {
    resolvePath,
    generateUnifiedDiff,
    extractEditText,
    applyEdits,
    extractEditPatches,
    autoAcceptKey,
    loadSlowModeConfig,
    validateSlowModeConfig,
    type SlowModeConfigResult,
} from "./slow-mode-core.ts";
import {
    showReview,
    openExternalFile,
    renderWithDelta,
    type ReviewResult,
} from "./slow-mode-ui.ts";

const WIDGET_ID = "slow-mode";

export default function slowMode(pi: ExtensionAPI) {
    const isRPC =
        process.argv.includes("--mode") && process.argv.includes("rpc");

    let enabled = false;

    /** Per-tool slow-mode config. Map key = tool name, value = slow mode active for this tool. */
    let toolConfig = new Map<string, boolean>();

    /** Build an MCP `mcp:` reference resolver bound to the merged config cache. */
    function buildMcpResolver(): (ref: string) => string[] {
        return createMcpRefResolver();
    }

    /** Reload the slow-mode tool config from disk. */
    function reloadToolConfig(): SlowModeConfigResult {
        const raw = loadSlowModeConfig();
        const result = validateSlowModeConfig(
            raw,
            pi.getActiveTools(),
            buildMcpResolver(),
        );
        toolConfig = result.tools;
        return result;
    }

    const editedCalls = new Map<string, { original: string; edited: string }>();
    const autoAccept = new Map<string, Set<string>>();

    let _tmpDir: string | null = null;
    function tmpDir(): string {
        if (!_tmpDir) {
            _tmpDir = mkdtempSync(join(tmpdir(), "pi-slow-mode-"));
        }
        return _tmpDir;
    }

    function isAutoAccepted(toolName: string, key: string | null): boolean {
        if (key == null) return false;
        return autoAccept.get(toolName)?.has(key) ?? false;
    }

    function recordAutoAccept(toolName: string, key: string | null) {
        if (key == null) return;
        let s = autoAccept.get(toolName);
        if (!s) {
            s = new Set();
            autoAccept.set(toolName, s);
        }
        s.add(key);
    }

    function clearAutoAccept() {
        autoAccept.clear();
    }

    let originalWrite = createWriteTool(process.cwd());
    let originalEdit = createEditTool(process.cwd());

    /**
     * Build the widget text showing slow-mode status + configured tools.
     * Format: "slow ■ [write, edit, grep]" or "slow ■ (3 tools)"
     */
    function buildWidgetText(
        enabled: boolean,
        config: Map<string, boolean>,
    ): string | null {
        if (!enabled) return null;
        const activeTools = reviewedTools(config);
        if (activeTools.length === 0) return "slow ■";
        const maxShow = 4;
        const shown = activeTools.slice(0, maxShow);
        const suffix =
            activeTools.length > maxShow
                ? ` +${activeTools.length - maxShow}`
                : "";
        return `■slow: [${shown.join(", ")}${suffix}]`;
    }

    /** Tool names under review (config === true), sorted for stable display. */
    function reviewedTools(config: Map<string, boolean>): string[] {
        return [...config.entries()]
            .filter(([, v]) => v)
            .map(([k]) => k)
            .toSorted();
    }

    const w = createWidget(pi, {
        id: WIDGET_ID,
        label: "Slow Mode",
        description: "Shows whether slow mode is active.",
        row: 1,
        order: 8,
        align: "right",
        render: (ctx) => {
            const text = buildWidgetText(enabled, toolConfig);
            if (!text) return null;
            const colors = createUiColors(ctx.theme);
            return colors.warning(text);
        },
    });

    pi.on("session_start", async (_event, ctx) => {
        originalWrite = createWriteTool(ctx.cwd);
        originalEdit = createEditTool(ctx.cwd);

        // Load tool config first (needed for widget display)
        const result = reloadToolConfig();
        for (const warning of result.warnings) {
            ctx.ui.notify(warning, "warning");
        }

        const entries = ctx.sessionManager.getEntries();
        for (let i = entries.length - 1; i >= 0; i--) {
            const e = entries[i];
            if (e.type === "custom" && e.customType === "slow-mode") {
                enabled = (e.data as { enabled: boolean }).enabled;
                w.update(ctx, buildWidgetText(enabled, toolConfig));
                break;
            }
        }
    });

    pi.on("session_shutdown", async () => {
        if (_tmpDir) {
            try {
                rmSync(_tmpDir, { recursive: true });
            } catch {
                /* best-effort temp-dir cleanup */
            }
        }
    });

    pi.on("turn_end", async () => {
        clearAutoAccept();
    });

    pi.registerCommand("slow-mode", {
        description:
            "Toggle slow mode — review configured tools (write/edit/bash/...) before applying",
        getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
            const values = ["on", "enable", "off", "disable", "reload"];
            const items = values.map((v) => ({ value: v, label: v }));
            const filtered = items.filter((i) => i.value.startsWith(prefix));
            return filtered.length > 0 ? filtered : null;
        },
        handler: async (args, ctx) => {
            if (!ctx.hasUI) {
                return;
            }

            if (isRPC) {
                ctx.ui.notify(
                    "Slow mode is unavailable in RPC mode",
                    "warning",
                );
                return;
            }

            const arg = args.trim().toLowerCase();

            if (arg === "reload" || arg === "refresh") {
                const result = reloadToolConfig();
                w.update(ctx, buildWidgetText(enabled, toolConfig));
                for (const warning of result.warnings) {
                    ctx.ui.notify(warning, "warning");
                }
                const count = [...result.tools.values()].filter(Boolean).length;
                ctx.ui.notify(
                    `Slow-mode config reloaded (${count} tools under review)`,
                    "info",
                );
                return;
            }

            if (arg === "on" || arg === "enable") {
                enabled = true;
            } else if (arg === "off" || arg === "disable") {
                enabled = false;
            } else {
                enabled = !enabled;
            }

            w.update(ctx, buildWidgetText(enabled, toolConfig));

            pi.appendEntry("slow-mode", { enabled });

            if (enabled) {
                const tools = reviewedTools(toolConfig);
                const list = tools.length > 0 ? ` [${tools.join(", ")}]` : "";
                ctx.ui.notify(
                    `■Slow mode enabled${list} — changes require approval`,
                    "info",
                );
            } else {
                ctx.ui.notify("Slow mode disabled", "info");
            }
        },
    });

    pi.registerTool({
        ...originalWrite,
        label: "write (slow mode)",
        async execute(toolCallId, params, signal, onUpdate, ctx) {
            if (
                !enabled ||
                isRPC ||
                !ctx.hasUI ||
                toolConfig.get("write") !== true
            ) {
                return originalWrite.execute(
                    toolCallId,
                    params,
                    signal,
                    onUpdate,
                );
            }

            const filePath = params.path;
            const content = params.content;
            if (!filePath || content == null) {
                return originalWrite.execute(
                    toolCallId,
                    params,
                    signal,
                    onUpdate,
                );
            }

            const key = autoAcceptKey("write", params);
            if (isAutoAccepted("write", key)) {
                return originalWrite.execute(
                    toolCallId,
                    params,
                    signal,
                    onUpdate,
                );
            }

            const review = await reviewWrite(
                toolCallId,
                filePath,
                content,
                ctx,
            );

            if (review.autoAccept) {
                recordAutoAccept("write", key);
            }

            if (!review.approved) {
                throw new Error(
                    review.reason
                        ? `User rejected the write: ${review.reason}`
                        : "User rejected the write in slow mode review.",
                );
            }

            if (
                review.editedContent != null &&
                review.editedContent !== content
            ) {
                editedCalls.set(toolCallId, {
                    original: content,
                    edited: review.editedContent,
                });
                ctx.ui.notify("Using edited content", "info");
                const modifiedParams = {
                    ...params,
                    content: review.editedContent,
                };
                return originalWrite.execute(
                    toolCallId,
                    modifiedParams,
                    signal,
                    onUpdate,
                );
            }

            return originalWrite.execute(toolCallId, params, signal, onUpdate);
        },
    });

    pi.registerTool({
        ...originalEdit,
        label: "edit (slow mode)",
        async execute(toolCallId, params, signal, onUpdate, ctx) {
            if (
                !enabled ||
                isRPC ||
                !ctx.hasUI ||
                toolConfig.get("edit") !== true
            ) {
                return originalEdit.execute(
                    toolCallId,
                    params,
                    signal,
                    onUpdate,
                );
            }

            const filePath = params.path;
            if (!filePath) {
                return originalEdit.execute(
                    toolCallId,
                    params,
                    signal,
                    onUpdate,
                );
            }

            const key = autoAcceptKey("edit", params);
            if (isAutoAccepted("edit", key)) {
                return originalEdit.execute(
                    toolCallId,
                    params,
                    signal,
                    onUpdate,
                );
            }

            const review = await reviewEdit(toolCallId, params, ctx);

            if (review.autoAccept) {
                recordAutoAccept("edit", key);
            }

            if (!review.approved) {
                throw new Error(
                    review.reason
                        ? `User rejected the edit: ${review.reason}`
                        : "User rejected the edit in slow mode review.",
                );
            }

            if (review.editedContent != null) {
                if (review.wroteDirectly) {
                    editedCalls.set(toolCallId, {
                        original: review.originalNewText!,
                        edited: review.editedContent,
                    });
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: "Applied via slow mode review (content was edited externally).",
                            },
                        ],
                        details: undefined,
                    };
                }
                if (review.editedContent !== review.originalNewText) {
                    editedCalls.set(toolCallId, {
                        original: review.originalNewText!,
                        edited: review.editedContent,
                    });
                    ctx.ui.notify("Using edited content", "info");
                    const modifiedParams = constructModifiedEditParams(
                        params,
                        review.editedContent,
                    );
                    return originalEdit.execute(
                        toolCallId,
                        modifiedParams,
                        signal,
                        onUpdate,
                    );
                }
            }

            return originalEdit.execute(toolCallId, params, signal, onUpdate);
        },
    });

    pi.on("tool_result", async (event, ctx) => {
        if (!enabled || !ctx.hasUI) return;

        const edited = editedCalls.get(event.toolCallId);
        if (!edited) return;

        editedCalls.delete(event.toolCallId);

        const originalLines = edited.original.split("\n").length;
        const editedLines = edited.edited.split("\n").length;
        const lineDiff = editedLines - originalLines;
        const lineDiffText =
            lineDiff > 0
                ? `+${lineDiff} lines`
                : lineDiff < 0
                  ? `${lineDiff} lines`
                  : "same line count";

        const note = {
            type: "text" as const,
            text: `\n\n**Note:** Content was modified in slow mode review before writing (${lineDiffText}).`,
        };

        return {
            content: [...(event.content || []), note],
        };
    });

    pi.on("tool_call", async (event, ctx) => {
        if (!enabled || isRPC || !ctx.hasUI) return;

        // Opt-in: review only tools explicitly enabled (=== true) in config.
        // Defaults populate write/edit/bash/safe_bash so they are reviewed out of the box.
        if (toolConfig.get(event.toolName) !== true) return;

        if (event.toolName === "bash" || event.toolName === "safe_bash") {
            const input = event.input as { command?: unknown };
            const command =
                typeof input.command === "string" ? input.command : undefined;
            if (command == null) return;

            const key = autoAcceptKey(
                event.toolName,
                event.input as Record<string, unknown>,
            );
            if (isAutoAccepted(event.toolName, key)) {
                return;
            }

            const danger = isDangerous(command);
            const body = danger
                ? `⚠ DANGEROUS (${danger})\n\n$ ${command}`
                : `$ ${command}`;

            pi.events.emit("slow-mode:waiting", {});
            let decision: ReviewResult;
            try {
                decision = await showReview(ctx, {
                    operation: "BASH",
                    filePath: event.toolName,
                    body,
                    allowEdit: false,
                });
            } finally {
                pi.events.emit("slow-mode:resolved", {});
            }

            if (decision === "approve") {
                return;
            }
            if (decision === "approve-auto") {
                recordAutoAccept(event.toolName, key);
                return;
            }
            if (decision === "edit") {
                return;
            }
            if (decision === "reject") {
                return {
                    block: true as const,
                    reason: "User rejected the bash command in slow mode review.",
                };
            }
            return {
                block: true as const,
                reason: `User rejected the bash command: ${decision.reason}`,
            };
        }

        // ---- Generic config-based slow mode for any other tool ----
        const input = event.input as Record<string, unknown>;
        const bodyLines = [`Tool: ${event.toolName}`];
        for (const [key, value] of Object.entries(input)) {
            const valStr =
                typeof value === "string" ? value : JSON.stringify(value);
            bodyLines.push(`  ${key}: ${valStr}`);
        }
        const body = bodyLines.join("\n");

        pi.events.emit("slow-mode:waiting", {});
        let decision: ReviewResult;
        try {
            decision = await showReview(ctx, {
                operation: "BASH",
                filePath: event.toolName,
                body,
                allowEdit: false,
            });
        } finally {
            pi.events.emit("slow-mode:resolved", {});
        }

        if (decision === "approve" || decision === "approve-auto") {
            if (decision === "approve-auto") {
                recordAutoAccept(
                    event.toolName,
                    autoAcceptKey(event.toolName, input),
                );
            }
            return;
        }
        if (decision === "reject") {
            return {
                block: true as const,
                reason: `User rejected the ${event.toolName} tool call in slow mode review.`,
            };
        }
        if (typeof decision === "object" && decision.action === "rejected") {
            return {
                block: true as const,
                reason: `User rejected the ${event.toolName} tool call: ${decision.reason}`,
            };
        }
    });

    interface WriteReviewResult {
        approved: boolean;
        editedContent: string | null;
        autoAccept: boolean;
        reason: string | null;
    }

    async function reviewWrite(
        _toolCallId: string,
        filePath: string,
        content: string,
        ctx: ExtensionContext,
    ): Promise<WriteReviewResult> {
        const relPath = resolvePath(ctx.cwd, filePath);
        const stagePath = join(tmpDir(), relPath);

        ensureDir(dirname(stagePath));
        writeFileSync(stagePath, content, "utf-8");

        pi.events.emit("slow-mode:waiting", {});
        const result = await showReview(ctx, {
            operation: "WRITE",
            filePath: relPath,
            stagePath,
            body: content,
            allowEdit: true,
        });
        pi.events.emit("slow-mode:resolved", {});

        let editedContent: string | null = null;
        let autoAcceptVal = false;
        let reason: string | null = null;

        if (result === "approve" || result === "approve-auto") {
            autoAcceptVal = result === "approve-auto";
            try {
                const readBack = readFileSync(stagePath, "utf-8");
                if (readBack !== content) {
                    editedContent = readBack;
                }
            } catch {}
        } else if (result === "reject") {
        } else if (typeof result === "object" && result.action === "rejected") {
            reason = result.reason;
        }

        cleanup(stagePath);

        return {
            approved: result === "approve" || result === "approve-auto",
            editedContent,
            autoAccept: autoAcceptVal,
            reason,
        };
    }

    interface EditReviewResult {
        approved: boolean;
        editedContent: string | null;
        originalNewText: string | null;
        wroteDirectly: boolean;
        autoAccept: boolean;
        reason: string | null;
    }

    async function reviewEdit(
        _toolCallId: string,
        params: {
            path: string;
            edits: Array<{ oldText: string; newText: string }>;
        },
        ctx: ExtensionContext,
    ): Promise<EditReviewResult> {
        const filePath = params.path;
        const patches = extractEditPatches(params);
        if (!patches)
            return {
                approved: true,
                editedContent: null,
                originalNewText: null,
                wroteDirectly: false,
                autoAccept: false,
                reason: null,
            };

        const relPath = resolvePath(ctx.cwd, filePath);

        let oldText: string;
        let newText: string;
        let usedRealFile = false;

        if (patches.length > 1) {
            try {
                const absolutePath = resolve(ctx.cwd, filePath);
                const fileContent = readFileSync(absolutePath, "utf-8");
                oldText = fileContent;
                newText = applyEdits(fileContent, patches);
                usedRealFile = true;
            } catch {
                const extracted = extractEditText(params);
                if (!extracted)
                    return {
                        approved: true,
                        editedContent: null,
                        originalNewText: null,
                        wroteDirectly: false,
                        autoAccept: false,
                        reason: null,
                    };
                oldText = extracted.oldText;
                newText = extracted.newText;
            }
        } else {
            const extracted = extractEditText(params);
            if (!extracted)
                return {
                    approved: true,
                    editedContent: null,
                    originalNewText: null,
                    wroteDirectly: false,
                    autoAccept: false,
                    reason: null,
                };
            oldText = extracted.oldText;
            newText = extracted.newText;
        }

        const base = basename(relPath);
        const ext = extname(base);
        const nameWithoutExt = base.slice(0, -ext.length || undefined);
        const ts = Date.now();
        const oldPath = join(tmpDir(), `${nameWithoutExt}-${ts}.old${ext}`);
        const newPath = join(tmpDir(), `${nameWithoutExt}-${ts}.new${ext}`);
        ensureDir(tmpDir());
        writeFileSync(oldPath, oldText, "utf-8");
        writeFileSync(newPath, newText, "utf-8");

        pi.events.emit("slow-mode:waiting", {});

        let approved = false;
        let autoAcceptVal = false;
        let reason: string | null = null;

        reviewLoop: while (true) {
            const currentOldText = readFileSync(oldPath, "utf-8");
            const currentNewText = readFileSync(newPath, "utf-8");
            const diff = generateUnifiedDiff(
                relPath,
                currentOldText,
                currentNewText,
            );
            const renderedDiff = renderWithDelta(diff);

            const decision = await showReview(ctx, {
                operation: "EDIT",
                filePath: relPath,
                body: renderedDiff,
                stagePath: newPath,
                oldPath,
                newPath,
                allowEdit: true,
            });

            switch (decision) {
                case "approve":
                case "approve-auto":
                    approved = true;
                    autoAcceptVal = decision === "approve-auto";
                    break reviewLoop;
                case "reject":
                    approved = false;
                    break reviewLoop;
                case "edit":
                    openExternalFile(newPath);
                    continue;
                default:
                    if (
                        typeof decision === "object" &&
                        decision.action === "rejected"
                    ) {
                        reason = decision.reason;
                        approved = false;
                        break reviewLoop;
                    }
            }
        }

        let editedContent: string | null = null;
        let wroteDirectly = false;

        if (approved) {
            try {
                const editedNewText = readFileSync(newPath, "utf-8");
                if (editedNewText !== newText) {
                    if (usedRealFile) {
                        const absolutePath = resolve(ctx.cwd, filePath);
                        writeFileSync(absolutePath, editedNewText, "utf-8");
                        wroteDirectly = true;
                    }
                    editedContent = editedNewText;
                }
            } catch {}
        }

        pi.events.emit("slow-mode:resolved", {});
        cleanup(oldPath);
        cleanup(newPath);

        return {
            approved,
            editedContent,
            originalNewText: newText,
            wroteDirectly,
            autoAccept: autoAcceptVal,
            reason,
        };
    }

    function constructModifiedEditParams(
        params: {
            path: string;
            edits: Array<{ oldText: string; newText: string }>;
        },
        editedNewText: string,
    ): { path: string; edits: Array<{ oldText: string; newText: string }> } {
        if (params.edits.length === 1) {
            return {
                path: params.path,
                edits: [
                    {
                        oldText: params.edits[0].oldText,
                        newText: editedNewText,
                    },
                ],
            };
        }
        return {
            path: params.path,
            edits: [
                {
                    oldText: params.edits.map((e) => e.oldText).join("\n"),
                    newText: editedNewText,
                },
            ],
        };
    }

    function ensureDir(dir: string) {
        mkdirSync(dir, { recursive: true });
    }

    function cleanup(path: string) {
        try {
            unlinkSync(path);
        } catch {}
    }
}
