# 🪨 pi-caveman

**Why use many token when few do trick.**

A `pi` extension that cuts **~75% of output tokens** while keeping full technical accuracy. Based on [caveman](https://github.com/JuliusBrussee/caveman) by [Julius Brussee](https://github.com/JuliusBrussee).

<table>
<tr>
<td width="50%">

### 🗣️ Normal (69 tokens)

> "The reason your React component is re-rendering is likely because you're creating a new object reference on each render cycle. When you pass an inline object as a prop, React's shallow comparison sees it as a different object every time, which triggers a re-render. I'd recommend using useMemo to memoize the object."

</td>
<td width="50%">

### 🪨 Caveman (19 tokens)

> "New object ref each render. Inline object prop = new ref = re-render. Wrap in `useMemo`."

</td>
</tr>
</table>

<p align="center">
  <img src="https://raw.githubusercontent.com/jonjonrankin/pi-caveman/main/pi-caveman.gif" alt="pi-caveman demo" width="600">
</p>

## Install

```bash
pi install git:github.com/jonjonrankin/pi-caveman
```

## Usage

### Toggle Mode

```
/caveman              Toggle on (full) / off
/caveman lite         Professional, no fluff
/caveman full         Classic caveman (default)
/caveman ultra        Maximum compression
/caveman wenyan-lite  Semi-classical Chinese
/caveman wenyan-full  Full 文言文
/caveman wenyan-ultra Extreme 文言文
/caveman micro        Experimental prompt-minimized mode
/caveman off          Disable
/caveman stop         Disable (alias)
/caveman quit         Disable (alias)
```

### Settings

```
/caveman config       Open settings dialog
```

The config dialog lets you:

- **Default level** — Set a level that activates automatically on every new session (e.g. `full` to always start in caveman mode)
- **Show status bar** — Toggle the animated campfire indicator in the footer

Settings are saved to `~/.pi/agent/settings.json` under `saveTokens.caveman` and persist across all sessions.

### Subagent ultra profile

The reusable `ultra` profile keeps the parent session unchanged and applies
Caveman and Ponytail defaults only in a `pi-subagents` child. Attach it to any
role through `subagents.agentOverrides.<role>.subagentOnlyExtensions`:

```json
{
  "subagents": {
    "agentOverrides": {
      "worker": {
        "subagentOnlyExtensions": [
          "~/.pi/agent/extensions/save-tokens/subagent-profiles/ultra.ts"
        ]
      }
    }
  }
}
```

Add the same path to any other role you want to run in ultra mode, then use
`/reload` before launching a new child. Caveman keeps a resumed session's
saved level. Ponytail resolves its default in this order: a valid
`PONYTAIL_DEFAULT_MODE` shell variable, the child profile, then
`saveTokens.ponytail.defaultMode` (followed by Ponytail's own configuration).

### Status Bar

When active, a status bar displays caveman level and an animated campfire flickers in the footer using colored braille characters. This can be disabled in the `/caveman config` menu.

## Levels

| Level                      | Style                                                                                                                      | Example                                                                            |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **Lite**                   | No filler. Full sentences. Professional but tight.                                                                         | "Your component re-renders because you create a new object reference each render." |
| **Full**                   | Drop articles, fragments OK. Classic caveman.                                                                              | "New object ref each render. Wrap in `useMemo`."                                   |
| **Ultra**                  | Abbreviations, arrows, maximum compression.                                                                                | "Inline obj prop → new ref → re-render. `useMemo`."                                |
| **文言文 Lite**            | Semi-classical Chinese, grammar intact.                                                                                    | "組件頻重繪，以每繪新生對象參照故。"                                               |
| **文言文**                 | Full classical terseness.                                                                                                  | "物出新參照，致重繪。useMemo Wrap之。"                                             |
| **文言文 Ultra**           | Extreme classical compression.                                                                                             | "新參照→重繪。useMemo Wrap。"                                                      |
| **Micro** _(experimental)_ | Minimal prompt that reduces size of caveman prompt itself. Drops filler, pleasantries, hedging, keeps technical substance. | "Bug in auth middleware. Token expiry check use `<` not `<=`. Fix:"                |

## How It Works

The extension is a thin orchestrator over the canonical **`caveman` skill** — the skill is the single source of truth for the rules. The extension hooks `before_agent_start` to load the installed `caveman` skill body (frontmatter stripped) once per process, caches it, and injects it into the system prompt with a one-line runtime directive that names the active intensity level.

> **Requirement:** the `caveman` skill must be installed under `~/.pi/agent/skills/caveman/SKILL.md`. The extension auto-detects it at load time; if the skill is missing, no prompt is injected and the extension emits no error (graceful no-op). `micro` is the only level not documented by the skill — it falls back to a small local prompt.

Within a session, the active level is stored as a custom session entry and restored on resume. Across sessions, persistent config (`settings.json` → `saveTokens.caveman`) provides the default level and status bar preference. Auto-clarity rules (defined in the skill itself) tell the model to drop caveman mode for security warnings or irreversible actions.

## Warning

Caveman mode only affects _output tokens_, not chain-of-thought tokens, input tokens, file read/write tool calls, etc. If your agent is in a huge codebase and you've given it a complex task, don't expect much token reduction.

<p align="center">
  <img src="https://raw.githubusercontent.com/jonjonrankin/pi-caveman/main/shoutout.jpg" alt="pi-caveman glowing review" width="600">
</p>

But for the cost-conscious, every token counts ;)

## Credits

Based on [caveman](https://github.com/JuliusBrussee/caveman) by [Julius Brussee](https://github.com/JuliusBrussee).

`micro` mode prompt based on [caveman-micro](https://github.com/kuba-guzik/caveman-micro) by [Kuba Guzik](https://github.com/kuba-guzik).

## License

MIT
