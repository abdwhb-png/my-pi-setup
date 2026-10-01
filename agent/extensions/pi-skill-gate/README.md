# Skill Gate

Browse skill instructions and choose which skills appear in the model's catalog with `/skill-gate`. The custom overlay combines a skill sidebar, a Markdown body view, search, usage counts and global/project visibility controls.

[Getting started](#getting-started) · [Features](#features) · [Keyboard reference](#keyboard-reference) · [Configuration](#configuration) · [How it works](#how-it-works) · [Troubleshooting](#troubleshooting)

This local version enables skills by default. Existing explicit disables remain in effect, and skills marked `disable-model-invocation: true` remain manual-only. Visibility choices persist across sessions and apply to subsequent model requests. Hiding a catalog entry does not prevent explicitly loading its instructions.

## Getting started

The extension lives at `~/.pi/agent/extensions/pi-skill-gate/`. Pi discovers its `index.ts` automatically; it uses the harness's existing dependencies.

After adding or updating this local extension, restart Pi or run:

```text
/reload
/skill-gate
```

Use the local extension instead of installing a second copy through `pi install`. An old package declaration would load another instance alongside this one.

The command opens an interactive overlay in a TUI session. RPC, JSON and print sessions receive a warning when attempting to open it; saved visibility choices still apply to model requests in those modes.

## Features

| Feature                     | Behavior                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| Skill list                  | Shows the active skill commands resolved by Pi, with their effective visibility.              |
| Instruction browser         | Displays the selected skill's description and Markdown body, with line numbers and scrolling. |
| Individual choices          | Space changes the selected skill's catalog visibility in the current editing scope.           |
| Two search modes            | Search names with `/`, or include descriptions and bodies with `f`. Matches are highlighted.  |
| Confirmed bulk changes      | Apply enable/disable to the filtered set, or reset the selected scope after confirmation.     |
| Global and project settings | Keep a global preference and override it for a particular working directory.                  |
| Usage display               | Inspect invocation counts in the detail view and optionally show them in the sidebar.         |
| Clipboard and editor        | Copy the selected body or edit its source file in the configured external editor.             |
| Built-in help               | Open a scrollable key reference without leaving the overlay.                                  |

The title shows the effective enabled count. Native manual-only skills stay in the list for browsing and explicit invocation, but do not count as model-visible skills.

## Keyboard reference

Keys depend on the current overlay state. In search mode, Enter finishes the query; in a confirmation, it accepts the operation; in the normal browser, it prepares a skill invocation.

| Key        | Normal browser action                                                                                 |
| ---------- | ----------------------------------------------------------------------------------------------------- |
| Up / Down  | Select the previous or next skill.                                                                    |
| Space      | Switch visibility for the selected skill; manual-only skills cannot be toggled.                       |
| `/`        | Start a query against skill names.                                                                    |
| `f`        | Start a query against names, descriptions and instruction bodies.                                     |
| `b`        | Show or hide the sidebar.                                                                             |
| `u`        | Show or hide the sidebar's Uses column.                                                               |
| `k` / `j`  | Scroll the body backward or forward by roughly three quarters of its viewport.                        |
| Home / End | Move to the beginning or end of the body.                                                             |
| Enter      | Close the browser and ask whether to prepare the selected skill in the chat editor.                   |
| `y`        | Copy the selected instruction body to the clipboard.                                                  |
| `o`        | Open the selected skill file in an external editor.                                                   |
| `g`        | Change between global and project editing when the working directory differs from the home directory. |
| `a`        | Request enabling the filtered set of toggleable skills.                                               |
| `A`        | Request disabling the filtered set of toggleable skills.                                              |
| `r`        | Request clearing saved choices in the selected scope.                                                 |
| `?`        | Open the keyboard help.                                                                               |
| Escape     | Clear an active filter first; otherwise close the browser.                                            |

Navigation and shortcuts recognize supported legacy terminal input and Kitty encodings. Key-release events do not trigger actions.

### Searching and filtered actions

1. Press `/` for names or `f` for names, descriptions and bodies.
2. Type a query. Backspace removes its last character; Up/Down moves between matches.
3. Press Enter to leave query entry while retaining the filter.
4. Browse the matching instructions, invoke a selection, or apply `a`/`A` to that filtered set.

Name prefixes rank ahead of other name matches; full-text results follow name matches. Searches are case-insensitive. Enter during query entry does not invoke the selected skill.

Escape during query entry clears the search and exits that mode. After a query is committed, the first Escape clears the filter and a second Escape closes the browser.

### Bulk confirmations and reset

Enable and disable confirmations show the target count and editing scope using the warning color. Native manual-only skills are excluded, and an active filter limits the affected names.

Reset uses the error color and clears saved choices for the selected scope. It applies to that scope as a whole, including choices outside the active search filter. Resetting global choices restores enabled defaults; resetting project choices restores inheritance from global settings.

In a confirmation, Enter or `y` accepts, and Escape or `n` cancels. Other input is ignored until the dialog is resolved.

### Help

Press `?` for the in-overlay reference. Up/Down and `k`/`j` scroll it; `?`, Escape or `q` returns to the browser. Help cannot interrupt a pending bulk confirmation.

### Explicit invocation

Enter in the normal browser opens an invocation confirmation. Accepting it places `/skill:<name>` in Pi's chat editor. Submit that editor text to invoke the skill. Cancelling the confirmation returns to the selected skill.

A hidden skill remains available through explicit `/skill:<name>` invocation. The separate `pi-skill-loader` extension also provides `$name`, `/load-skills` and `load_skill`. A native manual-only flag continues to exclude a skill from automatic catalog visibility even when a saved choice says enabled.

### Copying and editing instructions

`y` copies the body after frontmatter removal. The overlay reports clipboard failures.

`o` chooses `$VISUAL` first, then `$EDITOR`. The browser closes and the TUI pauses while the editor owns the terminal. When the editor exits, the TUI resumes, cached bodies are cleared and the browser reopens on the selected skill. A missing file, failed process launch or unsuccessful exit is reported.

For example, configure an editor in your shell:

```sh
export EDITOR='vim'
# Or use an editor that waits for its window to close:
export EDITOR='code --wait'
```

Editor commands are split on spaces; quoted arguments and executable paths containing spaces are not parsed as shell command lines. External edits made outside this workflow may require `/reload` to refresh cached bodies and Pi's catalog.

## Configuration

Visibility choices live in `~/.pi/agent/config/skill-gate.json`. The file is created when a changed choice is saved; merely opening the browser does not create it. `PI_CODING_AGENT_DIR` relocates the agent directory and both state files.

### Resolution order and enabled defaults

For each skill, the effective saved choice resolves in this order:

1. A choice for the current working directory.
2. A global choice.
3. Enabled when neither scope defines it.

Newly discovered skills therefore start enabled. Existing explicit disables are preserved. Native `disable-model-invocation: true` is applied independently and always keeps that skill out of the model's catalog.

Both `"enabled"` and `"disabled"` are accepted in existing configuration. Saving a toggle omits that choice when it matches the inherited state, keeping unnecessary overrides out of the file.

### Global example

```json
{
    "skills": {
        "code-review": "disabled"
    },
    "projects": {}
}
```

This hides `code-review` globally. Other skills remain enabled unless another saved choice or their own manual-only metadata excludes them.

### Project example

```json
{
    "skills": {
        "code-review": "disabled"
    },
    "projects": {
        "~/engineering/example-app": {
            "skills": {
                "code-review": "enabled",
                "debugger": "disabled"
            }
        }
    }
}
```

In `~/engineering/example-app`, this enables `code-review` despite the global disable and hides `debugger`. Other working directories continue to use the global choices.

Project scope uses Pi's current working directory. A choice for a parent directory does not automatically apply to every child directory. Paths inside the home directory are saved as `~/…`; existing absolute keys remain readable. If portable and absolute aliases both exist for the same directory, the portable choice takes precedence. Saving a project change consolidates those aliases while preserving the other project choices.

The browser starts in global editing scope. Press `g` to edit the current project's choices. The display identifies explicit global inheritance with `·G` in project scope and project overrides with `·P` in global scope. A project disable of a globally enabled skill uses the error color. Effective state can still come from a project override while you are editing its underlying global choice.

### Persistence and failure handling

Visibility saves replace the file atomically before updating the active in-memory choices. A failed save leaves those choices intact and displays an error. Malformed JSON or invalid toggle values are reported; opening the browser does not overwrite the broken file.

The request hook reads saved configuration again for each model request. If that read fails after a successful read, it reports the error and uses the session's last valid choices. Without a previous valid configuration, it reports the error and leaves the request unchanged. Correct the file rather than assuming a warning means hidden entries were filtered.

### Usage counts

Counts are independent of visibility and live in `~/.pi/agent/config/skill-gate-analytics.json`:

```json
{
    "counts": {
        "code-review": 47,
        "debugger": 12
    }
}
```

The input hook records `/skill:<name>` references it receives, counting each name once per input. It does not separately count `$name` mentions or direct `load_skill` tool calls.

The detail pane shows the selected skill's count, or a dash when unused. Press `u` to add counts to the sidebar. To reset them, set the file to `{"counts": {}}` or remove that analytics file. Invalid analytics are reported without silently replacing the file; the browser remains usable with unavailable counts displayed as zero.

## How it works

Pi owns resource discovery, package resolution and project trust. Skill Gate reads the resulting skill command paths through `pi.getCommands()` and loads their metadata using the public `loadSkills` API with `includeDefaults: false`.

```text
Pi's active skill command paths
              |
      loadSkills metadata
              |
      cached active catalog ---------> custom browser
              |                              |
   before_provider_request             saved choices
              |                              |
              +------ visibility resolution --+
              |
     shared provider prompt adapter
              |
    filtered outgoing skill catalog
```

Metadata refreshes at session start, before an agent run and when opening the browser. New packages and resource declarations become available when Pi refreshes its active catalog, such as through `/reload`.

Discovery does not create or reload a `DefaultResourceLoader`. Reloading one would initialize another set of extension factories; using the active catalog avoids that side effect and leaves the running Sandbox owner intact.

Request filtering removes excluded entries only inside Pi's `<available_skills>` catalog blocks. Other instructions, explicit skill bodies, user messages and provider metadata remain intact. The shared adapter supports OpenAI completions and Responses families, Mistral conversations, Anthropic, Google/Vertex, Bedrock and structured `pi-messages` requests. An unsupported or malformed request shape produces a warning and passes through unchanged.

The shared visibility policy is also used by `pi-skill-loader` when it contributes recovered skill metadata. Its recovery catalog respects saved disables and manual-only flags without replacing the entire system prompt.

This mechanism controls catalog visibility. It does not remove installed skills, block explicit invocation or enforce tool permissions.

## Troubleshooting

| Symptom                                                      | Next step                                                                                                                                                         |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/skill-gate` is unavailable                                 | Run `/reload` or restart Pi, then confirm the local directory contains `index.ts`.                                                                                |
| Interactive-terminal warning                                 | Open the browser from a TUI session; headless modes use saved choices without displaying the overlay.                                                             |
| No skills found or an expected skill is absent               | Check Pi's `/skill:` autocomplete and resource configuration, then reload. Skill Gate follows the active paths instead of scanning extra locations independently. |
| Space has no effect                                          | Check whether the skill is native manual-only. That metadata cannot be overridden here.                                                                           |
| Changing a global choice does not change the displayed state | Check for a project override and the current editing scope.                                                                                                       |
| Broken visibility configuration                              | Correct the reported JSON or value error. Existing saved content is left untouched.                                                                               |
| Visibility-adapter warning                                   | Filtering did not apply to that request. Inspect the reported request-format error.                                                                               |
| Editor does not open                                         | Configure `$VISUAL` or `$EDITOR`; check the reported file or process error.                                                                                       |
| Body appears stale after an external edit                    | Reopen through the editor workflow or run `/reload`.                                                                                                              |
| Usage counts are unavailable                                 | Correct or deliberately reset the separate analytics file.                                                                                                        |

## Development and provenance

This is a local adaptation of [cullendotdev/pi-skill-gate, version 0.9.1 at `7b73c43`](https://github.com/cullendotdev/pi-skill-gate/tree/7b73c43f6c00ba2f070a4ab12efa5a3ecf604b8b), under the included [MIT license](LICENSE). It retains the custom sidebar, Markdown view, help, search, confirmation dialogs and controls.

Local adaptations include enabled defaults, preserved explicit choices, portable project paths, shared theme/path/config helpers, request-level catalog filtering, visible persistence failures and terminal recovery after editing. The upstream disabled default, resource-loader refresh, whole-prompt replacement and silent reset of broken configuration do not describe this version.

From `~/.pi/agent`, run:

```sh
bun test --isolate extensions/pi-skill-gate extensions/__tests__/integration/skill-visibility.integration.test.ts
bun run lint:boundaries
```

Tests cover persistence and precedence, enabled defaults, native manual-only metadata, supported request adapters, structured prompt preservation, keyboard input, search and confirmations, editor recovery, extension-factory isolation and composition with the skill loader. Test state uses temporary agent directories rather than personal configuration.
