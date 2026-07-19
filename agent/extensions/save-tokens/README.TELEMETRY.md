# Save-Tokens Telemetry

**Observational telemetry for the save-tokens compression pipeline.**

Records structured, versioned JSONL events describing each session: agent runs,
turns, tool results (raw + final), mode changes, and experiment tags.
Designed for offline analysis -- no network egress, no external service.

> **Privacy warning:** Content archives remain sensitive despite redaction.
> Redaction is deterministic best-effort (pattern + key matching), not perfect.
> No encryption is applied at rest. Treat the telemetry directory as sensitive.

---

## Configuration

Settings live in `~/.pi/agent/settings.json` (or project-local `.pi/settings.json`)
under the `saveTokens.telemetry` key. All values are optional -- defaults apply
when omitted.

```json
{
  "saveTokens": {
    "telemetry": {
      "enabled": true,
      "directory": "/custom/path",
      "captureContent": true,
      "redactSecrets": true,
      "retentionDays": 90,
      "maxStringLength": 10000,
      "maxArrayItems": 100,
      "maxDepth": 20
    }
  }
}
```

| Key               | Type      | Default                             | Description                                                                                                                                                                             |
| ----------------- | --------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`         | `boolean` | `true`                              | Master on/off switch. When `false`, no records are produced and all hooks are no-ops.                                                                                                   |
| `directory`       | `string`  | `~/.pi/agent/save-tokens-telemetry` | Root directory for the telemetry archive. Created with `0700` permissions.                                                                                                              |
| `captureContent`  | `boolean` | `true`                              | When `true`, captures `content`, `input`, and `details` fields from tool results (JSON-serialized, then redacted). When `false`, only metrics (content length, tool name) are recorded. |
| `redactSecrets`   | `boolean` | `true`                              | Apply deterministic redaction to `content`/`input`/`details` before writing (see [Redaction](#redaction)).                                                                              |
| `retentionDays`   | `integer` | `90`                                | Auto-purge threshold. Date directories older than this many days are deleted at session startup. Must be a finite positive integer.                                                     |
| `maxStringLength` | `integer` | `10000`                             | Maximum string length before truncation during redaction. Must be a finite positive integer.                                                                                            |
| `maxArrayItems`   | `integer` | `100`                               | Maximum array items before truncation during redaction. Must be a finite positive integer.                                                                                              |
| `maxDepth`        | `integer` | `20`                                | Maximum object nesting depth during redaction. Deeper values replaced with `[DEPTH_CLIPPED]`. Must be a finite positive integer.                                                        |

**Numeric validation:** `retentionDays`, `maxStringLength`, `maxArrayItems`, and
`maxDepth` are validated with `isFinitePositive` -- rejects floats, decimals,
zero, negative, `NaN`, and `Infinity`. Non-conforming values silently fall back
to defaults.

**Config merge:** `normalizeTelemetry` always returns a complete config merged
with defaults, even when the user provides an empty object.

---

## Archive Layout

```
~/.pi/agent/save-tokens-telemetry/
├── 2026-07-18/
│   ├── abc123.jsonl
│   └── def456.jsonl
├── 2026-07-17/
│   └── xyz789.jsonl
├── exports/
│   └── telemetry-export-2026-07-18T12-00-00-000Z.json
└── .last-purge
```

- **Root:** created with `0700` permissions.
- **Date directories:** `YYYY-MM-DD`, created with `0700`.
- **Session files:** `<sessionId>.jsonl`, created with `0600`. Append-only, one
  JSON record per line.
- **`.last-purge` marker:** `0600`, written atomically (temp file + rename).
- Symlinks are skipped (never followed) during scanning, purge, and archive
  reads.
- Session IDs allowlisted to `[a-zA-Z0-9._-]+` -- path traversal characters
  rejected.

---

## Event Schema (Version 1)

Every record carries:

| Field           | Type                | Description                                           |
| --------------- | ------------------- | ----------------------------------------------------- |
| `schemaVersion` | `1`                 | Schema version (constant).                            |
| `eventId`       | `string` (UUID v4)  | Unique event identifier.                              |
| `timestamp`     | `string` (ISO 8601) | Event timestamp in UTC.                               |
| `sessionId`     | `string` (UUID v4)  | Generated at session start; ties all events together. |

### Event Types

| Event               | When emitted                   | Extra fields                                                                                                 |
| ------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `session_start`     | Session begins                 | `cwd`, `model`, `provider`, `thinkingLevel`, `project`, `extensions[]`, `configSnapshot`                     |
| `session_end`       | Session shuts down             | `durationMs`, `toolCallCount`                                                                                |
| `agent_run_start`   | Agent begins processing        | `runId`, `turnCount`, `model`, `provider`, `thinkingLevel`, `cwd`, `project`                                 |
| `agent_run_end`     | Agent finishes                 | `runId`, `durationMs`, `turnCount`, context fields                                                           |
| `turn_start`        | Turn begins                    | `runId`, `turnIndex`, context fields                                                                         |
| `turn_end`          | Turn completes                 | `runId`, `turnIndex`, `toolCallCount`, `durationMs`, `usage` (tokens + cost), context fields                 |
| `raw_tool_result`   | Before compression             | `runId`, `turnIndex`, `toolCallId`, `toolName`, `contentLength`, `isError`, `content?`, `input?`, `details?` |
| `final_tool_result` | After compression              | Same as raw + `compressionDetails?`                                                                          |
| `mode_change`       | Caveman/Ponytail level changes | `component`, `requested`, `effective?`, `previous`, `next`, `source`                                         |
| `experiment_tag`    | User sets a tag                | `tag`, `value?`                                                                                              |

### Runtime Context

Events that carry execution context (`session_start`, `agent_run_start/end`,
`turn_start/end`) include: `provider`, `model`, `thinkingLevel`, `cwd`, `project`.
Other events inherit context from the chronological reconstruction during
analytics filtering.

---

## Redaction

When `redactSecrets: true` (default), `content`, `input`, and `details` fields
are walked recursively before writing. The redactor is **pure, deterministic,
and best-effort** -- it cannot guarantee perfect secret detection.

### Sensitive Key Masking (case-insensitive, hyphens stripped)

| Key match                                                                                                                                  | Replacement  |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| `authorization`, `apikey`, `api_key`, `token`, `access_token`, `refresh_token`, `password`, `cookie`, `set-cookie`, `secret`, `privatekey` | `[REDACTED]` |

### Pattern Detection

| Pattern                   | Example match                              |
| ------------------------- | ------------------------------------------ |
| `Bearer <token>`          | `Bearer eyJ...`                            |
| `sk-<key>` (≥10 chars)    | `sk-proj-abc123...`                        |
| JWT tokens (`eyJ...`)     | `eyJhbGci...eyJzdWIi...sig...`             |
| Sensitive env assignments | `export API_KEY=...`, `set SECRET_KEY=...` |

### Bounds

| Limit             | Default | Overflow marker        |
| ----------------- | ------- | ---------------------- |
| `maxDepth`        | 20      | `[DEPTH_CLIPPED]`      |
| `maxStringLength` | 10000   | Truncated with `...`   |
| `maxArrayItems`   | 100     | `[TRUNCATED: N items]` |

Circular references: `[CIRCULAR]`.

### Content Capture Disabled

When `captureContent: false`, only `contentLength`, `toolName`, and `isError`
are recorded. No content, input, or details fields are serialized.

---

## Retention and Purge

- **Trigger:** `session_start` event (once per session, at startup).
- **Guard:** at-most-once-per-day via `.last-purge` marker.
- **Cutoff:** directories strictly older than `retentionDays` days from today.
- **Safety:** only deletes `YYYY-MM-DD` directories; skips symlinks, non-date
  entries, and non-directory files.
- **Default:** 90 days.
- **Errors:** non-blocking -- purge failure does not prevent telemetry recording.

---

## Commands

Three slash commands registered in the Pi runtime:

### `/save-tokens-experiment`

Set an experiment tag for the current session.

```
/save-tokens-experiment <tag> [value]
```

- **Tag:** `[A-Za-z0-9._-]+`, max 128 characters.
- **Value (optional):** parsed as `boolean` (`true`/`false`), then finite
  `number`, else `string`.
- **Persistence:** tag record is written as a `experiment_tag` event. The
  command confirms success only after the write completes successfully to disk.
  Returns error if telemetry is disabled, no session exists, or the write fails.
- **Scope:** applies to the current session. Subsequent events in the same
  session are annotated with this tag during analytics.

**Examples:**

```
/save-tokens-experiment baseline
/save-tokens-experiment ab-test variant-ultra
/save-tokens-experiment stress-test 3
```

### `/save-tokens-stats`

Scan, filter, aggregate, and display a summary table.

```
/save-tokens-stats [key=value ...]
```

**Filter keys:**

| Key        | Type                     | Description                                                                                                     |
| ---------- | ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `from`     | `YYYY-MM-DD`             | Inclusive start date.                                                                                           |
| `to`       | `YYYY-MM-DD`             | Inclusive end date.                                                                                             |
| `tag`      | `string`                 | Experiment tag (exact match).                                                                                   |
| `provider` | `string`                 | Model provider (exact match).                                                                                   |
| `model`    | `string`                 | Model name (exact match).                                                                                       |
| `project`  | `string`                 | Project directory (exact match).                                                                                |
| `thinking` | `string`                 | Thinking level (exact match).                                                                                   |
| `caveman`  | `on` / `off` / `<level>` | Caveman mode filter. `on` = any non-off; `off` = disabled; or a specific level (`lite`, `full`, `ultra`, etc.). |
| `ponytail` | `on` / `off` / `<mode>`  | Ponytail mode filter. Same semantics as caveman.                                                                |

**Date range:** from and to are **inclusive**. `from=2026-07-01 to=2026-07-15`
includes both July 1 and July 15.

**Comparative groups (always shown, even if zero):**

| Group key                | Meaning                       |
| ------------------------ | ----------------------------- |
| `observed_off_off`       | Both Caveman and Ponytail off |
| `observed_caveman_only`  | Caveman on, Ponytail off      |
| `observed_ponytail_only` | Ponytail on, Caveman off      |
| `observed_combined`      | Both Caveman and Ponytail on  |

**Parser rules:**
- Whitespace-delimited `key=value` tokens.
- Spaces around `=` normalized (`key = value` → `key=value`).
- Unknown keys, duplicate keys, empty values, and bare words (no `=`) are
  rejected with an error message.
- **Quoted spaces are not supported** -- values containing spaces cannot be
  parsed.

**Examples:**

```
/save-tokens-stats
/save-tokens-stats from=2026-07-01 to=2026-07-15
/save-tokens-stats caveman=on ponytail=off tag=baseline
/save-tokens-stats provider=anthropic model=claude-sonnet-4-6
```

**Output:** compact text table with group rows, column headers, scan
diagnostics, and a note:

> *Note: groups represent observed correlation, not causation.
> Compression savings = global saved/original ratio.*

### `/save-tokens-export`

Export aggregated telemetry as JSON or CSV to a file.

```
/save-tokens-export [key=value ...]
```

Same filter keys as `/save-tokens-stats`, plus:

| Key      | Type            | Default        | Description                |
| -------- | --------------- | -------------- | -------------------------- |
| `format` | `json` / `csv`  | `json`         | Output format.             |
| `out`    | `string` (path) | auto-generated | Explicit output file path. |

**Export path behavior:**

| `out` value           | Resolved to                                                       |
| --------------------- | ----------------------------------------------------------------- |
| Not provided          | `<telemetry-root>/exports/telemetry-export-<ISO-timestamp>.<ext>` |
| `~`                   | Home directory                                                    |
| `~/path/file.json`    | `$HOME/path/file.json`                                            |
| `~other/path`         | Relative to `ctx.cwd` (only bare `~` and `~/` expand)             |
| `relative/path.json`  | Resolved from `ctx.cwd`                                           |
| `/absolute/path.json` | Used as-is                                                        |

**File behavior:**
- **Explicit path (`out=`):** file created with `0600` permissions. Fails with
  an error if the file already exists -- no overwrite.
- **Default path (no `out=`):** file created with `0600` in `<root>/exports/`.
  If the file already exists, a numeric suffix is appended (`-1`, `-2`, …).
- **Export directory:** only the `exports/` subdirectory (when newly created by
  mkdir) gets `0700`. Pre-existing parent directories (e.g., `/tmp`) retain
  their original permissions.
- **Cleanup:** partial files from failed writes are removed.

**JSON export:**
- Versioned (`exportVersion: 1`).
- Keys sorted alphabetically (deterministic output).
- Contains `query` (scan + filter params), `diagnostics`, and `rows[]`.

**CSV export:**
- Header row + one data row per group (4 rows).
- RFC 4180 escaping (quotes, commas, newlines).

**Examples:**

```
/save-tokens-export
/save-tokens-export format=csv
/save-tokens-export format=json out=~/reports/july.json from=2026-07-01 to=2026-07-15
/save-tokens-export format=csv out=./data.csv caveman=on
```

---

## Mode Detection

Caveman and Ponytail modes are detected by scanning the system prompt (after
extension injection) on every `before_agent_start` event.

| Compressor | Detection regex                                    | Source                                            |
| ---------- | -------------------------------------------------- | ------------------------------------------------- |
| Caveman    | `/ACTIVE LEVEL:\s*([\w-]+)/i`                      | Caveman extension injects the active level marker |
| Ponytail   | `/PONYTAIL MODE ACTIVE\s*[—–-]\s*level:\s*(\S+)/i` | Ponytail extension injects the mode marker        |

When a mode changes, a `mode_change` event is written with `previous`, `next`,
`requested`, `effective`, and `source: "systemPrompt_scan"`.

Default mode for both is `off` (reset per session).

---

## Reliability and Failure Modes

- **Write failures do not block the agent.** `safeAppend` catches all errors;
  the first failure emits a console warning (`[save-tokens/telemetry] write
  failed`); subsequent failures are silent.
- **No writer = no crash.** If the writer cannot be created (e.g., permission
  denied on the root directory), telemetry degrades gracefully -- all hooks
  remain registered but records are discarded.
- **Purge errors are non-blocking.** If the retention purge fails, normal
  telemetry recording continues unaffected.
- **Command errors caught internally.** All three slash commands catch errors
  and notify via `ctx.ui.notify(..., "error")` -- they never crash the agent
  loop.

---

## Observational Scope

This telemetry system is **purely observational**. It records what happened:
which modes were active, what compression ratios were achieved, how many tokens
were consumed.

**Correlation, not causation.** The comparative groups
(`observed_off_off`, `observed_caveman_only`, `observed_ponytail_only`,
`observed_combined`) show measured differences between states -- they do not
prove that Caveman or Ponytail *caused* those differences. Many confounding
factors (task complexity, model, codebase size, turn count) affect the numbers.

---

## Schema Dependencies

- **Canonical compression source:** `pi:compression:event` session entries
  (custom type `pi:compression:event`) -- used for `final_tool_result`
  compression details.
- **Session reference:** `pi:save-tokens:telemetry-ref` entry appended at
  session start (lightweight marker for session reconstruction).

---

## File Summary

| File                      | Purpose                                                          |
| ------------------------- | ---------------------------------------------------------------- |
| `config.ts`               | Telemetry config types, defaults, normalization                  |
| `telemetry/types.ts`      | Versioned discriminated union (10 event types)                   |
| `telemetry/storage.ts`    | JSONL append/read/purge, permission guards, traversal protection |
| `telemetry/redaction.ts`  | Pure recursive redactor: keys, patterns, bounds, cycles          |
| `telemetry/controller.ts` | Runtime pipeline: event handlers, mode scanning, factory         |
| `telemetry/analytics.ts`  | Pure scan/filter/aggregate/export engine                         |
| `telemetry/commands.ts`   | Three Pi slash commands + parser                                 |
