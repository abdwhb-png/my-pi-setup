# pi-glm-tweaks inspired from `@estebanforge/pi-glm-tweaks`

**Archived.** `agent/extensions-legacy/` is not auto-loaded by Pi. Move the entire directory back to `agent/extensions/` to opt in again; review the request flags first, since their latency, token, and quality effects were not measured here.

Pi-native request tweaks and peak-hours widget for **GLM-5.2**. Pi's built-in catalog and provider code own thinking levels and wire translation for direct Z.AI and OpenRouter GLM models, including GLM-5.3. This extension does not override those definitions. Configure CPA model metadata with `ai-providers.json` overrides.

## What it does

The built-in direct `zai/glm-5.2` model exposes three levels (see [Z.AI thinking documentation](https://docs.z.ai/guides/capabilities/thinking)):

| Pi thinking level | GLM-5.2 wire                                                 |
| ----------------- | ------------------------------------------------------------ |
| `off`             | `thinking: { type: "disabled" }`                             |
| `high`            | `thinking: { type: "enabled" }` + `reasoning_effort: "high"` |
| `max`             | `thinking: { type: "enabled" }` + `reasoning_effort: "max"`  |

Pi also defines GLM-5.3 levels (`low`, `high`, `max`; no `off`). OpenRouter has its own built-in GLM mappings; this extension leaves them untouched.

1. **Custom model fallback:** on `session_start`, only if a custom direct `zai/glm-5.2` entry lacks `thinkingLevelMap` and direct Z.AI auth is available, copy the map from Pi's built-in catalog. Preserve the entry's URL, prices, headers, other metadata and all other Z.AI models. A model already carrying a map is never re-registered.
2. **Auto-clamp on `model_select`:** for GLM-5.2 on direct Z.AI or CPA `zai-coding`, change stale `minimal`, `low` or `medium` to `high` and notify.
3. **Footer widget:** show the thinking hint and peak-hours indicator for GLM on direct Z.AI or CPA `zai-coding`.
4. **`/glm-tweaks` command:** status panel and flag toggle (see [`/glm-tweaks` command](#glm-tweaks-command)).

For direct Z.AI, `Shift+Tab`, `/thinking` and the level picker follow Pi's built-in map (or the same map filled into a custom entry). CPA levels come from its configured overrides.

## Token-efficiency tweaks

These optional flags were added to experiment with reasoning latency and token use on GLM-5.2. They are not required for Pi's native thinking levels; their benefit has not been measured in this setup:

| Flag                      | Default | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `glm-budget-nudge`        | `true`  | (a) Appends a soft thinking-budget fragment to the system prompt on every zai/glm-5.2 turn. (b) Per LLM call, sums `reasoning_content` across prior assistant messages in the current agent loop (the one started by the most recent user prompt); if cumulative exceeds ~2000 characters (roughly 500 English tokens), injects a one-shot hint to push the model back toward tool calls. Fires at most once per loop. The hint appears in the conversation panel as a user message prefixed `[system reminder: ...]` — that is intentional, so you can see when the ratchet fired. |
| `glm-clear-thinking`      | `true`  | Forces `clear_thinking: true` on every request. The coding endpoint defaults to preserved thinking, which Z.AI documents as improving continuity and cache reuse. Forcing `true` opts out of that behavior; its cost and quality effects here are unmeasured.                                                                                                                                                                                                                                                                                                                                             |
| `glm-skip-short-thinking` | `true`  | For user prompts under 80 chars, forces `thinking.type: "disabled"` for that turn. Trivial questions ("what time is it") don't need deep thinking.                                                                                                                                                                                                                                                                                                                                                                                                                                  |

When this extension is loaded, all three flags surface in `pi config` and Pi's flag editor — `pi config set glm-budget-nudge false` to disable.

## `/glm-tweaks` command

An in-session command for inspecting and flipping the flags above without leaving Pi.

| Invocation                    | Effect                                                                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/glm-tweaks` (TUI)           | Opens an interactive settings menu (the same `SettingsList` component `/settings` uses). Flip any combination of flags, then a single reload fires on close to apply them all. |
| `/glm-tweaks` (non-TUI / RPC) | Falls back to a read-only status panel (active model, current thinking level, and each flag's on/off state).                                                         |
| `/glm-tweaks toggle <flag>`   | One-shot flip: persists, then reloads.                                                                                                                                         |
| `/glm-tweaks <flag>`          | Shorthand one-shot toggle (flag name without the `toggle` keyword).                                                                                                            |

The command offers tab-completion for `toggle` and the three flag names.

**Why a reload per apply.** Pi's extension API exposes `getFlag` but no live `setFlag`, and flag values are read into memory at load time. So changes persist via `pi config set` and a `/reload` picks them up. The interactive menu stages all your flips and reloads once on close; the one-shot toggle reloads immediately. In both cases the command notifies (`Applied 2 change(s). Reloading...`) before reloading. If you'd rather avoid reload churn entirely, set flags directly in `pi config` / the flag editor and reload once at your convenience.

### What the tweaks cannot do

- Cap thinking tokens at a wire level. Z.AI does not expose a thinking budget param.
- Inject text mid-stream. No Pi hook for streaming chunk mutation.
- Force the model to call a tool. The system prompt can ask; nothing forces it.
- Lower `reasoning_effort` per-request. While [z.ai docs](https://docs.z.ai/guides/capabilities/thinking) list `reasoning_effort` as a supported parameter for GLM-5.2, the coding endpoint (`/api/coding/paas/v4`) may not honour it the same way. See [KiwiGaze/glm-for-copilot #7](https://github.com/KiwiGaze/glm-for-copilot/issues/7) for community observations.

## Why this exists

Pi already supplies the thinking map and wire translation for its built-in GLM models. A custom direct `zai/glm-5.2` entry without a map does not inherit those supported levels; the extension fills that specific gap without replacing complete model definitions. Its request tweaks and peak-hours widget are separate from model metadata.

## Compatibility

- Pi (`@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai`) — requires the published Z.AI model catalog, `registerProvider`, and the `before_agent_start` / `context` / `before_provider_request` / `registerFlag` hooks.
- Any model selected through the direct `zai` provider requires a Z.AI API key, resolved through Pi's standard auth storage (`ZAI_API_KEY`, `/login`, or `models.json` provider `apiKey`). The extension warns only when this direct provider is selected without a key.
- CPA `zai-coding` and OpenRouter GLM routes do not require direct Z.AI auth. The peak-hours widget works for `cpa/zai-coding/glm-5.2` without it; the extension's model-specific tweaks do not apply to OpenRouter routes.

## License

MIT
