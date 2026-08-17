/**
 * pi-caveman — why use many token when few do trick
 *
 * A pi extension that cuts ~75% of output tokens while keeping full technical
 * accuracy. Based on https://github.com/JuliusBrussee/caveman
 *
 * Commands:
 *   /caveman [level]  Toggle caveman mode or set intensity
 *   /caveman stop     Disable caveman mode (aliases: off, quit)
 *   /caveman config   Open settings dialog (default level, status bar toggle)
 */

import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
    ExtensionAPI,
    ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
    getAgentDir,
    getSettingsListTheme,
    loadSkillsFromDir,
    stripFrontmatter,
} from "@earendil-works/pi-coding-agent";
import {
    Container,
    type SettingItem,
    SettingsList,
    Text,
} from "@earendil-works/pi-tui";
import { loadCavemanConfig } from "./config";
import { SAVE_TOKENS_CAVEMAN_DEFAULT_LEVEL_ENV } from "./subagent-profile.ts";

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------

const LEVELS = [
    "off",
    "lite",
    "full",
    "ultra",
    "wenyan-lite",
    "wenyan-full",
    "wenyan-ultra",
    "micro",
] as const;
export { LEVELS };
const CAVEMAN_LEVELS = new Set<string>(LEVELS);
const STOP_ALIASES = new Set(["off", "stop", "quit"]);
type Level = (typeof LEVELS)[number];

const CAVEMAN_COMMAND_OPTIONS = [
    { value: "lite", label: "lite", description: "Professional, no fluff" },
    { value: "full", label: "full", description: "Classic caveman" },
    { value: "ultra", label: "ultra", description: "Maximum compression" },
    {
        value: "wenyan-lite",
        label: "wenyan-lite",
        description: "Semi-classical Chinese",
    },
    { value: "wenyan-full", label: "wenyan-full", description: "Full 文言文" },
    {
        value: "wenyan-ultra",
        label: "wenyan-ultra",
        description: "Extreme 文言文",
    },
    {
        value: "micro",
        label: "micro",
        description: "Experimental prompt-minimized mode",
    },
    { value: "off", label: "off", description: "Disable caveman mode" },
    { value: "stop", label: "stop", description: "Disable caveman mode" },
    { value: "quit", label: "quit", description: "Disable caveman mode" },
    { value: "config", label: "config", description: "Open settings dialog" },
] as const;

// ---------------------------------------------------------------------------
// Config (read from settings.json, persisted by config dialog)
// ---------------------------------------------------------------------------

interface CavemanSettings {
    defaultLevel: Level;
    showStatus: boolean;
}

const DEFAULT_SETTINGS: CavemanSettings = {
    defaultLevel: "full",
    showStatus: true,
};
let saveSettingsQueue: Promise<void> = Promise.resolve();

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function saveCavemanSettings(
    updates: Partial<CavemanSettings>,
): Promise<void> {
    const agentDir = getAgentDir();
    const settingsPath = join(agentDir, "settings.json");

    saveSettingsQueue = saveSettingsQueue.then(async () => {
        let settings: Record<string, unknown> = {};
        try {
            const raw = await readFile(settingsPath, "utf8");
            const parsed: unknown = JSON.parse(raw);
            if (isRecord(parsed)) settings = parsed;
        } catch {
            // empty or doesn't exist
        }

        const currentSaveTokens =
            (settings.saveTokens as Record<string, unknown>) ?? {};
        const currentCaveman =
            (currentSaveTokens.caveman as Record<string, unknown>) ?? {};

        settings.saveTokens = {
            ...currentSaveTokens,
            caveman: {
                ...currentCaveman,
                ...updates,
            },
        };

        await writeFile(
            settingsPath,
            JSON.stringify(settings, null, 2) + "\n",
            "utf8",
        );
    });

    return saveSettingsQueue;
}

// ---------------------------------------------------------------------------
// Animated status bar — campfire with 256-color fire palette
// ---------------------------------------------------------------------------

interface Animation {
    frames: string[];
    label: string;
    /** ms between frames */
    interval: number;
}

class AnimationTimer {
    handle?: ReturnType<typeof setInterval>;
}

const R = "\x1b[38;5;196m"; // red
const O = "\x1b[38;5;208m"; // orange
const Y = "\x1b[38;5;220m"; // yellow
const W = "\x1b[38;5;230m"; // white-hot
const E = "\x1b[38;5;52m"; // ember (dark red)
const X = "\x1b[0m"; // reset

const FIRE_FRAMES = [
    `${R}⠠${O}⠄${X}`,
    `${O}⠔${Y}⠂${X}`,
    `${Y}⠊${W}⠑${X}`,
    `${W}⠑${Y}⠊${X}`,
    `${Y}⠂${O}⠔${X}`,
    `${O}⠄${R}⠠${X}`,
    `${R}⠠${E}⠄${X}`,
    `${E}⠔${R}⠂${X}`,
];

const ANIMATIONS: Record<Exclude<Level, "off">, Animation> = {
    lite: { frames: FIRE_FRAMES, label: "LITE", interval: 300 },
    full: { frames: FIRE_FRAMES, label: "FULL", interval: 200 },
    ultra: { frames: FIRE_FRAMES, label: "ULTRA", interval: 100 },
    "wenyan-lite": { frames: FIRE_FRAMES, label: "文言", interval: 300 },
    "wenyan-full": { frames: FIRE_FRAMES, label: "文言文", interval: 200 },
    "wenyan-ultra": { frames: FIRE_FRAMES, label: "文言文極", interval: 100 },
    micro: { frames: FIRE_FRAMES, label: "MICRO", interval: 120 },
};

// ---------------------------------------------------------------------------
// Skill loader — single source of truth is the installed `caveman` skill.
// The extension is a thin orchestrator: it loads the skill body once,
// caches it, and selects a runtime layer on top (active level + micro).
// ---------------------------------------------------------------------------

/**
 * Minimal local prompt for `micro` — experimental level that the canonical
 * caveman skill does not document. Kept local so older sessions persist.
 */
const MICRO_PROMPT = `# Token efficiency
Respond like smart caveman. Cut all filler, keep technical substance.
- Drop articles (a, an, the), filler (just, really, basically, actually).
- Drop pleasantries (sure, certainly, happy to).
- No hedging. Fragments fine. Short synonyms.
- Technical terms stay exact. Code blocks unchanged.
- Pattern: [thing] [action] [reason]. [next step].`;

// Lazily-resolved skill body. null = not loaded yet, string = body, undefined
// = skill not installed (permanently gives up injecting until next session).
let cachedSkillBody: string | null | undefined = null;

/**
 * Load the `caveman` skill's body (frontmatter stripped) from the pi
 * user-skills directory. Cached for the process lifetime.
 *
 * Returns:
 *  - string   → the skill body (skill installed)
 *  - undefined → the `caveman` skill is not installed (no crash)
 */
export function loadCavemanSkillBody(): string | undefined {
    if (cachedSkillBody !== null) return cachedSkillBody ?? undefined;

    try {
        const { skills } = loadSkillsFromDir({
            dir: join(getAgentDir(), "skills"),
            source: "user",
        });
        const skill = skills.find((s) => s.name === "caveman");
        if (!skill) {
            cachedSkillBody = undefined;
            return undefined;
        }
        const raw = readFileSync(skill.filePath, "utf8");
        cachedSkillBody = stripFrontmatter(raw).trim();
        return cachedSkillBody;
    } catch {
        cachedSkillBody = undefined;
        return undefined;
    }
}

/**
 * Reset the cached skill body. Used by tests to vary the installed skill
 * between cases. Has no stable runtime meaning.
 */
export function resetCavemanCacheForTests(): void {
    cachedSkillBody = null;
}

/**
 * Build the caveman injection for the active level, layered on top of the
 * installed skill body. Returns null when no injection should happen
 * (level off, unknown level, or skill missing for non-micro levels).
 *
 * Accepts a raw `string` because persisted session entries and config files
 * are not type-checked at the boundary; the function normalizes internally.
 */
export function buildCavemanPrompt(level: string): string | null {
    // off → never inject
    if (level === "off") return null;

    // micro is not documented by the canonical skill → use the local prompt
    if (level === "micro") {
        return MICRO_PROMPT;
    }

    // Unknown level string (e.g. legacy "wenyan" from an old session entry).
    // Do not invent a prompt — bail safely.
    if (!isCavemanLevel(level)) return null;

    const body = loadCavemanSkillBody();
    if (!body) return null;

    // Short runtime directive: tells the model which intensity row to apply.
    // The skill body holds the full intensity table; only this one line is
    // per-turn runtime data.
    return `ACTIVE LEVEL: ${level}. Apply the matching row from the intensity table below.\n\n${body}`;
}

function isKnownCavemanLevel(value: string): value is Level {
    return CAVEMAN_LEVELS.has(value);
}

/** Type guard: narrow a runtime string to a valid Caveman level. */
function isCavemanLevel(value: string): value is Exclude<Level, "off"> {
    return isKnownCavemanLevel(value) && value !== "off";
}

/**
 * Resolve the level for a session that has just started.
 *
 * A persisted session choice remains authoritative. Fresh pi-subagents
 * children may provide a validated profile level through their private
 * environment variable; all other sessions retain the configured default.
 */
export function resolveCavemanInitialLevel(
    sessionLevel: Level | null,
    configuredDefaultLevel: Level,
    env: NodeJS.ProcessEnv = process.env,
): Level {
    if (sessionLevel !== null) return sessionLevel;

    const profileLevel = env[SAVE_TOKENS_CAVEMAN_DEFAULT_LEVEL_ENV];
    if (profileLevel && isKnownCavemanLevel(profileLevel)) {
        return profileLevel;
    }

    return configuredDefaultLevel;
}

// ---------------------------------------------------------------------------
// Telemetry helper — detect effective Caveman level from system prompt
// ---------------------------------------------------------------------------

const CAVEMAN_LEVEL_RE = /ACTIVE LEVEL:\s*([\w-]+)/i;

/**
 * Scan a system prompt string for the canonical Caveman level marker.
 *
 * The Caveman `buildCavemanPrompt()` prepends `ACTIVE LEVEL: <level>.` so the
 * model knows which intensity row to apply. This function extracts that level
 * from the final assembled system prompt for telemetry snapshots.
 *
 * @returns The level string (e.g. `"full"`, `"ultra"`), or `null` if the
 *          marker is absent (level off or no Caveman injection active).
 */
export function detectCavemanLevel(systemPrompt: string): string | null {
    if (typeof systemPrompt !== "string") return null;
    const match = systemPrompt.match(CAVEMAN_LEVEL_RE);
    return match ? match[1]!.toLowerCase() : null;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function caveman(pi: ExtensionAPI) {
    let level: Level = "off";
    let settings: CavemanSettings = { ...DEFAULT_SETTINGS };
    const timer = new AnimationTimer();
    let frameIndex = 0;
    let isActive = false;
    let configLoaded = false;

    function ensureConfigLoaded() {
        if (configLoaded) return;
        configLoaded = true;
        const cfg = loadCavemanConfig();
        if (cfg.defaultLevel && LEVELS.includes(cfg.defaultLevel as Level)) {
            settings.defaultLevel = cfg.defaultLevel as Level;
        }
        if (typeof cfg.showStatus === "boolean") {
            settings.showStatus = cfg.showStatus;
        }
        if (level === "off" && settings.defaultLevel !== "off") {
            level = settings.defaultLevel;
        }
    }

    // -- Animation helpers --

    function stopAnimation() {
        if (timer.handle !== undefined) {
            clearInterval(timer.handle);
            timer.handle = undefined;
        }
        frameIndex = 0;
    }

    function syncStatus(ctx: Pick<ExtensionContext, "ui">) {
        stopAnimation();
        const theme = ctx.ui.theme;

        if (level === "off" || !settings.showStatus) {
            ctx.ui.setStatus("caveman", "");
            return;
        }

        const anim = ANIMATIONS[level];
        const setFrame = (frame: string) => {
            ctx.ui.setStatus(
                "caveman",
                frame +
                    " " +
                    theme.fg("muted", "caveman level: ") +
                    theme.fg("text", anim.label),
            );
        };

        if (!isActive) {
            setFrame(anim.frames[0]!);
            return;
        }

        const renderFrame = () => {
            setFrame(anim.frames[frameIndex % anim.frames.length]!);
            frameIndex++;
        };

        renderFrame();
        // Bun and Node expose overlapping timer globals; tsc verifies the handle type,
        // but Oxlint 1.70 treats the resolved return value as error-typed here.
        // oxlint-disable-next-line typescript/no-unsafe-assignment
        timer.handle = setInterval(renderFrame, anim.interval);
    }

    // -- Restore state on session load --

    pi.on("session_start", async (_event, ctx) => {
        ensureConfigLoaded();

        // Check for session-level override first (resuming a session)
        let sessionLevel: Level | null = null;
        for (const entry of ctx.sessionManager.getEntries()) {
            if (
                entry.type === "custom" &&
                entry.customType === "caveman-level"
            ) {
                sessionLevel = (entry.data as { level: Level })?.level ?? null;
            }
        }

        level = resolveCavemanInitialLevel(sessionLevel, settings.defaultLevel);
        if (sessionLevel === null && level !== "off") {
            // New session — persist the effective default (profile or config).
            pi.appendEntry("caveman-level", { level });
        }

        syncStatus(ctx);
    });

    pi.on("agent_start", async (_event, ctx) => {
        isActive = true;
        syncStatus(ctx);
    });

    pi.on("agent_end", async (_event, ctx) => {
        isActive = false;
        syncStatus(ctx);
    });

    pi.on("session_shutdown", async () => {
        stopAnimation();
        isActive = false;
    });

    // -- /caveman command --

    pi.registerCommand("caveman", {
        description:
            "Toggle caveman mode, set level, use stop/off/quit to disable, or 'config' to open settings",
        getArgumentCompletions: (prefix: string) => {
            const normalized = prefix.trim().toLowerCase();
            const items = CAVEMAN_COMMAND_OPTIONS.filter((item) =>
                item.value.startsWith(normalized),
            );
            return items.length > 0 ? items : null;
        },
        handler: async (args, ctx) => {
            const arg = args?.trim().toLowerCase();

            // Open config dialog
            if (arg === "config") {
                await openConfig(ctx);
                return;
            }

            if (!arg) {
                level = level === "off" ? "full" : "off";
            } else if (STOP_ALIASES.has(arg)) {
                level = "off";
            } else if (LEVELS.includes(arg as Level)) {
                level = arg as Level;
            } else {
                ctx.ui.notify(
                    `Unknown: "${arg}". Use: ${LEVELS.join(", ")}, stop, quit, or config`,
                    "error",
                );
                return;
            }

            pi.appendEntry("caveman-level", { level });
            syncStatus(ctx);

            ctx.ui.notify(
                level === "off"
                    ? "Caveman mode off."
                    : `Caveman: ${ANIMATIONS[level].label}`,
                "info",
            );
        },
    });

    // -- /caveman config: interactive SettingsList --

    async function openConfig(ctx: ExtensionContext) {
        ensureConfigLoaded();

        await ctx.ui.custom((_tui, theme, _kb, done) => {
            const items: SettingItem[] = [
                {
                    id: "defaultLevel",
                    label: "Default level for new sessions",
                    currentValue: settings.defaultLevel,
                    values: [...LEVELS],
                },
                {
                    id: "showStatus",
                    label: "Show animated status bar",
                    currentValue: settings.showStatus ? "on" : "off",
                    values: ["on", "off"],
                },
            ];

            const container = new Container();
            container.addChild(
                new Text(
                    theme.fg("accent", theme.bold(" Caveman Config")),
                    0,
                    0,
                ),
            );
            container.addChild(
                new Text(theme.fg("dim", " Saved to settings.json"), 0, 0),
            );
            container.addChild(
                new Text(
                    theme.fg(
                        "dim",
                        " Default level applies to future sessions.",
                    ),
                    0,
                    0,
                ),
            );
            container.addChild(new Text("", 0, 0));

            const applySettingChange = (id: string, newValue: string) => {
                if (
                    id === "defaultLevel" &&
                    LEVELS.includes(newValue as Level)
                ) {
                    settings.defaultLevel = newValue as Level;
                } else if (id === "showStatus") {
                    settings.showStatus = newValue === "on";
                }
                void saveCavemanSettings({
                    defaultLevel: settings.defaultLevel,
                    showStatus: settings.showStatus,
                });
                syncStatus(ctx);
            };

            const settingsList = new SettingsList(
                items,
                Math.min(items.length + 2, 10),
                getSettingsListTheme(),
                applySettingChange,
                () => done(undefined),
            );

            container.addChild(settingsList);
            container.addChild(
                new Text(
                    theme.fg(
                        "dim",
                        " ←→/hl/tab change • ↑↓/jk move • esc close",
                    ),
                    0,
                    0,
                ),
            );

            const cycleSelectedValue = (direction: -1 | 1) => {
                const selectedIndex = (
                    settingsList as unknown as { selectedIndex: number }
                ).selectedIndex;
                const item = items[selectedIndex];
                if (!item?.values?.length) return;

                const currentIndex = item.values.indexOf(item.currentValue);
                const nextIndex =
                    (currentIndex + direction + item.values.length) %
                    item.values.length;
                const newValue = item.values[nextIndex]!;
                item.currentValue = newValue;
                settingsList.updateValue(item.id, newValue);
                applySettingChange(item.id, newValue);
            };

            return {
                render: (w: number) => container.render(w),
                invalidate: () => container.invalidate(),
                handleInput: (data: string) => {
                    if (data === "j") data = "\u001b[B";
                    else if (data === "k") data = "\u001b[A";
                    else if (data === "h") {
                        cycleSelectedValue(-1);
                        _tui.requestRender();
                        return;
                    } else if (
                        data === "l" ||
                        data === "\u001b[C" ||
                        data === "\t"
                    ) {
                        cycleSelectedValue(1);
                        _tui.requestRender();
                        return;
                    } else if (data === "\u001b[D") {
                        cycleSelectedValue(-1);
                        _tui.requestRender();
                        return;
                    }

                    settingsList.handleInput?.(data);
                    _tui.requestRender();
                },
            };
        });
    }

    // -- Inject caveman rules into system prompt --

    pi.on("before_agent_start", async (event) => {
        ensureConfigLoaded();
        const injection = buildCavemanPrompt(level);
        if (!injection) return;
        return {
            systemPrompt: `${event.systemPrompt}\n\n${injection}`,
        };
    });
}
