# Browser Tools

Local Pi policy wrapper for the separately installed `pi-agent-browser-native` package.

Pi loads the native package from `~/projects/pi-integrations/pi-agent-browser-native`. The native package owns the `agent_browser` implementation and Chromium lifecycle. This wrapper only controls model access:

- hidden by default;
- `/browser-tools on` grants access for the current session;
- `/browser-tools off` revokes that grant;
- `/browser-tools status` reports `hidden`, `manual`, `manual (restricted)`, or `unavailable`;
- the grant is recorded as a session entry, so quitting and resuming the same session (`/resume`) and `/reload` keep it;
- a `new` or `fork` session starts hidden even when the previous transcript granted access;
- shutdown clears the in-memory grant; the recorded entry stays in the transcript;
- CLI and child tool ceilings remain authoritative;
- `agent_browser_web_search` stays hidden and blocked.

The slash command is user-only. There is no tool that lets the model grant browser access to itself.

## Grant persistence

`/browser-tools on` and `off` append a `browser-tools:grant` custom session entry (`{ granted: true | false }`) through `pi.appendEntry`. Those entries never enter model context; Pi documents them for exactly this purpose ("Persist extension state across session reloads").

On `session_start` the extension re-applies the last recorded grant for `startup`, `resume`, and `reload`. `new` and `fork` deliberately skip the restore, so access never leaks into a session the user did not grant it in. If the transcript is not readable at that moment, the grant stays unresolved and the next input or agent start retries once.

An explicit `/browser-tools` command is authoritative: it records its own entry and is never overwritten by a later re-derivation. Only state transitions are written, so repeating `on` or `off` adds no duplicate entries.

## Footer widget

The extension contributes a display-only footer widget (`browser-tools`, row 2, left) through the shared `_shared/fancy-footer.ts` helper, renders the globe glyph inside its own label, and uses `createUiColors` for the state color. It deliberately declares no footer `icon`: pi-fancy-footer prepends its icon to the first line, which would render the globe twice.

| State | Meaning | Color |
| --- | --- | --- |
| `hidden` | available, but no manual grant for this session | dim |
| `manual` | granted and visible to the model | success |
| `manual (restricted)` | granted, but the CLI, child, or role ceiling keeps it hidden | warning |
| `unavailable` | the native package is not installed | error |

The widget refreshes on `/browser-tools`, session start, input, and before each agent start, and is removed on shutdown. It reports policy state only: the `tool_call` gate above still decides what the model may actually call, and `agent_browser_web_search` stays hidden regardless of what the widget shows.
