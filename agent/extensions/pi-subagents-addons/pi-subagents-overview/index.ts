/**
 * Subagents Overview — /subagents-overview command + persistent widget
 *
 * Fully programmatic. No LLM involvement.
 * Reads agent configs, settings overrides, parses frontmatter,
 * and renders the overview directly into the conversation.
 * Also shows a persistent status widget in the Pi UI.
 *
 * Handles agent discovery filtering:
 * - Excludes `.agents/skills/` subdirectory (skill files aren't agents)
 * - Intercepts subagent({ action: "list" }) tool results to filter
 *   skill-derived agents from the LLM-visible agent list
 */

import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type {
    ExtensionAPI,
    ExtensionCommandContext,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
    Key,
    matchesKey,
    truncateToWidth,
    visibleWidth,
} from "@earendil-works/pi-tui";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { createWidget } from "../../_shared/fancy-footer";
import type { AsyncLiveRun, LiveRunSnapshot } from "./fleet-store.ts";
import { SubagentsLiveRuntime } from "./live-runtime.ts";
import { hasVisibleLiveRuns, renderLiveWidget } from "./live-ui.ts";
import { resolvePiSubagentsPackageRoot } from "./package-path.ts";
import {
    icon,
    SubagentsOverviewView,
    AgentDetailView,
    type SubagentsOverviewData,
} from "./ui";

// ── ANSI color constants ──────────────────────────────

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const BLUE = "\x1b[34m";
const RESET = "\x1b[0m";

const WIDGET_ID = "pi-subagents-overview-widget";
const LIVE_WIDGET_ID = "pi-subagents-live-widget";
const LIVE_REFRESH_MS = 500;
const COMPLETION_LINGER_MS = 5_000;

// ── Types ──────────────────────────────────────────────

interface AgentInfo {
    name: string;
    description: string;
    tools: string[];
    model: string | null;
    skills: string[];
    source: "builtin" | "user" | "project";
    context: string | null;
}

interface AgentOverride {
    tools?: string[] | false;
    model?: string | false;
    skills?: string[] | false;
    [key: string]: unknown;
}

// ── Paths ──────────────────────────────────────────────

const HOME = homedir();
const SETTINGS_PATH = path.join(HOME, ".pi", "agent", "settings.json");
const USER_AGENTS_DIR = path.join(HOME, ".pi", "agent", "agents");
const BUILTIN_AGENTS_DIR = path.join(resolvePiSubagentsPackageRoot(), "agents");
const SKILLS_DIR = path.join(HOME, ".agents", "skills");

// ── Frontmatter Parsing ────────────────────────────────

function parseAgentFile(filePath: string): Record<string, string> | null {
    try {
        const raw = fs.readFileSync(filePath, "utf-8");
        const { frontmatter } = parseFrontmatter<Record<string, string>>(raw);
        return frontmatter;
    } catch {
        return null;
    }
}

// ── Skill Agent Names ─────────────────────────────────
// Cache of agent names derived from `.agents/skills/` files.
// These are skill reference docs, not real agents.

let cachedSkillAgentNames: Set<string> | null = null;

function getSkillAgentNames(): Set<string> {
    if (cachedSkillAgentNames) return cachedSkillAgentNames;

    const names = new Set<string>();

    if (!fs.existsSync(SKILLS_DIR)) {
        cachedSkillAgentNames = names;
        return names;
    }

    function walkDir(dir: string): void {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walkDir(fullPath);
                continue;
            }
            if (!entry.isFile() && !entry.isSymbolicLink()) continue;
            if (!entry.name.endsWith(".md")) continue;

            const fm = parseAgentFile(fullPath);
            if (fm && fm.name && fm.description) {
                names.add(fm.name);
            }
        }
    }

    walkDir(SKILLS_DIR);
    cachedSkillAgentNames = names;
    return names;
}

function clearSkillAgentCache(): void {
    cachedSkillAgentNames = null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ── Data Collection ────────────────────────────────────

function readOverrides(): Record<string, AgentOverride> {
    try {
        const raw = fs.readFileSync(SETTINGS_PATH, "utf-8");
        const parsed: unknown = JSON.parse(raw);
        if (!isRecord(parsed) || !isRecord(parsed.subagents)) return {};
        const candidate = parsed.subagents.agentOverrides;
        if (!isRecord(candidate)) return {};
        const overrides: Record<string, AgentOverride> = {};
        for (const [name, value] of Object.entries(candidate)) {
            if (isRecord(value)) overrides[name] = value;
        }
        return overrides;
    } catch {
        return {};
    }
}

/**
 * Return the effective tool list for an agent, applying overrides from settings.json.
 */
function getEffectiveTools(
    agent: AgentInfo,
    overrides: Record<string, AgentOverride>,
): string[] {
    const override = overrides[agent.name];
    if (!override) return agent.tools;
    if (override.tools === false) return [];
    if (Array.isArray(override.tools)) return override.tools;
    return agent.tools;
}

function readBuiltinAgents(): AgentInfo[] {
    const agents: AgentInfo[] = [];
    const builtinNames = [
        "scout",
        "researcher",
        "planner",
        "worker",
        "reviewer",
        "context-builder",
        "oracle",
        "delegate",
    ];

    for (const name of builtinNames) {
        const filePath = path.join(BUILTIN_AGENTS_DIR, `${name}.md`);
        if (!fs.existsSync(filePath)) continue;
        const fm = parseAgentFile(filePath);
        if (!fm) continue;

        const toolsRaw = fm.tools || "";
        const tools = toolsRaw
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean);

        agents.push({
            name: fm.name || name,
            description: fm.description || "",
            tools,
            model: fm.model || null,
            skills: [],
            source: "builtin",
            context: fm.defaultContext || null,
        });
    }

    return agents;
}

function readUserAgents(): AgentInfo[] {
    const agents: AgentInfo[] = [];
    if (!fs.existsSync(USER_AGENTS_DIR)) return agents;

    for (const entry of fs.readdirSync(USER_AGENTS_DIR)) {
        if (!entry.endsWith(".md")) continue;
        const filePath = path.join(USER_AGENTS_DIR, entry);
        const fm = parseAgentFile(filePath);
        if (!fm) continue;

        agents.push({
            name: fm.name || entry.replace(/\.md$/, ""),
            description: fm.description || "",
            tools: (fm.tools || "")
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean),
            model: fm.model || null,
            skills: (fm.skills || "")
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            source: "user",
            context: fm.defaultContext || null,
        });
    }

    return agents;
}

/**
 * Read project agents from `.agents/` directory, EXCLUDING the `skills/`
 * subdirectory (those are skill definitions, not agents).
 */
// ── Widget formatting ─────────────────────────────────

function buildWidgetLine(): string {
    const overrides = readOverrides();
    const builtins = readBuiltinAgents();
    const users = readUserAgents();

    const total = builtins.length + users.length;
    const overrideCount = Object.keys(overrides).length;

    // Agents with safe_bash only (no plain bash) — applying overrides
    const safeBashAgents = [...builtins, ...users]
        .filter(
            (a) =>
                getEffectiveTools(a, overrides).includes("safe_bash") &&
                !getEffectiveTools(a, overrides).includes("bash"),
        )
        .map((a) => a.name);

    const safeBashPart =
        safeBashAgents.length > 0 ? ` · ${safeBashAgents.length} 🛡️sb` : "";

    const overridePart = overrideCount > 0 ? ` · ${overrideCount} ovr` : "";

    return `${icon}Subagents: ${builtins.length}B/${users.length}U${safeBashPart}${overridePart} (total ${total})`;
}

let widgetText: string | null = null;
let widgetHandle: ReturnType<typeof createWidget> | undefined;

function updateWidget(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    try {
        widgetText = buildWidgetLine();
        widgetHandle?.update(ctx);
    } catch {
        widgetText = null;
        widgetHandle?.update(ctx);
    }
}

// ── Formatting ─────────────────────────────────────────

function formatAgentBlock(
    agent: AgentInfo,
    overrides: Record<string, AgentOverride>,
): string[] {
    const lines: string[] = [];
    const override = overrides[agent.name];
    const hasOverride = override !== undefined;

    const paddedName = agent.name.padEnd(16);
    lines.push(`${BOLD}${paddedName}${RESET}${agent.description}`);

    const toolsLabel = hasOverride ? "Tools*" : "Tools";
    const toolsStr = agent.tools.length > 0 ? agent.tools.join(", ") : "—";
    const overrideMarker = hasOverride ? `  ${YELLOW}← OVERRIDDEN${RESET}` : "";
    lines.push(`  ${DIM}${toolsLabel}:${RESET} ${toolsStr}${overrideMarker}`);

    const modelStr = agent.model ?? `${DIM}(inherited from default)${RESET}`;
    lines.push(`  ${DIM}Model:${RESET} ${modelStr}`);

    const skillsStr =
        agent.skills.length > 0 ? agent.skills.join(", ") : `${DIM}—${RESET}`;
    lines.push(`  ${DIM}Skills:${RESET} ${skillsStr}`);

    if (agent.context) {
        lines.push(`  ${DIM}Context:${RESET} ${agent.context}`);
    }

    return lines;
}

function formatOverrideValue(value: unknown): string {
    if (typeof value === "string") return value;
    if (
        typeof value === "number" ||
        typeof value === "boolean" ||
        typeof value === "bigint"
    ) {
        return value.toString();
    }
    try {
        return JSON.stringify(value);
    } catch {
        return "[unserializable]";
    }
}

function formatOverview(includeBanner = true): string {
    const overrides = readOverrides();
    const builtins = readBuiltinAgents();
    const users = readUserAgents();

    const lines: string[] = [];

    if (includeBanner) {
        lines.push(
            "╔══════════════════════════════════════════════════════════╗",
        );
        lines.push(
            `${CYAN}║                    Subagents Overview                    ║${RESET}`,
        );
        lines.push(
            "╚══════════════════════════════════════════════════════════╝",
        );
        lines.push("");
    }

    // ── Builtin Agents ──
    lines.push(`${BOLD}${CYAN}🏗️ BUILTIN AGENTS${RESET}`);
    lines.push("");
    for (const agent of builtins) {
        lines.push(...formatAgentBlock(agent, overrides));
        lines.push("");
    }

    // ── User Agents ──
    lines.push(`${BOLD}${CYAN}👤  USER AGENTS${RESET}`);
    lines.push("");

    if (users.length === 0) {
        lines.push("  No user agents configured.");
        lines.push("");
    } else {
        const videographer = users.find((a) => a.name === "videographer");
        const others = users.filter((a) => a.name !== "videographer");

        if (videographer) {
            lines.push(...formatAgentBlock(videographer, overrides));
            lines.push("");
        }

        if (others.length > 0) {
            const notable = others.filter(
                (a) =>
                    a.tools.length > 0 &&
                    !(a.tools.length === 1 && a.tools[0] === "read"),
            );
            const shown = notable.length > 3 ? notable.slice(0, 3) : notable;

            for (const agent of shown) {
                lines.push(...formatAgentBlock(agent, overrides));
                lines.push("");
            }

            const remaining =
                others.length - (videographer ? 0 : 0) - shown.length;
            if (remaining > 0) {
                lines.push(
                    `  ... and ${remaining} more user agent(s) (run \`subagent({ action: "list" })\` to see all)`,
                );
                lines.push("");
            }
        }
    }

    // ── Active Overrides ──
    const overrideKeys = Object.keys(overrides);
    lines.push(`${BOLD}${YELLOW}🔧  ACTIVE SETTINGS OVERRIDES${RESET}`);
    lines.push("");

    if (overrideKeys.length === 0) {
        lines.push(`  ${DIM}No overrides configured.${RESET}`);
    } else {
        for (const [agentName, ov] of Object.entries(overrides)) {
            const overriddenFields = Object.entries(ov)
                .filter(
                    ([_key, val]) =>
                        val !== undefined && val !== null && val !== false,
                )
                .map(([key, val]) => {
                    if (Array.isArray(val))
                        return `    ${DIM}${key}:${RESET} ${val.join(", ")}`;
                    return `    ${DIM}${key}:${RESET} ${formatOverrideValue(val)}`;
                });
            if (overriddenFields.length > 0) {
                lines.push(`  ${BOLD}${agentName}${RESET}`);
                lines.push(...overriddenFields);
                lines.push("");
            }
        }
    }

    // ── Quick Stats ──
    lines.push(`${BOLD}${GREEN}📊  QUICK STATS${RESET}`);
    lines.push("");

    const totalAgents = builtins.length + users.length;
    lines.push(`  Total agents: ${BOLD}${totalAgents}${RESET}`);
    lines.push(
        `    ${BLUE}${builtins.length}${RESET} builtin  |  ${BLUE}${users.length}${RESET} user`,
    );

    // Agents with execution tools (applying overrides from settings.json)
    const allAgents = [...builtins, ...users];
    const agentsWithSafeBash = allAgents.filter(
        (a) =>
            getEffectiveTools(a, overrides).includes("safe_bash") &&
            !getEffectiveTools(a, overrides).includes("bash"),
    );
    const agentsWithPlainBash = allAgents.filter((a) =>
        getEffectiveTools(a, overrides).includes("bash"),
    );

    lines.push(
        `  ${GREEN}🔒${RESET} safe_bash enforced: ${BOLD}${agentsWithSafeBash.map((a) => a.name).join(", ") || "none"}${RESET}`,
    );
    lines.push(
        `  ${RED}⚠${RESET} plain bash (not restricted): ${BOLD}${agentsWithPlainBash.map((a) => a.name).join(", ") || "none"}${RESET}`,
    );

    const allSkills = [...builtins, ...users].flatMap((a) => a.skills);
    const uniqueSkills = [...new Set(allSkills)].filter(Boolean);
    const hasYoutube = uniqueSkills.includes("youtube-analysis");
    lines.push(
        `  Skills referenced by agents: ${uniqueSkills.length} (youtube-analysis: ${hasYoutube ? "✅" : "❌"})`,
    );

    lines.push("");
    lines.push(`${DIM}${"─".repeat(56)}${RESET}`);
    lines.push(
        `  ${DIM}* Tools marked with ← OVERRIDDEN have been modified via settings.json.${RESET}`,
    );
    lines.push(
        `  ${DIM}* Skill-derived agents (from .agents/skills/) are hidden from the LLM list.${RESET}`,
    );

    return lines.join("\n");
}

function buildOverviewData(): SubagentsOverviewData {
    const overrides = readOverrides();
    const builtins = readBuiltinAgents();
    const users = readUserAgents();
    const agents = [...builtins, ...users];
    const overrideFields = (agentName: string) =>
        Object.entries(overrides[agentName] ?? {})
            .filter(([, value]) => value !== undefined && value !== null)
            .map(([label, value]) => ({
                label,
                value: Array.isArray(value)
                    ? value.join(", ")
                    : formatOverrideValue(value),
            }));
    const safeBashAgents = agents
        .filter((agent) => {
            const tools = getEffectiveTools(agent, overrides);
            return tools.includes("safe_bash") && !tools.includes("bash");
        })
        .map((agent) => agent.name);
    const plainBashAgents = agents
        .filter((agent) => getEffectiveTools(agent, overrides).includes("bash"))
        .map((agent) => agent.name);
    const uniqueSkills = new Set(
        agents.flatMap((agent) => agent.skills).filter(Boolean),
    );

    return {
        agents: agents.map((agent) => {
            const overrideModel = overrides[agent.name]?.model;
            return {
                name: agent.name,
                description: agent.description,
                tools: getEffectiveTools(agent, overrides),
                model:
                    typeof overrideModel === "string"
                        ? overrideModel
                        : (agent.model ?? "inherited from default"),
                skills: agent.skills,
                source: agent.source,
                context: agent.context,
                overrideFields: overrideFields(agent.name),
            };
        }),
        overrides: Object.keys(overrides).map((agentName) => ({
            agentName,
            fields: overrideFields(agentName),
        })),
        stats: {
            builtinCount: builtins.length,
            userCount: users.length,
            safeBashAgents,
            plainBashAgents,
            skillCount: uniqueSkills.size,
        },
    };
}

// ── Tool Result Interception ──────────────────────────

/**
 * Build a regex pattern that matches lines containing skill-derived agent names
 * in the subagent list output.
 * Pattern matches lines like: "- agent-name (project):" or "- agent-name (user):"
 */
function buildSkillAgentFilterPattern(skillNames: Set<string>): RegExp | null {
    if (skillNames.size === 0) return null;

    // Escape special regex characters in agent names
    const escapedNames: string[] = [];
    for (const name of skillNames) {
        escapedNames.push(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    }

    // Match lines that start with "- <name> (" (the subagent list format)
    const pattern = `^- (${escapedNames.join("|")})\\s*\\(`;
    return new RegExp(pattern, "m");
}

function formatLiveSnapshot(snapshot: LiveRunSnapshot): string {
    const lines = [
        "",
        "LIVE RUNS",
        snapshot.fleetAvailable
            ? `${snapshot.totalActive} active${snapshot.omitted > 0 ? ` · +${snapshot.omitted} omitted` : ""}`
            : "Fleet RPC unavailable · showing tracked async runs only",
    ];
    if (snapshot.runs.length === 0) {
        lines.push("No subagent runs in this session.");
        return lines.join("\n");
    }
    for (const run of snapshot.runs) {
        const state = run.source === "fleet" ? "active" : run.state;
        lines.push(
            `- ${run.agent}${run.role ? `:${run.role}` : ""} · ${state} · ${run.tokens.total} tokens${run.goal ? ` · ${run.goal}` : ""}`,
        );
        if (run.source === "fleet") {
            lines.push(
                "  Transcript: open the native inspector with Ctrl+Alt+F.",
            );
        }
    }
    return lines.join("\n");
}

// ── Extension ──────────────────────────────────────────

export default function (pi: ExtensionAPI) {
    const liveRuntime = new SubagentsLiveRuntime(pi.events);
    let currentContext: ExtensionContext | undefined;
    let stopLivePolling: (() => void) | undefined;
    let stopLiveHideTimer: (() => void) | undefined;
    let stopWidgetRegistrationTimer: (() => void) | undefined;
    let liveViewOpen = false;
    let subagentToolActive = false;
    let closeOverviewForNativeFleet: (() => void) | undefined;
    let stopTerminalInputListener: (() => void) | undefined;

    const clearLiveTimers = (): void => {
        stopLivePolling?.();
        stopLiveHideTimer?.();
        stopWidgetRegistrationTimer?.();
        stopLivePolling = undefined;
        stopLiveHideTimer = undefined;
        stopWidgetRegistrationTimer = undefined;
    };

    const syncLiveUi = (): void => {
        const ctx = currentContext;
        if (!ctx || ctx.mode !== "tui") return;
        const snapshot = liveRuntime.store.snapshot();
        const now = Date.now();
        const visible = hasVisibleLiveRuns(snapshot, now);
        if (visible) {
            ctx.ui.setWidget(
                LIVE_WIDGET_ID,
                (_tui, theme) => ({
                    render: (width: number) =>
                        renderLiveWidget(
                            liveRuntime.store.snapshot(),
                            theme,
                            width,
                            Date.now(),
                        ),
                    invalidate: () => {},
                }),
                { placement: "belowEditor" },
            );
        } else {
            ctx.ui.setWidget(LIVE_WIDGET_ID, undefined);
        }

        stopLiveHideTimer?.();
        stopLiveHideTimer = undefined;
        const recentCompletions = snapshot.runs
            .filter(
                (run): run is AsyncLiveRun =>
                    run.source === "async" && run.completedAt !== undefined,
            )
            .map((run) => run.completedAt ?? 0)
            .filter((completedAt) => now - completedAt <= COMPLETION_LINGER_MS);
        if (recentCompletions.length > 0) {
            const nextExpiry =
                Math.min(...recentCompletions) + COMPLETION_LINGER_MS;
            const hideTimer = setTimeout(
                syncLiveUi,
                Math.max(1, nextExpiry - now + 10),
            );
            stopLiveHideTimer = () => clearTimeout(hideTimer);
            hideTimer.unref?.();
        }

        const shouldPoll =
            visible ||
            liveViewOpen ||
            subagentToolActive ||
            liveRuntime.hasActiveForegroundDelegations();
        if (shouldPoll && !stopLivePolling) {
            const pollTimer = setInterval(() => {
                void liveRuntime.refresh();
            }, LIVE_REFRESH_MS);
            stopLivePolling = () => clearInterval(pollTimer);
            pollTimer.unref?.();
        } else if (!shouldPoll && stopLivePolling) {
            stopLivePolling();
            stopLivePolling = undefined;
        }
    };

    const unsubscribeLiveStore = liveRuntime.store.subscribe(syncLiveUi);
    const unsubscribeForegroundActivity =
        liveRuntime.subscribeForegroundActivity(syncLiveUi);

    const handleLiveAction = async (
        ctx: ExtensionCommandContext,
        action: "steer" | "interrupt" | "stop",
        run: AsyncLiveRun,
    ): Promise<void> => {
        try {
            if (action === "steer") {
                const message = await ctx.ui.input(
                    `Steer ${run.agent}`,
                    "New instruction",
                );
                if (!message?.trim()) return;
                await liveRuntime.control(action, run, message);
            } else {
                const confirmed = await ctx.ui.confirm(
                    action === "stop" ? "Stop subagent" : "Interrupt subagent",
                    `${action === "stop" ? "Stop" : "Interrupt"} ${run.agent} (${run.id})?`,
                );
                if (!confirmed) return;
                await liveRuntime.control(action, run);
            }
            ctx.ui.notify(`${action} sent to ${run.agent}.`, "info");
            await liveRuntime.refresh();
        } catch (error) {
            ctx.ui.notify(
                error instanceof Error
                    ? error.message
                    : "Subagent control failed.",
                "error",
            );
        }
    };
    // Register a renderer for the custom message type
    pi.registerMessageRenderer(
        "pi-subagents-overview",
        (message, _options, _theme) => {
            const content =
                typeof message.content === "string" ? message.content : "";
            const lines = content.split("\n");

            return {
                render: (width: number) =>
                    lines.map((line) => {
                        const vw = visibleWidth(line);
                        if (vw <= width) return line;
                        return truncateToWidth(line, width);
                    }),
                invalidate: () => {},
            };
        },
    );

    // ── Intercept subagent tool results ──

    pi.on("tool_result", (event) => {
        if (event.toolName !== "subagent" || event.input.action !== "list") {
            return undefined;
        }
        if (event.content.length === 0) return undefined;

        const skillNames = getSkillAgentNames();
        if (skillNames.size === 0) return undefined;

        const filterPattern = buildSkillAgentFilterPattern(skillNames);
        if (!filterPattern) return undefined;

        const filteredContent = event.content.map((entry) => {
            if (entry.type !== "text") return entry;

            const text = entry.text;
            if (!text.includes("(project)") && !text.includes("(user)")) {
                return entry; // Only filter list entries with scope markers
            }

            // Filter out lines matching skill-derived agent names
            const lines = text.split("\n");
            const filteredLines = lines.filter((line) => {
                const trimmed = line.trim();
                // Check if line matches "- <skill-agent-name> ("
                return !filterPattern.test(trimmed);
            });

            return Object.assign({}, entry, { text: filteredLines.join("\n") });
        });

        return { content: filteredContent };
    });

    // ── Commands ──

    pi.registerCommand("subagents-overview", {
        description:
            "Show a clean overview of all subagents with tools, models, overrides, and stats",
        handler: async (_args, ctx) => {
            if (ctx.mode !== "tui") {
                const overview = formatOverview(true);
                console.log(
                    `${overview}\n${formatLiveSnapshot(liveRuntime.store.snapshot())}`,
                );
                return;
            }

            syncLiveUi();
            let closeThisOverview: (() => void) | undefined;
            try {
                await ctx.ui.custom<void>(
                    (tui, theme, _kb, done) => {
                        closeThisOverview = () => done(undefined);
                        closeOverviewForNativeFleet = closeThisOverview;
                        return new SubagentsOverviewView({
                            theme,
                            data: buildOverviewData(),
                            done: closeThisOverview,
                            requestRender: () => tui.requestRender(),
                            getTerminalRows: () => tui.terminal?.rows ?? 32,
                            getLiveSnapshot: () => liveRuntime.store.snapshot(),
                            onAction: (action, run) => {
                                if (
                                    run.source === "async" &&
                                    run.controllable
                                ) {
                                    return handleLiveAction(ctx, action, run);
                                }
                                return undefined;
                            },
                            onLiveVisibilityChange: (visible) => {
                                liveViewOpen = visible;
                                syncLiveUi();
                            },
                        });
                    },
                    {
                        overlay: true,
                        overlayOptions: {
                            anchor: "center",
                            width: "80%",
                            maxHeight: "85%",
                        },
                    },
                );
            } finally {
                if (closeOverviewForNativeFleet === closeThisOverview) {
                    closeOverviewForNativeFleet = undefined;
                }
                liveViewOpen = false;
                syncLiveUi();
            }
        },
    });

    pi.registerCommand("subagent-view", {
        description:
            "Show details for a specific subagent: /subagent-view <name>",
        getArgumentCompletions: (prefix: string): AutocompleteItem[] => {
            const builtins = readBuiltinAgents();
            const users = readUserAgents();
            const allAgents = [...builtins, ...users];

            const lowerPrefix = prefix.toLowerCase();
            return allAgents
                .filter((a) => a.name.toLowerCase().includes(lowerPrefix))
                .map((a) => ({
                    value: a.name,
                    label: a.name,
                    description: `${a.source} — ${a.description.substring(0, 60)}`,
                }))
                .slice(0, 30);
        },
        handler: async (args, ctx) => {
            const name = args.trim();
            if (!name) {
                if (ctx.mode !== "tui") {
                    console.log(
                        "Usage: /subagent-view <name>\nExample: /subagent-view worker",
                    );
                    return;
                }

                await ctx.ui.custom<void>(
                    (tui, theme, _kb, done) =>
                        new AgentDetailView({
                            theme,
                            content:
                                "Usage: /subagent-view <name>\nExample: /subagent-view worker\n\nRun /subagents-overview to see all available agents.",
                            agentName: "help",
                            done: () => done(undefined),
                            requestRender: () => tui.requestRender(),
                        }),
                    {
                        overlay: true,
                        overlayOptions: {
                            anchor: "center",
                            width: "80%",
                            maxHeight: "85%",
                        },
                    },
                );
                return;
            }

            const overrides = readOverrides();
            const allAgents = [...readBuiltinAgents(), ...readUserAgents()];
            const agent = allAgents.find((a) => a.name === name);

            if (!agent) {
                if (ctx.mode !== "tui") {
                    console.log(`Agent "${name}" not found.`);
                    return;
                }

                await ctx.ui.custom<void>(
                    (tui, theme, _kb, done) =>
                        new AgentDetailView({
                            theme,
                            content: `Agent "${name}" not found.\nRun /subagents-overview to see all available agents.`,
                            agentName: "error",
                            done: () => done(undefined),
                            requestRender: () => tui.requestRender(),
                        }),
                    {
                        overlay: true,
                        overlayOptions: {
                            anchor: "center",
                            width: "80%",
                            maxHeight: "85%",
                        },
                    },
                );
                return;
            }

            const lines: string[] = [];
            lines.push(`  ${DIM}Description:${RESET} ${agent.description}`);
            lines.push(`  ${DIM}Source:${RESET} ${agent.source}`);
            lines.push(
                `  ${DIM}Tools:${RESET} ${getEffectiveTools(agent, overrides).join(", ") || "—"}`,
            );
            lines.push(
                `  ${DIM}Model:${RESET} ${agent.model ?? `${DIM}(inherited from default)${RESET}`}`,
            );
            lines.push(
                `  ${DIM}Skills:${RESET} ${agent.skills.join(", ") || `${DIM}—${RESET}`}`,
            );
            if (agent.context)
                lines.push(`  ${DIM}Default context:${RESET} ${agent.context}`);

            const override = overrides[agent.name];
            if (override) {
                lines.push("");
                lines.push(`  ${YELLOW}🔧 Active overrides:${RESET}`);
                for (const [key, val] of Object.entries(override)) {
                    if (val === undefined || val === null || val === false)
                        continue;
                    const valStr = Array.isArray(val)
                        ? val.join(", ")
                        : formatOverrideValue(val);
                    lines.push(`    ${DIM}${key}:${RESET} ${valStr}`);
                }
            }

            if (agent.source === "user") {
                const filePath = path.join(USER_AGENTS_DIR, `${agent.name}.md`);
                if (fs.existsSync(filePath)) {
                    lines.push("");
                    lines.push(`  File: ${filePath}`);
                }
            }

            if (ctx.mode !== "tui") {
                console.log(lines.join("\n"));
                return;
            }

            await ctx.ui.custom<void>(
                (tui, theme, _kb, done) =>
                    new AgentDetailView({
                        theme,
                        content: lines.join("\n"),
                        agentName: agent.name,
                        done: () => done(undefined),
                        requestRender: () => tui.requestRender(),
                    }),
                {
                    overlay: true,
                    overlayOptions: {
                        anchor: "center",
                        width: "80%",
                        maxHeight: "85%",
                    },
                },
            );
        },
    });

    // ── Persistent Widget ─

    widgetHandle = createWidget(pi, {
        id: WIDGET_ID,
        label: "Subagents",
        description: "Shows subagent counts (builtin/user) and tools in use.",
        row: 1,
        order: 2,
        align: "left",
        render: () => widgetText,
    });

    pi.on("session_start", async (_event, ctx) => {
        currentContext = ctx;
        stopTerminalInputListener?.();
        stopTerminalInputListener = ctx.ui.onTerminalInput((data) => {
            const closeOverview = closeOverviewForNativeFleet;
            if (!closeOverview || !matchesKey(data, Key.ctrlAlt("f"))) {
                return undefined;
            }
            closeOverview();
            return { data };
        });
        clearSkillAgentCache();
        await liveRuntime.beginSession(
            ctx.sessionManager.getSessionId() ?? undefined,
        );
        // Defer registration to yield to git-status-widget's async setWidget()
        stopWidgetRegistrationTimer?.();
        const registrationTimer = setTimeout(() => {
            stopWidgetRegistrationTimer = undefined;
            updateWidget(ctx);
        }, 0);
        stopWidgetRegistrationTimer = () => clearTimeout(registrationTimer);
        registrationTimer.unref?.();
        syncLiveUi();
    });

    pi.on("input", async (_event, ctx) => {
        currentContext = ctx;
        updateWidget(ctx);
        return { action: "continue" };
    });

    pi.on("tool_execution_start", async (event, ctx) => {
        currentContext = ctx;
        if (event.toolName !== "subagent") return;
        subagentToolActive = true;
        syncLiveUi();
        await liveRuntime.refresh();
    });

    pi.on("tool_execution_end", async (event, ctx) => {
        currentContext = ctx;
        updateWidget(ctx);
        if (event.toolName !== "subagent") return;
        subagentToolActive = false;
        await liveRuntime.refresh();
        syncLiveUi();
    });

    pi.on("session_shutdown", async (_event, ctx) => {
        clearLiveTimers();
        stopTerminalInputListener?.();
        stopTerminalInputListener = undefined;
        closeOverviewForNativeFleet = undefined;
        unsubscribeLiveStore();
        unsubscribeForegroundActivity();
        liveRuntime.dispose();
        widgetHandle?.remove(ctx);
        ctx.ui.setWidget(LIVE_WIDGET_ID, undefined);
        currentContext = undefined;
    });
}
