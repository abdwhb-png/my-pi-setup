import { ZAI_MODELS } from "@earendil-works/pi-ai/providers/zai.models";
/**
 * GLM-5.2 request tweaks and peak-hours widget. Pi's model catalog owns
 * thinking levels for built-in Z.AI and OpenRouter GLM models, including
 * GLM-5.3; never replace those definitions. Only a custom direct Z.AI
 * GLM-5.2 entry missing its map gets the built-in map at session_start.
 * CPA model metadata belongs in ai-providers.json overrides.
 */
import {
    getSettingsListTheme,
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
    Container,
    SettingsList,
    Text,
    type SettingItem,
} from "@earendil-works/pi-tui";
import { createWidget } from "../../extensions/_shared/fancy-footer";
import {
    computePeakStatus,
    isZaiGlm52,
    isZaiPeakModel,
    type ModelRef,
} from "./peak-hours.ts";

const PROVIDER = "zai";
const MODEL_ID = "glm-5.2";
const ZAI_CODING_BASE_URL = "https://api.z.ai/api/coding/paas/v4";

// Pi thinking-level keys we hide for GLM-5.2. Listed explicitly so the map
// stays grep-friendly; any level not present (notably `off`) is supported
// with the provider's default mapping (here: thinking.type="disabled").
const HIDDEN_LEVELS = new Set(["minimal", "low", "medium"]);

// Token-efficiency tuning constants. Hardcoded for v1 — exposed as flags
// would be over-engineering for a single-model extension. Bump these in
// a future minor if users report the ratchet firing too eagerly / not
// eagerly enough.
const SHORT_PROMPT_THRESHOLD = 80;
const RATCHET_THRESHOLD_CHARS = 2_000;

// Token-efficiency flags. Single source of truth — drives registerFlag,
// the /glm-tweaks status display, autocomplete, and the toggle subcommand.
// All default on. See README for what each does at the wire level.
const FLAGS = [
    {
        name: "glm-budget-nudge",
        label: "Budget nudge",
        description:
            "Inject a soft thinking-budget system-prompt fragment and intra-loop ratchet for zai/glm-5.2.",
    },
    {
        name: "glm-clear-thinking",
        label: "Clear thinking",
        description:
            "Force clear_thinking=true on zai/glm-5.2 requests to prevent cross-turn reasoning_content carryover on the coding endpoint.",
    },
    {
        name: "glm-skip-short-thinking",
        label: "Skip short thinking",
        description:
            "Disable thinking on short user prompts (<80 chars) to save tokens on trivial turns.",
    },
] as const;

// Soft system-prompt fragment appended to every zai/glm-5.2 turn when
// the budget-nudge flag is on. No "I'm overthinking" ack string — that's
// unenforceable (model may or may not emit it, may emit it in Chinese,
// and we'd have to detect it).
const BUDGET_FRAGMENT = `

<glm-thinking-budget>
You are operating under a per-turn thinking budget. Behave accordingly:
- Cap each thinking block at ~500 tokens. Don't ruminate; commit to a tool call or response.
- Take a tool call every 200-300 thinking tokens. Don't sit and speculate without acting.
- Prefer a concrete tool call over further internal deliberation.
</glm-thinking-budget>`;

// Build the /glm-tweaks status panel. Read-only snapshot of the active
// model, current thinking level, and the on/off state of every flag.
function renderStatus(
    pi: ExtensionAPI,
    model: { provider: string; id: string } | undefined,
): string {
    const active = isZaiGlm52(model);
    const level = pi.getThinkingLevel();
    const flagLines = FLAGS.map(
        (f) => `  ${pi.getFlag(f.name) === true ? "[x]" : "[ ]"} ${f.name}`,
    );
    return [
        `GLM-5.2 tweaks — ${active ? "ACTIVE (zai/glm-5.2 selected)" : "inactive (select zai/glm-5.2 to engage)"}`,
        `thinking: ${active ? `current=${level}, wire=off|high|max` : "n/a"}`,
        "",
        "flags:",
        ...flagLines,
        "",
        "toggle: /glm-tweaks toggle <flag>   (shorthand: /glm-tweaks <flag>)",
        "also:   pi config set <flag> false",
    ].join("\n");
}

// Build the fancy-footer widget body. Shows for any quota-consuming Z.AI
// model (GLM-5.2, GLM-5-Turbo) on a Z.AI route. GLM-5.2 also appends the
// thinking-level reminder; GLM-5-Turbo shows the peak indicator only.
// The peak multiplier (3x peak / 1x benefit / 2x std off-peak) is driven
// off real UTC via computePeakStatus().
function renderPeakWidget(
    model: ModelRef | undefined,
): { text: string; textColor: "success" | "warning" | "error" } | undefined {
    if (!isZaiPeakModel(model)) return undefined;
    const parts: string[] = [isZaiGlm52(model) ? "GLM-5.2" : "GLM-5-Turbo"];
    if (isZaiGlm52(model)) parts.push("thinking off|high|max");
    const peak = computePeakStatus();
    parts.push(`\u26a1${peak.label}`);
    return { text: parts.join(" \u00b7 "), textColor: peak.severity };
}

export default function (pi: ExtensionAPI) {
    // Register Pi-idiomatic flags at factory load time, NOT inside
    // session_start. registerFlag is static setup; calling it per session
    // would clobber user preferences on every /new or /reload.
    for (const f of FLAGS) {
        pi.registerFlag(f.name, {
            description: f.description,
            type: "boolean",
            default: true,
        });
    }

    // /glm-tweaks — status display by default; `toggle <flag>` (or bare
    // `<flag>`) flips a boolean. ExtensionAPI exposes no live setFlag, so a
    // toggle persists via `pi config set` and then reloads the session so
    // the in-memory flag value picks up the change. ctx is stale after
    // reload() — we notify first, reload last, and return immediately.
    pi.registerCommand("glm-tweaks", {
        description:
            "GLM-5.2 tweaks: show status, or toggle a flag. Usage: /glm-tweaks [toggle <flag>]",
        getArgumentCompletions: (prefix: string) => {
            // Preserve trailing space: `/glm-tweaks toggle ` (with space) means
            // the `toggle` token is complete and we should now suggest flags.
            // Trimming would collapse it to "toggle" and re-suggest the word.
            const trailingSpace = /\s$/.test(prefix);
            const tokens = prefix.trim().split(/\s+/).filter(Boolean);
            const flagNames = FLAGS.map((f) => f.name);
            const root = ["toggle", ...flagNames];
            // Suggest flag names once `toggle` is complete (either as the only
            // token with a trailing space, or with a partial flag typed).
            const toggleComplete =
                (tokens.length === 1 && tokens[0] === "toggle") ||
                (tokens.length >= 2 && tokens[0] === "toggle");
            if (toggleComplete) {
                const partial =
                    tokens.length >= 2 ? tokens[tokens.length - 1] : "";
                const hits = flagNames.filter((n) => n.startsWith(partial));
                return hits.length
                    ? hits.map((v) => ({ value: v, label: v }))
                    : null;
            }
            if (tokens.length <= 1 && !trailingSpace) {
                const hits = root.filter((o) => o.startsWith(tokens[0] ?? ""));
                return hits.length
                    ? hits.map((v) => ({ value: v, label: v }))
                    : null;
            }
            return null;
        },
        handler: async (args, ctx) => {
            const trimmed = args.trim();

            // Toggle mode: `/glm-tweaks toggle <flag>` or `/glm-tweaks <flag>`.
            // Direct one-shot flip — persists via `pi config set` then reloads.
            // Bare `/glm-tweaks toggle` (no flag) falls through to the menu.
            if (
                trimmed !== "" &&
                trimmed !== "status" &&
                trimmed !== "toggle"
            ) {
                const tokens = trimmed.split(/\s+/).filter(Boolean);
                const flagName = tokens[0] === "toggle" ? tokens[1] : tokens[0];
                const meta = FLAGS.find((f) => f.name === flagName);
                if (!meta) {
                    ctx.ui.notify(
                        `Unknown flag "${flagName}". Valid: ${FLAGS.map((f) => f.name).join(", ")}`,
                        "warning",
                    );
                    return;
                }
                const current = pi.getFlag(meta.name) === true;
                const next = !current;
                const result = await pi.exec("pi", [
                    "config",
                    "set",
                    meta.name,
                    String(next),
                ]);
                if (result.code !== 0) {
                    ctx.ui.notify(
                        `Failed to set ${meta.name}: ${result.stderr.trim() || `exit ${result.code}`}`,
                        "error",
                    );
                    return;
                }
                ctx.ui.notify(
                    `${meta.name}: ${current} → ${next}. Reloading...`,
                    "info",
                );
                await ctx.reload();
                return;
            }

            // Status/menu mode. In TUI, open an interactive SettingsList
            // (same component /settings uses) so the user can flip several
            // flags in one visit; changes persist via `pi config set` and a
            // single reload fires on close. Outside TUI (RPC/headless), fall
            // back to the read-only status panel — custom components are
            // terminal-only.
            if (ctx.mode !== "tui") {
                ctx.ui.notify(renderStatus(pi, ctx.model), "info");
                return;
            }

            const active = isZaiGlm52(ctx.model);
            const pending = new Map<string, boolean>();
            const items: SettingItem[] = FLAGS.map((f) => ({
                id: f.name,
                label: f.label,
                description: f.description,
                currentValue: pi.getFlag(f.name) === true ? "on" : "off",
                values: ["on", "off"],
            }));

            await ctx.ui.custom((tui, theme, _kb, done) => {
                const container = new Container();
                const header = active
                    ? "GLM-5.2 tweaks — zai/glm-5.2 active"
                    : "GLM-5.2 tweaks — inactive (select zai/glm-5.2 to engage)";
                container.addChild(
                    new Text(theme.fg("accent", theme.bold(header)), 1, 1),
                );

                const settingsList = new SettingsList(
                    items,
                    Math.min(items.length + 2, 15),
                    getSettingsListTheme(),
                    (id, newValue) => {
                        // Stage the change; persist + reload on close, not here,
                        // so the user can flip several flags per visit.
                        pending.set(id, newValue === "on");
                    },
                    () => done(undefined),
                );
                container.addChild(settingsList);

                return {
                    render: (w: number) => container.render(w),
                    invalidate: () => container.invalidate(),
                    handleInput: (data: string) => {
                        settingsList.handleInput?.(data);
                        tui.requestRender();
                    },
                };
            });

            // Dialog closed. ctx is still valid here (reload is the only
            // staleness trigger, and we haven't called it yet). Drop net-zero
            // flips (a flag toggled on then off stages but changes nothing),
            // then persist genuine deltas and reload once if any moved.
            const deltas: Array<[string, boolean]> = [];
            for (const [name, val] of pending) {
                const currentlyOn = pi.getFlag(name) === true;
                if (currentlyOn === val) continue; // net-zero: toggled back to current
                deltas.push([name, val]);
            }
            if (deltas.length === 0) return;

            const failures: string[] = [];
            for (const [name, val] of deltas) {
                const r = await pi.exec("pi", [
                    "config",
                    "set",
                    name,
                    String(val),
                ]);
                if (r.code !== 0)
                    failures.push(
                        `${name} (${r.stderr.trim() || `exit ${r.code}`})`,
                    );
            }
            if (failures.length > 0) {
                ctx.ui.notify(
                    `Failed to apply: ${failures.join("; ")}`,
                    "error",
                );
                return;
            }
            ctx.ui.notify(
                `Applied ${deltas.length} change(s). Reloading...`,
                "info",
            );
            await ctx.reload();
        },
    });

    // Per-loop mutable state. Node.js runs the extension hooks single-
    // threaded, so a closure-scoped object is safe and avoids re-reading
    // flags + recomputing in every hook. Reset on every before_agent_start.
    const loop: {
        shortPrompt: boolean;
        ratchetFired: boolean;
    } = { shortPrompt: false, ratchetFired: false };

    // ── Fancy-footer widget: thinking hint + live Z.AI peak-hours indicator ──
    //
    // Replaces the old ctx.ui.setStatus('glm-thinking', …) hint. The widget
    // shows for any quota-consuming Z.AI model (GLM-5.2, GLM-5-Turbo) on a
    // Z.AI route (built-in `zai/*` or CPA `cpa/zai-coding/*`). GLM-5.2 also
    // appends the thinking-level reminder; GLM-5-Turbo shows peak only.
    // The peak multiplier (3× peak / 1× benefit / 2× std off-peak) is driven
    // off real UTC, so the 60s interval below keeps it fresh across the
    // 06:00–10:00 UTC boundary even when no event fires.
    let latestCtx: ExtensionContext | undefined;
    let peakTimer: ReturnType<typeof setInterval> | undefined;
    let missingDirectAuth = false;
    let warnedMissingDirectAuth = false;
    const warnMissingDirectAuth = (
        model: ModelRef | undefined,
        ctx: ExtensionContext,
    ) => {
        if (
            !missingDirectAuth ||
            warnedMissingDirectAuth ||
            model?.provider !== PROVIDER
        )
            return;
        warnedMissingDirectAuth = true;
        ctx.ui.notify(
            "pi-glm-tweaks: ZAI auth not configured. Run `/login` or set ZAI_API_KEY to use the direct zai provider.",
            "warning",
        );
    };
    const widget = createWidget(pi, {
        id: "pi-glm-tweaks.status",
        label: "GLM status",
        description: "GLM thinking level + Z.AI peak-hours quota indicator",
        order: 12,
        visible: (ctx) => isZaiPeakModel(ctx.ctx.model),
        render: (ctx) => {
            const r = renderPeakWidget(ctx.ctx.model);
            return r ?? undefined;
        },
    });

    const updatePeakWidget = () => {
        try {
            if (latestCtx) widget.update(latestCtx);
        } catch {
            // Ignore stale context or invalidated runtime errors
        }
    };

    const trackPeakWidget = (ctx: ExtensionContext) => {
        latestCtx = ctx;
        updatePeakWidget();
        if (peakTimer !== undefined) clearInterval(peakTimer);
        peakTimer = isZaiPeakModel(ctx.model)
            ? setInterval(updatePeakWidget, 60_000)
            : undefined;
        peakTimer?.unref?.();
    };

    pi.on("session_start", async (_event, ctx) => {
        missingDirectAuth = false;
        warnedMissingDirectAuth = false;
        trackPeakWidget(ctx);
        const existing = ctx.modelRegistry
            .getAll()
            .filter((m) => m.provider === PROVIDER);
        if (existing.length === 0) return;

        // registerProvider requires apiKey (or oauth) when defining models,
        // even for a provider that already has auth resolved. Pull the
        // resolved key from the existing provider so we keep working
        // whether the user used ZAI_API_KEY env, /login, or models.json
        // apiKey.
        const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
        if (!apiKey) {
            missingDirectAuth = true;
            warnMissingDirectAuth(ctx.model, ctx);
            return;
        }
        const glm52 = existing.find((m) => m.id === MODEL_ID);
        if (!glm52 || glm52.thinkingLevelMap) return;

        // registerProvider replaces all provider models: retain the list and
        // patch only the incomplete GLM-5.2 entry from Pi's built-in catalog.
        const models = [...existing];
        models[models.indexOf(glm52)] = {
            ...glm52,
            thinkingLevelMap: ZAI_MODELS[MODEL_ID].thinkingLevelMap,
            compat: { ...ZAI_MODELS[MODEL_ID].compat, ...glm52.compat },
        };
        pi.registerProvider(PROVIDER, {
            baseUrl: ZAI_CODING_BASE_URL,
            apiKey,
            models,
        });
    });

    pi.on("session_shutdown", async () => {
        if (peakTimer !== undefined) {
            clearInterval(peakTimer);
            peakTimer = undefined;
        }
        latestCtx = undefined;
    });

    pi.on("before_agent_start", (event, ctx) => {
        // Reset per-loop state at the start of each user turn. The other
        // hooks read these to drive their per-turn behavior.
        loop.shortPrompt = event.prompt.length < SHORT_PROMPT_THRESHOLD;
        loop.ratchetFired = false;

        if (!isZaiGlm52(ctx.model)) return {};
        if (pi.getFlag("glm-budget-nudge") !== true) return {};

        // Return the assembled prompt with our fragment appended. We must
        // concat (not replace) — Pi's before_agent_start chaining means
        // our systemPrompt replaces the upstream value, and other
        // extensions downstream only see what we return.
        return { systemPrompt: (event.systemPrompt ?? "") + BUDGET_FRAGMENT };
    });

    pi.on("context", (event, ctx) => {
        if (!isZaiGlm52(ctx.model)) return {};
        if (pi.getFlag("glm-budget-nudge") !== true) return {};
        if (loop.ratchetFired) return {};

        // Sum reasoning from assistant messages in the CURRENT agent loop
        // only. Find the boundary by walking back to the last `role: "user"`
        // message (the prompt that started this loop). toolResult / assistant
        // / custom / etc. are not user role, so they don't reset the boundary.
        // Without this scoping, a long session would fire the ratchet on the
        // first LLM call of every new turn regardless of current-loop thinking.
        //
        // Pi stores assistant thinking in content[] as ThinkingContent blocks
        // ({type:"thinking", thinking:string}) — NOT a top-level
        // `reasoning_content` field (that's the Z.AI wire name). Reading the
        // wrong field was a 1.0.0 bug that left the ratchet permanently dead.
        let loopStart = event.messages.length - 1;
        while (loopStart > 0) {
            const m = event.messages[loopStart] as
                | { role?: string }
                | undefined;
            if (m?.role === "user") break;
            loopStart--;
        }

        let totalReasoning = 0;
        for (let i = loopStart + 1; i < event.messages.length; i++) {
            const m = event.messages[i];
            if (typeof m !== "object" || m === null) continue;
            const msg = m as { role?: string; content?: unknown };
            if (msg.role !== "assistant" || !Array.isArray(msg.content))
                continue;
            for (const block of msg.content) {
                if (
                    block &&
                    typeof block === "object" &&
                    (block as { type?: string }).type === "thinking" &&
                    typeof (block as { thinking?: unknown }).thinking ===
                        "string"
                ) {
                    totalReasoning += (block as { thinking: string }).thinking
                        .length;
                }
            }
        }
        if (totalReasoning < RATCHET_THRESHOLD_CHARS) return {};

        loop.ratchetFired = true;
        const hint = {
            role: "user",
            content:
                "[system reminder: you've been thinking extensively without taking a tool call. Take a tool call now or wrap up your response.]",
            timestamp: Date.now(),
        };
        return { messages: [...event.messages, hint as never] };
    });

    pi.on("before_provider_request", (event, ctx) => {
        if (!isZaiGlm52(ctx.model)) return;
        if (!event.payload || typeof event.payload !== "object") return;

        const obj = event.payload as Record<string, unknown>;
        const current = obj.thinking;
        const thinking =
            current && typeof current === "object" && !Array.isArray(current)
                ? { ...(current as Record<string, unknown>) }
                : ({} as Record<string, unknown>);

        let mutated = false;

        // Force clear_thinking on every request. The coding endpoint
        // defaults to preserved thinking (clear_thinking: false), which
        // silently compounds reasoning_content across turns. Cost at
        // $4.4/MTok output makes this materially expensive.
        if (pi.getFlag("glm-clear-thinking") === true) {
            thinking.clear_thinking = true;
            mutated = true;
        }

        // Short-prompt thinking-skip: trivial turns ("what time is it")
        // don't need deep thinking. Force the kill switch and let Pi's
        // zai branch drop the thinking.type="disabled" through.
        //
        // Intentionally applies to every LLM call in the loop, not just the
        // first: loop.shortPrompt is computed once from the initial prompt
        // and held constant (see before_agent_start). A short prompt that
        // spawns tool calls stays thinking-free for the whole turn.
        if (
            pi.getFlag("glm-skip-short-thinking") === true &&
            loop.shortPrompt
        ) {
            thinking.type = "disabled";
            mutated = true;
        }

        if (mutated) {
            obj.thinking = thinking;
        }
        return obj;
    });

    pi.on("model_select", (event, ctx) => {
        // Refresh the widget on every model switch; its visible/render guards
        // decide whether to show (GLM-5.2 / GLM-5-Turbo on a z.ai route) or
        // hide. This replaces the old ctx.ui.setStatus('glm-thinking', …).
        trackPeakWidget(ctx);
        warnMissingDirectAuth(event.model, ctx);

        if (!isZaiGlm52(event.model)) return;

        // Auto-clamp if Pi's current level is one we hid for GLM-5.2.
        // setThinkingLevel is a no-op if already at the requested level.
        const current = pi.getThinkingLevel();
        if (HIDDEN_LEVELS.has(current)) {
            pi.setThinkingLevel("high");
            ctx.ui.notify(
                `GLM-5.2 thinking: "${current}" not supported. Switched to high (off | high | max).`,
                "info",
            );
        }
    });
}
