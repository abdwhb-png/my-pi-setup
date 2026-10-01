/**
 * pi-skill-gate — Interactive skill visibility manager.
 *
 * Overlay-based UI for toggling skill visibility and browsing skill bodies.
 * Reads Pi's active skill catalog without initializing resource loaders.
 *
 * Persistence: ~/.pi/agent/config/skill-gate.json
 * Supports per-project overrides via the "projects" key, with portable project paths.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type {
    ExtensionAPI,
    Skill,
    Theme,
} from "@earendil-works/pi-coding-agent";
import {
    copyToClipboard,
    loadSkills,
    getAgentDir,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { rewriteProviderSystemPrompt } from "../_shared/provider-system-prompt.ts";
import { createUiColors } from "../_shared/ui/ui-colors.ts";
import { SkillDetailOverlay, invalidateAllSkillBodies } from "./overlay.ts";
import { skillCatalogFilter } from "./prompt.ts";
import type {
    EditScope,
    RowData,
    SkillAnalytics,
    SkillGateConfig,
    SkillGateTheme,
} from "./types.ts";

import {
    loadConfig,
    loadEffectiveState,
    persistBulkToggle,
    resetScope,
} from "../_shared/skill-visibility.ts";
export {
    loadConfig,
    loadEffectiveState,
    persistBulkToggle,
    resetScope,
} from "../_shared/skill-visibility.ts";

function analyticsPath(): string {
    return path.join(getAgentDir(), "config", "skill-gate-analytics.json");
}

// ── Analytics persistence ──

export function loadAnalytics(): SkillAnalytics {
    const file = analyticsPath();
    if (!fs.existsSync(file)) return { counts: {} };
    const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new Error(`Invalid skill usage data: ${file}`);
    if (!("counts" in raw)) return { counts: {} };
    const counts = raw.counts;
    if (!counts || typeof counts !== "object" || Array.isArray(counts))
        throw new Error(`Invalid skill usage counts: ${file}`);
    const entries: Array<[string, unknown]> = Object.entries(counts);
    return {
        counts: Object.fromEntries(
            entries.map(([name, count]) => {
                if (
                    typeof count !== "number" ||
                    !Number.isSafeInteger(count) ||
                    count < 0
                )
                    throw new Error(`Invalid usage count for ${name}`);
                return [name, count];
            }),
        ),
    };
}

export function saveAnalytics(a: SkillAnalytics): void {
    fs.mkdirSync(path.dirname(analyticsPath()), { recursive: true });
    fs.writeFileSync(analyticsPath(), JSON.stringify(a, null, 2), "utf-8");
}

/** Increment usage count for one or more skill names. Returns the number of
 *  skills actually incremented (zero = no write). */
export function incrementSkillUsage(names: string[]): number {
    const a = loadAnalytics();
    let changed = 0;
    const seen = new Set<string>();
    for (const name of names) {
        if (seen.has(name)) continue;
        seen.add(name);
        if (!a.counts[name]) {
            a.counts[name] = 1;
        } else {
            a.counts[name]++;
        }
        changed++;
    }
    if (changed > 0) saveAnalytics(a);
    return changed;
}

export function loadActiveSkills(
    pi: Pick<ExtensionAPI, "getCommands">,
    cwd: string,
): Skill[] {
    const skillPaths = [
        ...new Set(
            pi
                .getCommands()
                .filter((command) => command.source === "skill")
                .map((command) => command.sourceInfo.path)
                .filter(Boolean),
        ),
    ];
    const result = loadSkills({
        cwd,
        agentDir: getAgentDir(),
        skillPaths,
        includeDefaults: false,
    });
    if (result.skills.length !== skillPaths.length) {
        throw new Error(
            result.diagnostics
                .map(
                    (diagnostic) => `${diagnostic.path}: ${diagnostic.message}`,
                )
                .join("\n"),
        );
    }
    return result.skills;
}

// ── Theme factory ──

export function makeTheme(piTheme: Theme): SkillGateTheme {
    const colors = createUiColors(piTheme);
    return {
        accent: colors.primary,
        dim: colors.subtle,
        muted: colors.muted,
        warning: colors.warning,
        error: colors.danger,
        bold: (t: string) => piTheme.bold(t),
        enabled: colors.success,
        selCell: (t: string) => piTheme.fg("accent", piTheme.bold(t)),
        selRow: colors.primary,
        nativeDisabled: colors.subtle,
    };
}

// ── Extension ──

/* oxlint-disable eslint/no-await-in-loop -- Overlay, confirmation and editor must finish before reopening the UI. */
export default function piSkillGate(pi: ExtensionAPI): void {
    let cachedSkills: Skill[] = [];
    let lastConfig: SkillGateConfig | undefined;
    let warning: string | undefined;
    pi.on("session_start", (_event, ctx) => {
        cachedSkills = loadActiveSkills(pi, ctx.cwd);
    });

    // ── Analytics: count /skill:name invocations ──
    pi.on("input", (event, ctx) => {
        // Match /skill:name patterns (skill names are alphanumeric plus hyphens/underscores)
        const matches = event.text.matchAll(/\/skill:([\w-]+)/g);
        const names = new Set<string>();
        for (const m of matches) names.add(m[1]);
        if (names.size > 0) {
            try {
                incrementSkillUsage([...names]);
            } catch (error) {
                ctx.ui.notify(
                    `Skill usage was not saved: ${error instanceof Error ? error.message : String(error)}`,
                    "error",
                );
            }
        }
        return { action: "continue" };
    });

    pi.on("before_agent_start", (_event, ctx) => {
        cachedSkills = loadActiveSkills(pi, ctx.cwd);
    });
    pi.on("before_provider_request", (event, ctx) => {
        let config: SkillGateConfig;
        try {
            config = loadConfig();
            lastConfig = config;
        } catch (error) {
            ctx.ui.notify(
                `Skill visibility configuration unavailable: ${error instanceof Error ? error.message : String(error)}`,
                "error",
            );
            if (!lastConfig) return undefined;
            config = lastConfig;
        }
        const filter = skillCatalogFilter(
            cachedSkills,
            config,
            ctx.cwd === homedir() ? undefined : ctx.cwd,
        );
        if (!filter) return undefined;
        try {
            const payload = rewriteProviderSystemPrompt(
                ctx.model?.api ?? "unknown",
                event.payload,
                filter,
                filter,
            );
            warning = undefined;
            return payload;
        } catch (error) {
            const reason =
                error instanceof Error ? error.message : String(error);
            if (warning !== reason)
                ctx.ui.notify(
                    `Skill visibility was not applied: ${reason}`,
                    "warning",
                );
            warning = reason;
            return undefined;
        }
    });

    // ── /skill-gate command ──
    pi.registerCommand("skill-gate", {
        description: "Manage which skills the model can see",
        handler: async (_args, ctx) => {
            if (ctx.mode !== "tui") {
                ctx.ui.notify(
                    "/skill-gate requires an interactive terminal",
                    "warning",
                );
                return;
            }
            let config: SkillGateConfig;
            let skills: Skill[];
            try {
                config = loadConfig();
                skills = loadActiveSkills(pi, ctx.cwd);
            } catch (error) {
                ctx.ui.notify(
                    `Cannot open skill-gate: ${error instanceof Error ? error.message : String(error)}`,
                    "error",
                );
                return;
            }
            if (skills.length === 0) {
                ctx.ui.notify("No skills discovered", "warning");
                return;
            }

            const projectPath = ctx.cwd !== homedir() ? ctx.cwd : undefined;
            const projectName = projectPath
                ? path.basename(projectPath)
                : undefined;

            const buildRows = (): RowData[] => {
                let analytics: SkillAnalytics = { counts: {} };
                try {
                    analytics = loadAnalytics();
                } catch (error) {
                    ctx.ui.notify(
                        `Skill usage unavailable: ${error instanceof Error ? error.message : String(error)}`,
                        "warning",
                    );
                }
                const data: RowData[] = skills.map((s) => ({
                    name: s.name,
                    description: s.description,
                    filePath: s.filePath,
                    disableModelInvocation: s.disableModelInvocation,
                    ...loadEffectiveState(s.name, config, projectPath),
                    globalEnabled:
                        loadEffectiveState(s.name, config).state === "enabled",
                    usageCount: analytics.counts[s.name] || 0,
                }));
                data.sort((a, b) => a.name.localeCompare(b.name));
                return data;
            };

            let lastSkill: string | undefined;
            let terminal: TUI | undefined;

            while (true) {
                let editingScope: EditScope = "global";
                const rows = buildRows();

                // Open the detail overlay directly
                const outcome = await ctx.ui.custom<
                    | { type: "close" }
                    | { type: "invoke"; name: string }
                    | { type: "edit"; name: string; filePath: string }
                >(
                    (tui, piTheme, _kb, done) => {
                        terminal = tui;
                        let overlay: SkillDetailOverlay;

                        /** Refresh effective state for one skill after a mutation. */
                        const refreshSkill = (name: string) => {
                            const { state, source } = loadEffectiveState(
                                name,
                                config,
                                projectPath,
                            );
                            const row = rows.find((r) => r.name === name);
                            if (row) {
                                row.state = state;
                                row.source = source;
                                row.globalEnabled =
                                    loadEffectiveState(name, config).state ===
                                    "enabled";
                            }
                        };

                        const T = makeTheme(piTheme);
                        const initIdx = lastSkill
                            ? rows.findIndex((r) => r.name === lastSkill)
                            : 0;
                        overlay = new SkillDetailOverlay(
                            rows,
                            Math.max(0, initIdx),
                            () => tui.terminal.rows,
                            T,
                            editingScope,
                            projectName,
                            !!projectPath,
                        );
                        overlay.onClose = () => done({ type: "close" });
                        overlay.onInvoke = (name) =>
                            done({ type: "invoke", name });
                        overlay.onEdit = (name, filePath) =>
                            done({ type: "edit", name, filePath });
                        overlay.onYank = async (name, body) => {
                            try {
                                await copyToClipboard(body);
                                ctx.ui.notify(
                                    `Yanked ${name} body to clipboard`,
                                    "info",
                                );
                            } catch {
                                ctx.ui.notify(
                                    `Failed to copy ${name} body to clipboard`,
                                    "error",
                                );
                            }
                        };
                        overlay.onToggle = (name, state) => {
                            try {
                                persistBulkToggle(
                                    [name],
                                    state,
                                    config,
                                    editingScope,
                                    projectPath,
                                );
                            } catch (error) {
                                ctx.ui.notify(
                                    `Skill choice was not saved: ${error instanceof Error ? error.message : String(error)}`,
                                    "error",
                                );
                            }
                            refreshSkill(name);
                            tui.requestRender();
                        };
                        overlay.onScopeToggle = () => {
                            editingScope =
                                editingScope === "global"
                                    ? "project"
                                    : "global";
                            overlay.setEditingScope(editingScope);
                            tui.requestRender();
                        };
                        const mutate = (
                            operation: () => number,
                            label: string,
                        ) => {
                            try {
                                const count = operation();
                                ctx.ui.notify(
                                    count
                                        ? `${label} ${count} choices in ${editingScope}`
                                        : "No choices changed",
                                    "info",
                                );
                            } catch (error) {
                                ctx.ui.notify(
                                    `Skill choices were not saved: ${error instanceof Error ? error.message : String(error)}`,
                                    "error",
                                );
                            }
                            for (const skill of skills)
                                refreshSkill(skill.name);
                            tui.requestRender();
                        };
                        overlay.onEnableAll = (names) =>
                            mutate(
                                () =>
                                    persistBulkToggle(
                                        names,
                                        "enabled",
                                        config,
                                        editingScope,
                                        projectPath,
                                    ),
                                "Enabled",
                            );
                        overlay.onDisableAll = (names) =>
                            mutate(
                                () =>
                                    persistBulkToggle(
                                        names,
                                        "disabled",
                                        config,
                                        editingScope,
                                        projectPath,
                                    ),
                                "Disabled",
                            );
                        overlay.onResetScope = () =>
                            mutate(
                                () =>
                                    resetScope(
                                        config,
                                        editingScope,
                                        projectPath,
                                    ),
                                "Reset",
                            );
                        return {
                            render: (w: number) => overlay.render(w),
                            invalidate: () => overlay.invalidate(),
                            handleInput: (d: string) => {
                                overlay.handleInput(d);
                                tui.requestRender();
                            },
                        };
                    },
                    {
                        overlay: true,
                        overlayOptions: {
                            width: "80%",
                            minWidth: 45,
                            maxHeight: "80%",
                            anchor: "center",
                            margin: 2,
                        },
                    },
                );

                if (outcome.type === "close") return;

                if (outcome.type === "invoke") {
                    const ok = await ctx.ui.confirm(
                        `Invoke ${outcome.name}?`,
                        "The full skill content will be added to the chat.",
                    );
                    if (ok) {
                        ctx.ui.setEditorText(`/skill:${outcome.name} `);
                        ctx.ui.notify(`Loaded /skill:${outcome.name}`, "info");
                        return;
                    }
                    lastSkill = outcome.name;
                    continue;
                }

                if (outcome.type === "edit") {
                    const editorCmd = process.env.VISUAL || process.env.EDITOR;
                    if (!editorCmd) {
                        ctx.ui.notify(
                            "No editor configured. Set $VISUAL or $EDITOR.",
                            "warning",
                        );
                        lastSkill = outcome.name;
                        continue;
                    }
                    if (!fs.existsSync(outcome.filePath)) {
                        ctx.ui.notify(
                            `Skill file not found: ${outcome.filePath}`,
                            "error",
                        );
                        lastSkill = outcome.name;
                        continue;
                    }
                    const [editor, ...editorArgs] = editorCmd.split(" ");
                    try {
                        terminal?.stop();
                        await new Promise<void>((resolve, reject) => {
                            const child = spawn(
                                editor,
                                [...editorArgs, outcome.filePath],
                                {
                                    stdio: "inherit",
                                    shell: process.platform === "win32",
                                },
                            );
                            child.once("error", reject);
                            child.once("close", (code, signal) => {
                                if (code === 0) resolve();
                                else
                                    reject(
                                        new Error(
                                            signal
                                                ? `Editor stopped by ${signal}`
                                                : `Editor exited with code ${code}`,
                                        ),
                                    );
                            });
                        });
                    } catch (error) {
                        ctx.ui.notify(
                            `Skill editor failed: ${error instanceof Error ? error.message : String(error)}`,
                            "error",
                        );
                    } finally {
                        terminal?.start();
                        terminal?.requestRender();
                    }
                    // Force a re-read of every skill body the next time the overlay
                    // renders — the user may have edited the file (or any of its
                    // siblings via a multi-file editor command).
                    invalidateAllSkillBodies();
                    lastSkill = outcome.name;
                    continue;
                }
            }
        },
    });
}
