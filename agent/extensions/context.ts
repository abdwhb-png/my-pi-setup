/**
 * /context
 *
 * Small TUI view showing what's loaded/available:
 * - extensions (best-effort from registered extension slash commands)
 * - skills
 * - project context files (AGENTS.md / CLAUDE.md)
 * - current context window usage + session totals (tokens/cost)
 */

import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
    BeforeAgentStartEvent,
    BeforeAgentStartEventResult,
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionContext,
    ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
    Key,
    Text,
    matchesKey,
    type Component,
    type TUI,
} from "@earendil-works/pi-tui";
import { requestMarkdownLinkTransform } from "./_shared/markdown-links.ts";
import { createUiColors } from "./_shared/ui/ui-colors.ts";

function formatUsd(cost: number): string {
    if (!Number.isFinite(cost) || cost <= 0) return "$0.00";
    if (cost >= 1) return `$${cost.toFixed(2)}`;
    if (cost >= 0.1) return `$${cost.toFixed(3)}`;
    return `$${cost.toFixed(4)}`;
}

function estimateTokens(text: string): number {
    // Deliberately fuzzy (good enough for “how big-ish is this”).
    return Math.max(0, Math.ceil(text.length / 4));
}

function normalizeReadPath(inputPath: string, cwd: string): string {
    // Similar to pi's resolveToCwd/resolveReadPath, but simplified.
    let p = inputPath;
    if (p.startsWith("@")) p = p.slice(1);
    if (p === "~") p = os.homedir();
    else if (p.startsWith("~/")) p = path.join(os.homedir(), p.slice(2));
    if (!path.isAbsolute(p)) p = path.resolve(cwd, p);
    return path.resolve(p);
}

function getAgentDir(): string {
    // Mirrors pi's behavior reasonably well.
    const envCandidates = ["PI_CODING_AGENT_DIR", "TAU_CODING_AGENT_DIR"];
    let envDir: string | undefined;
    for (const k of envCandidates) {
        if (process.env[k]) {
            envDir = process.env[k];
            break;
        }
    }
    if (!envDir) {
        for (const [k, v] of Object.entries(process.env)) {
            if (k.endsWith("_CODING_AGENT_DIR") && v) {
                envDir = v;
                break;
            }
        }
    }

    if (envDir) {
        if (envDir === "~") return os.homedir();
        if (envDir.startsWith("~/"))
            return path.join(os.homedir(), envDir.slice(2));
        return envDir;
    }
    return path.join(os.homedir(), ".pi", "agent");
}

async function readFileIfExists(
    filePath: string,
): Promise<{ path: string; content: string; bytes: number } | null> {
    if (!existsSync(filePath)) return null;
    try {
        const buf = await fs.readFile(filePath);
        return {
            path: filePath,
            content: buf.toString("utf8"),
            bytes: buf.byteLength,
        };
    } catch {
        return null;
    }
}

async function loadProjectContextFiles(
    cwd: string,
): Promise<
    Array<{ path: string; tokens: number; bytes: number; content: string }>
> {
    const out: Array<{
        path: string;
        tokens: number;
        bytes: number;
        content: string;
    }> = [];
    const seen = new Set<string>();

    const loadFromDir = async (dir: string) => {
        const results = await Promise.all(
            ["AGENTS.md", "CLAUDE.md"].map((name) =>
                readFileIfExists(path.join(dir, name)),
            ),
        );
        for (const f of results) {
            if (f && !seen.has(f.path)) {
                seen.add(f.path);
                out.push({
                    path: f.path,
                    tokens: estimateTokens(f.content),
                    bytes: f.bytes,
                    content: f.content,
                });
                // pi loads at most one of those per dir
                return;
            }
        }
    };

    await loadFromDir(getAgentDir());

    // Ancestors: root → cwd (same order as pi)
    const stack: string[] = [];
    let current = path.resolve(cwd);
    while (true) {
        stack.push(current);
        const parent = path.resolve(current, "..");
        if (parent === current) break;
        current = parent;
    }
    stack.reverse();
    await Promise.all(stack.map((dir) => loadFromDir(dir)));

    return out;
}

function normalizeSkillName(name: string): string {
    return name.startsWith("skill:") ? name.slice("skill:".length) : name;
}

type SkillIndexEntry = {
    name: string;
    skillFilePath: string;
    skillDir: string;
};

/** Extract the file path for a skill command, or "" if unavailable. */
export function getSkillPathFromCommand(cmd: {
    source?: string;
    sourceInfo?: { path?: string };
}): string {
    if (cmd.source !== "skill") return "";
    return cmd.sourceInfo?.path ?? "";
}

function buildSkillIndex(pi: ExtensionAPI, cwd: string): SkillIndexEntry[] {
    return pi
        .getCommands()
        .filter((c) => c.source === "skill")
        .map((c) => {
            const p = getSkillPathFromCommand(c);
            const fullPath = p ? normalizeReadPath(p, cwd) : "";
            return {
                name: normalizeSkillName(c.name),
                skillFilePath: fullPath,
                skillDir: fullPath ? path.dirname(fullPath) : "",
            };
        })
        .filter((x) => x.name && x.skillDir);
}

const SKILL_LOADED_ENTRY = "context:skill_loaded";

type SkillLoadedEntryData = {
    name: string;
    path: string;
};

function getLoadedSkillsFromSession(ctx: ExtensionContext): Set<string> {
    const out = new Set<string>();
    for (const e of ctx.sessionManager.getEntries()) {
        if ((e as any)?.type !== "custom") continue;
        if ((e as any)?.customType !== SKILL_LOADED_ENTRY) continue;
        const data = (e as any)?.data as SkillLoadedEntryData | undefined;
        if (data?.name) out.add(data.name);
    }
    return out;
}

function extractCostTotal(usage: any): number {
    if (!usage) return 0;
    const c = usage?.cost;
    if (typeof c === "number") return Number.isFinite(c) ? c : 0;
    if (typeof c === "string") {
        const n = Number(c);
        return Number.isFinite(n) ? n : 0;
    }
    const t = c?.total;
    if (typeof t === "number") return Number.isFinite(t) ? t : 0;
    if (typeof t === "string") {
        const n = Number(t);
        return Number.isFinite(n) ? n : 0;
    }
    return 0;
}

function sumSessionUsage(ctx: ExtensionCommandContext): {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    totalCost: number;
} {
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let totalCost = 0;

    for (const entry of ctx.sessionManager.getEntries()) {
        if ((entry as any)?.type !== "message") continue;
        const msg = (entry as any)?.message;
        if (!msg || msg.role !== "assistant") continue;
        const usage = msg.usage;
        if (!usage) continue;
        input += Number(usage.inputTokens ?? 0) || 0;
        output += Number(usage.outputTokens ?? 0) || 0;
        cacheRead += Number(usage.cacheRead ?? 0) || 0;
        cacheWrite += Number(usage.cacheWrite ?? 0) || 0;
        totalCost += extractCostTotal(usage);
    }

    return {
        input,
        output,
        cacheRead,
        cacheWrite,
        totalTokens: input + output + cacheRead + cacheWrite,
        totalCost,
    };
}

function shortenPath(p: string, cwd: string): string {
    const rp = path.resolve(p);
    const rc = path.resolve(cwd);
    if (rp === rc) return ".";
    if (rp.startsWith(rc + path.sep)) return "./" + rp.slice(rc.length + 1);
    return rp;
}

function renderUsageBar(
    theme: any,
    parts: { system: number; tools: number; convo: number; remaining: number },
    total: number,
    width: number,
): string {
    const w = Math.max(10, width);
    if (total <= 0) return "";

    const toCols = (n: number) => Math.round((n / total) * w);
    let sys = toCols(parts.system);
    let tools = toCols(parts.tools);
    let con = toCols(parts.convo);
    let rem = w - sys - tools - con;
    if (rem < 0) rem = 0;
    // adjust rounding drift
    while (sys + tools + con + rem < w) rem++;
    while (sys + tools + con + rem > w && rem > 0) rem--;

    const colors = createUiColors(theme);
    const block = "█";
    const sysStr = colors.primary(block.repeat(sys));
    const toolsStr = colors.warning(block.repeat(tools));
    const conStr = colors.success(block.repeat(con));
    const remStr = colors.subtle(block.repeat(rem));
    return `${sysStr}${toolsStr}${conStr}${remStr}`;
}

function joinComma(items: string[]): string {
    return items.join(", ");
}

function joinCommaStyled(
    items: string[],
    renderItem: (item: string) => string,
    sep: string,
): string {
    return items.map(renderItem).join(sep);
}

export function calculateExtensionFiles(commands: any[]): string[] {
    const extensionCmds = commands.filter((c) => c.source === "extension");

    const extensionsByPath = new Map<string, string[]>();
    for (const c of extensionCmds) {
        const p = c.sourceInfo?.path ?? "<unknown>";
        const arr = extensionsByPath.get(p) ?? [];
        arr.push(c.name);
        extensionsByPath.set(p, arr);
    }

    const paths = [...extensionsByPath.keys()];

    // Disambiguate: for each path, use minimal dir-prefixed suffix that is
    // unique among all paths. Walk up directory by directory until unique.
    return paths
        .map((p) => {
            if (p === "<unknown>") return p;
            const bn = path.basename(p);
            let suffix = bn;
            let cursor = path.dirname(p);
            // Keep walking up while ANY other path ends with the same suffix
            // at a directory boundary (i.e. preceded by '/' or is the full path).
            while (true) {
                const collisions = paths.filter(
                    (other) =>
                        other !== "<unknown>" &&
                        other !== p &&
                        other.endsWith(`/${suffix}`),
                );
                if (collisions.length === 0) break;
                const parent = path.basename(cursor);
                suffix = `${parent}/${suffix}`;
                cursor = path.dirname(cursor);
            }
            return suffix;
        })
        .toSorted((a, b) => a.localeCompare(b));
}

/** Marker used to detect and avoid double-appending the tools list. Matches the heading Pi's default branch emits. */
export const TOOLS_LIST_HEADING = "Available tools:";

export function buildToolsListSnippet(
    tools: Array<{ name: string; description?: string }>,
): string {
    const lines = tools
        .filter((t) => t.name && t.description)
        .map((t) => `- ${t.name}: ${t.description!.trim().split(/\r?\n/)[0]}`);
    if (lines.length === 0) return `${TOOLS_LIST_HEADING}\n(none)`;
    return `${TOOLS_LIST_HEADING}\n${lines.join("\n")}`;
}

/**
 * Append the tools list to a system prompt when a SYSTEM.md override is set.
 *
 * Idempotent: if the tools heading is already present — from this handler or
 * Pi's default branch — the prompt is returned unchanged so chained
 * `before_agent_start` handlers do not stack duplicates.
 */
export function appendToolsListPrompt(
    systemPrompt: string,
    tools: Array<{ name: string; description?: string }>,
): string {
    if (systemPrompt.includes(TOOLS_LIST_HEADING)) {
        return systemPrompt;
    }
    return `${systemPrompt}\n\n${buildToolsListSnippet(tools)}`;
}

export function buildContextSendMessage(
    files: Array<{ path: string; content: string }>,
): string {
    if (files.length === 0) return "";
    const blocks = files.map(
        (f) =>
            `<project_instructions path="${f.path}">\n${f.content}\n</project_instructions>`,
    );
    return `Read and follow these project instruction files. They take precedence for this repository.\n\n${blocks.join("\n\n")}\n`;
}

type ContextViewData = {
    usage: {
        // message-based context usage estimate from ctx.getContextUsage()
        messageTokens: number;
        contextWindow: number;
        // effective usage incl. a rough tool-definition estimate
        effectiveTokens: number;
        percent: number;
        remainingTokens: number;
        systemPromptTokens: number;
        agentTokens: number;
        toolsTokens: number;
        activeTools: number;
    } | null;
    model: { id: string; provider: string; thinkingLevel: string } | null;
    agentFiles: string[];
    extensions: string[];
    tools: string[];
    skills: string[];
    loadedSkills: string[];
    session: { totalTokens: number; totalCost: number };
};

export class ContextView implements Component {
    private theme: any;
    private readonly tui: TUI;
    private readonly onDone: () => void;
    private readonly data: ContextViewData;
    private readonly topBorder: DynamicBorder;
    private readonly heading: Text;
    private readonly spacer: Text;
    private readonly body: Text;
    private readonly footer: Text;
    private readonly bottomBorder: DynamicBorder;
    private cachedWidth?: number;
    private scrollOffset = 0;
    private maxScroll = 0;
    private viewportRows = 1;

    constructor(
        tui: TUI,
        theme: any,
        data: ContextViewData,
        onDone: () => void,
    ) {
        this.theme = theme;
        this.tui = tui;
        this.data = data;
        this.onDone = onDone;

        const colors = createUiColors(theme);
        this.topBorder = new DynamicBorder((s) => colors.primary(s));
        this.heading = new Text(colors.primary(theme.bold("Context")), 1, 0);
        this.spacer = new Text("", 1, 0);
        this.body = new Text("", 1, 0);
        this.footer = new Text("", 1, 0);
        this.bottomBorder = new DynamicBorder((s) => colors.primary(s));
    }

    private rebuild(width: number): void {
        const colors = createUiColors(this.theme);
        const muted = (s: string) => colors.meta(s);
        const dim = (s: string) => colors.subtle(s);
        const text = (s: string) => colors.text(s);

        const lines: string[] = [];

        // Window + bar
        if (!this.data.usage) {
            lines.push(muted("Window: ") + dim("(unknown)"));
        } else {
            const u = this.data.usage;
            lines.push(
                muted("Window: ") +
                    text(
                        `~${u.effectiveTokens.toLocaleString()} / ${u.contextWindow.toLocaleString()}`,
                    ) +
                    muted(
                        `  (${u.percent.toFixed(1)}% used, ~${u.remainingTokens.toLocaleString()} left)`,
                    ),
            );

            // bar width tries to fit within the viewport
            const barWidth = Math.max(10, Math.min(36, width - 10));

            // Prorate system prompt into current message context estimate, then add tools estimate.
            const sysInMessages = Math.min(
                u.systemPromptTokens,
                u.messageTokens,
            );
            const convoInMessages = Math.max(
                0,
                u.messageTokens - sysInMessages,
            );
            const bar =
                renderUsageBar(
                    this.theme,
                    {
                        system: sysInMessages,
                        tools: u.toolsTokens,
                        convo: convoInMessages,
                        remaining: u.remainingTokens,
                    },
                    u.contextWindow,
                    barWidth,
                ) +
                " " +
                dim("sys") +
                colors.primary("█") +
                " " +
                dim("tools") +
                colors.warning("█") +
                " " +
                dim("convo") +
                colors.success("█") +
                " " +
                dim("free") +
                colors.subtle("█");
            lines.push(bar);
        }

        lines.push("");

        lines.push("");

        // Model info
        if (this.data.model) {
            const m = this.data.model;
            lines.push(
                muted("Model: ") +
                    text(m.id) +
                    muted(" · ") +
                    text(m.provider) +
                    muted(" · thinking: ") +
                    text(m.thinkingLevel),
            );
        } else {
            lines.push(muted("Model: ") + dim("(unknown)"));
        }

        // System prompt + tools totals (approx)
        if (this.data.usage) {
            const u = this.data.usage;
            lines.push(
                muted("System: ") +
                    text(`~${u.systemPromptTokens.toLocaleString()} tok`) +
                    muted(` (AGENTS ~${u.agentTokens.toLocaleString()})`),
            );
            lines.push(
                muted("Tools: ") +
                    text(`~${u.toolsTokens.toLocaleString()} tok`) +
                    muted(` (${u.activeTools} active)`),
            );
        }

        lines.push(
            muted(`AGENTS (${this.data.agentFiles.length}): `) +
                text(
                    this.data.agentFiles.length
                        ? joinComma(this.data.agentFiles)
                        : "(none)",
                ),
        );
        lines.push("");
        lines.push(
            muted(`Extensions (${this.data.extensions.length}): `) +
                text(
                    this.data.extensions.length
                        ? joinComma(this.data.extensions)
                        : "(none)",
                ),
        );

        // Tools section
        lines.push(
            muted(`Tools (${this.data.tools.length}): `) +
                text(
                    this.data.tools.length
                        ? joinComma(this.data.tools)
                        : "(none)",
                ),
        );

        const loaded = new Set(this.data.loadedSkills);
        const skillsRendered = this.data.skills.length
            ? joinCommaStyled(
                  this.data.skills,
                  (name) =>
                      loaded.has(name)
                          ? colors.text(name)
                          : colors.subtle(name),
                  colors.subtle(", "),
              )
            : "(none)";
        lines.push(
            muted(`Skills (${this.data.skills.length}): `) + skillsRendered,
        );
        lines.push("");
        lines.push(
            muted("Session: ") +
                text(
                    `${this.data.session.totalTokens.toLocaleString()} tokens`,
                ) +
                muted(" · ") +
                text(formatUsd(this.data.session.totalCost)),
        );

        this.body.setText(lines.join("\n"));
        this.cachedWidth = width;
    }

    private setScrollOffset(offset: number): void {
        const next = Math.max(0, Math.min(this.maxScroll, offset));
        if (next === this.scrollOffset) return;
        this.scrollOffset = next;
        this.tui.requestRender();
    }

    handleInput(data: string): void {
        if (
            matchesKey(data, Key.escape) ||
            matchesKey(data, Key.ctrl("c")) ||
            matchesKey(data, "q") ||
            matchesKey(data, Key.enter)
        ) {
            this.onDone();
            return;
        }

        if (matchesKey(data, Key.up)) {
            this.setScrollOffset(this.scrollOffset - 1);
        } else if (matchesKey(data, Key.down)) {
            this.setScrollOffset(this.scrollOffset + 1);
        } else if (matchesKey(data, Key.pageUp)) {
            this.setScrollOffset(this.scrollOffset - this.viewportRows);
        } else if (matchesKey(data, Key.pageDown)) {
            this.setScrollOffset(this.scrollOffset + this.viewportRows);
        } else if (matchesKey(data, Key.home)) {
            this.setScrollOffset(0);
        } else if (matchesKey(data, Key.end)) {
            this.setScrollOffset(this.maxScroll);
        }
    }

    invalidate(): void {
        this.topBorder.invalidate();
        this.heading.invalidate();
        this.spacer.invalidate();
        this.body.invalidate();
        this.footer.invalidate();
        this.bottomBorder.invalidate();
        this.cachedWidth = undefined;
    }

    render(width: number): string[] {
        if (this.cachedWidth !== width) this.rebuild(width);

        const top = [
            ...this.topBorder.render(width),
            ...this.heading.render(width),
            ...this.spacer.render(width),
        ];
        const body = this.body.render(width);
        const bottomBorder = this.bottomBorder.render(width);

        this.footer.setText(
            createUiColors(this.theme).subtle(
                "↑↓/PgUp/PgDn/Home/End scroll · Esc/q/Enter close",
            ),
        );
        let bottom = [...this.footer.render(width), ...bottomBorder];
        this.viewportRows = Math.max(
            1,
            this.tui.terminal.rows - top.length - bottom.length,
        );
        this.maxScroll = Math.max(0, body.length - this.viewportRows);
        this.scrollOffset = Math.min(this.scrollOffset, this.maxScroll);

        if (this.maxScroll > 0) {
            const end = Math.min(
                body.length,
                this.scrollOffset + this.viewportRows,
            );
            this.footer.setText(
                createUiColors(this.theme).subtle(
                    `lines ${this.scrollOffset + 1}–${end} of ${body.length} · ↑↓/PgUp/PgDn/Home/End · Esc close`,
                ),
            );
            bottom = [...this.footer.render(width), ...bottomBorder];
            this.viewportRows = Math.max(
                1,
                this.tui.terminal.rows - top.length - bottom.length,
            );
            this.maxScroll = Math.max(0, body.length - this.viewportRows);
            this.scrollOffset = Math.min(this.scrollOffset, this.maxScroll);
        }

        return [
            ...top,
            ...body.slice(
                this.scrollOffset,
                this.scrollOffset + this.viewportRows,
            ),
            ...bottom,
        ];
    }
}

export default function contextExtension(pi: ExtensionAPI) {
    // Track which skills were actually pulled in via read tool calls.
    let lastSessionId: string | null = null;
    let cachedLoadedSkills = new Set<string>();
    let cachedSkillIndex: SkillIndexEntry[] = [];

    const ensureCaches = (ctx: ExtensionContext) => {
        const sid = ctx.sessionManager.getSessionId();
        if (sid !== lastSessionId) {
            lastSessionId = sid;
            cachedLoadedSkills = getLoadedSkillsFromSession(ctx);
            cachedSkillIndex = buildSkillIndex(pi, ctx.cwd);
        }
        if (cachedSkillIndex.length === 0) {
            cachedSkillIndex = buildSkillIndex(pi, ctx.cwd);
        }
    };

    const matchSkillForPath = (absPath: string): string | null => {
        let best: SkillIndexEntry | null = null;
        for (const s of cachedSkillIndex) {
            if (!s.skillDir) continue;
            if (
                absPath === s.skillFilePath ||
                absPath.startsWith(s.skillDir + path.sep)
            ) {
                if (!best || s.skillDir.length > best.skillDir.length) best = s;
            }
        }
        return best?.name ?? null;
    };

    pi.on("tool_result", (event: ToolResultEvent, ctx: ExtensionContext) => {
        // Only count successful reads.
        if ((event as any).toolName !== "read") return;
        if ((event as any).isError) return;

        const input = (event as any).input as { path?: unknown } | undefined;
        const p = typeof input?.path === "string" ? input.path : "";
        if (!p) return;

        ensureCaches(ctx);
        const abs = normalizeReadPath(p, ctx.cwd);
        const skillName = matchSkillForPath(abs);
        if (!skillName) return;

        if (!cachedLoadedSkills.has(skillName)) {
            cachedLoadedSkills.add(skillName);
            pi.appendEntry<SkillLoadedEntryData>(SKILL_LOADED_ENTRY, {
                name: skillName,
                path: abs,
            });
        }
    });

    pi.on(
        "before_agent_start",
        (
            event: BeforeAgentStartEvent,
            _ctx: ExtensionContext,
        ): BeforeAgentStartEventResult | undefined => {
            // With a SYSTEM.md override, pi's default branch is skipped: it emits
            // skills + AGENTS files but NOT the tools list. Without an override the
            // default branch already lists tools, so skip to avoid duplication.
            if (!event.systemPromptOptions.customPrompt) return undefined;

            const activeToolNames = pi.getActiveTools();
            const toolInfoByName = new Map(
                pi.getAllTools().map((t) => [t.name, t] as const),
            );
            const tools = activeToolNames
                .map((name) => ({
                    name,
                    description: toolInfoByName.get(name)?.description ?? "",
                }))
                .filter((t) => t.name);

            return {
                systemPrompt: appendToolsListPrompt(event.systemPrompt, tools),
            };
        },
    );

    pi.registerCommand("context", {
        description: "Show loaded context overview",
        handler: async (_args, ctx: ExtensionCommandContext) => {
            const commands = pi.getCommands();
            const extensionFiles = calculateExtensionFiles(commands);

            const skillCmds = commands.filter((c) => c.source === "skill");

            const skills = skillCmds
                .map((c) => normalizeSkillName(c.name))
                .toSorted((a, b) => a.localeCompare(b));

            const agentFiles = await loadProjectContextFiles(ctx.cwd);
            const agentFilePaths = agentFiles.map((f) =>
                shortenPath(f.path, ctx.cwd),
            );
            const agentTokens = agentFiles.reduce((a, f) => a + f.tokens, 0);

            const systemPrompt = ctx.getSystemPrompt();
            const systemPromptTokens = systemPrompt
                ? estimateTokens(systemPrompt)
                : 0;

            const usage = ctx.getContextUsage();
            const messageTokens = usage?.tokens ?? 0;
            const ctxWindow = usage?.contextWindow ?? 0;

            // Tool definitions are not part of ctx.getContextUsage() (it estimates message tokens).
            // We approximate their token impact from tool name + description, and apply a fudge
            // factor to account for parameters/schema/formatting.
            const TOOL_FUDGE = 1.5;
            const activeToolNames = pi.getActiveTools();
            const toolInfoByName = new Map(
                pi.getAllTools().map((t) => [t.name, t] as const),
            );
            let toolsTokens = 0;
            for (const name of activeToolNames) {
                const info = toolInfoByName.get(name);
                const blob = `${name}\n${info?.description ?? ""}`;
                toolsTokens += estimateTokens(blob);
            }
            toolsTokens = Math.round(toolsTokens * TOOL_FUDGE);

            const effectiveTokens = messageTokens + toolsTokens;
            const percent =
                ctxWindow > 0 ? (effectiveTokens / ctxWindow) * 100 : 0;
            const remainingTokens =
                ctxWindow > 0 ? Math.max(0, ctxWindow - effectiveTokens) : 0;

            const sessionUsage = sumSessionUsage(ctx);

            const makePlainText = () => {
                const lines: string[] = [];
                lines.push("Context");
                if (usage) {
                    lines.push(
                        `Window: ~${effectiveTokens.toLocaleString()} / ${ctxWindow.toLocaleString()} (${percent.toFixed(1)}% used, ~${remainingTokens.toLocaleString()} left)`,
                    );
                } else {
                    lines.push("Window: (unknown)");
                }
                lines.push(
                    `System: ~${systemPromptTokens.toLocaleString()} tok (AGENTS ~${agentTokens.toLocaleString()})`,
                );
                lines.push(
                    `Tools: ~${toolsTokens.toLocaleString()} tok (${activeToolNames.length} active)`,
                );
                lines.push(
                    `AGENTS: ${agentFilePaths.length ? joinComma(agentFilePaths) : "(none)"}`,
                );
                lines.push(
                    `Extensions (${extensionFiles.length}): ${extensionFiles.length ? joinComma(extensionFiles) : "(none)"}`,
                );
                lines.push(
                    `Skills (${skills.length}): ${skills.length ? joinComma(skills) : "(none)"}`,
                );
                lines.push(
                    `Session: ${sessionUsage.totalTokens.toLocaleString()} tokens · ${formatUsd(sessionUsage.totalCost)}`,
                );
                return lines.join("\n");
            };

            if (!ctx.hasUI) {
                pi.sendMessage(
                    {
                        customType: "context",
                        content: makePlainText(),
                        display: true,
                    },
                    { triggerTurn: false },
                );
                return;
            }

            const loadedSkills = Array.from(
                getLoadedSkillsFromSession(ctx),
            ).toSorted((a, b) => a.localeCompare(b));

            const viewData: ContextViewData = {
                usage: usage
                    ? {
                          messageTokens,
                          contextWindow: ctxWindow,
                          effectiveTokens,
                          percent,
                          remainingTokens,
                          systemPromptTokens,
                          agentTokens,
                          toolsTokens,
                          activeTools: activeToolNames.length,
                      }
                    : null,
                model: ctx.model
                    ? {
                          id: ctx.model.id,
                          provider: ctx.model.provider,
                          thinkingLevel: pi.getThinkingLevel(),
                      }
                    : null,
                agentFiles: agentFilePaths,
                extensions: extensionFiles,
                tools: activeToolNames.toSorted((a, b) => a.localeCompare(b)),
                skills,
                loadedSkills,
                session: {
                    totalTokens: sessionUsage.totalTokens,
                    totalCost: sessionUsage.totalCost,
                },
            };

            await ctx.ui.custom<void>((tui, theme, _kb, done) => {
                return new ContextView(tui, theme, viewData, done);
            });
        },
    });

    pi.registerCommand("context-send", {
        description:
            "Inject applied AGENTS.md/CLAUDE.md contents into the conversation",
        handler: async (_args, ctx: ExtensionCommandContext) => {
            const files = await loadProjectContextFiles(ctx.cwd);
            if (files.length === 0) {
                pi.sendMessage(
                    {
                        customType: "context-send",
                        content:
                            "No applied AGENTS.md/CLAUDE.md context files found for this session.",
                        display: true,
                    },
                    { triggerTurn: false },
                );
                return;
            }

            const content = buildContextSendMessage(
                files.map((file) => ({
                    path: file.path,
                    content: requestMarkdownLinkTransform(pi.events, {
                        sourcePath: file.path,
                        content: file.content,
                        cwd: ctx.cwd,
                        sourceKind: "context-send-command",
                    }),
                })),
            );
            pi.sendMessage(
                {
                    customType: "context-send",
                    content,
                    display: true,
                },
                { triggerTurn: true },
            );
        },
    });
}
