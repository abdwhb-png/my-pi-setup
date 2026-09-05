# Think-in-Code

Native Pi extension that runs safe commands through a shared safe-execution
service, analyzes raw data inside a strict two-layer sandbox, persists
searchable project-local evidence, and restores a deterministic
post-compaction snapshot.

This extension replaces the legacy `npm:context-mode` MCP server. See
[ADR-019](../../../../docs/adr/ADR-019-think-in-code-native-extension.md)
for the architecture decision.

## Architecture boundaries

Four deep boundaries, each owned by exactly one extension or shared
service:

| Boundary             | Owner                                                          | Purpose                                                                                                                                                                  |
| -------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Safe execution       | `agent/extensions/_shared/safe-execution/`                     | Guard authorization, native-tool redirect, rewrite, sandboxed Bash execution, telemetry, session approvals. Published through `Symbol.for("pi.safe-execution-core.v1")`. |
| Analysis broker      | `agent/extensions/_shared/analysis/sandbox-analysis-broker.ts` | Strict `quickjs` / `python` worker dispatch, downward-clamped limits, length-prefixed JSON over stdio, concurrency semaphore of two, process-group cleanup.              |
| Per-language workers | `agent/extensions/sandbox/analysis/`                           | QuickJS WASM for JavaScript/TypeScript and Eryx WASM in a dedicated Node JSPI worker for Python, each wrapped by the strict Zerobox analysis profile.                    |
| Think-in-Code        | `agent/extensions/think-in-code/`                              | Tool orchestration, per-project SQLite FTS5 store, raw archives, session capture, snapshot builder, one-shot restore.                                                    |

The Think-in-Code layer never duplicates policy, sandbox, or redaction
logic. It composes the three shared services and never bypasses them.

## Tools

Five native Pi tools are registered:

- `think_execute` — run a command, inline content, or analyze prior
  archive IDs through the sandboxed analyzer. Raw output is archived
  and never returned to the LLM.
- `think_execute_file` — read one project file (≤ 64 MiB) and analyze
  it through the analyzer with `FILE_CONTENT` / `FILE_PATH` bindings.
  The worker process receives no filesystem mount.
- `think_batch_execute` — run up to 16 commands (global concurrency 2),
  archive every result, then run one analyzer over a structured
  `INPUTS` array. Per-item blocked/failed status is preserved.
- `think_index` — index bounded text or existing archive IDs (after
  redaction). Never reads a host path.
- `think_search` — search the FTS5 index. Returns bounded ranked
  snippets plus archive/document IDs. Never returns raw archive bytes.

A single `think_execute` invocation produces exactly one outer tool
result. The inner `safe_bash` call is a function call on the shared
safe-execution service, not a Pi tool call, so it does not appear as
a nested result.

### Streaming progress and the raw-output boundary

The Pi runtime streams `tool_execution_update.partialResult` updates
through the parent-supplied `onUpdate` callback. The Think coordinator
wraps that callback with a sanitizer before forwarding it to the
shared safe-execution service. The wrapper:

- Replaces every `content` text block with `[]` (raw stdout/stderr
  bytes never reach the agent).
- Forwards only the whitelisted scalar metadata of the bash
  `TruncationResult` (`truncated`, `truncatedBy`, `totalLines`,
  `totalBytes`, `outputLines`, `outputBytes`, `lastLinePartial`,
  `firstLineExceedsLimit`, `maxLines`, `maxBytes`). The `content`
  field of the truncation object can carry up to ~50 KiB of raw
  stdout tail and is dropped explicitly. The very first revision
  that forwarded `truncation` verbatim was a P0 raw-output leak
  (visible only after switching the test fakes to the real
  `TruncationResult` shape from `@earendil-works/pi-coding-agent`'s
  `truncate.d.ts`).
- Drops `fullOutputPath` because it points to a temp file holding
  the full raw stdout and would let an agent locate raw bytes on
  disk.

The TUI progress signal and elapsed-time rendering keep working
because the partial rendering only consumes the (now-empty) content
plus the truncation shape.

### Failure normalization and the raw-output boundary

Bash-shaped failures (`Command exited with code N`, `Command timed out
after N seconds`, `Command aborted`, plus the internal `aborted` /
`timeout:N` pre-spawn throws) carry the truncated raw stdout in the
error message produced by `bash.js`. The coordinator never copies
`Error.message` verbatim:

- bash-shaped failures are detected by their trusted suffix, and the
  reason returned to the LLM is the suffix only (`"Command exited
with code 1"`, etc.).
- guard denials and native-tool redirects (`SafeExecutionError`
  kind `guard` / `redirect`) keep their descriptive reason because
  the underlying `inspectDangerousMatches` /
  `redirectShellCommandWithPolicy` paths never embed raw command
  output.
- safe-execution broker unavailability (`SafeExecutionError` kind
  `unavailable`) is typed at the broker itself; the coordinator
  refuses to trust message prefixes that a downstream Python or
  QuickJS program could forge (e.g. by raising
  `Exception("Safe execution unavailable: " + FILE_CONTENT)`). The
  only fallback that accepts the legacy prefix rewrites the reason
  to a static phrase so the attacker-controlled tail is never
  forwarded.
- any other throwable is redacted to
  `"Command failed (raw output redacted)"`.

Analyzer failures (QuickJS / Python worker errors) are routed through
a dedicated `analyzerFailureReason(error, language)` helper that
returns a bounded reason. The production path always observes
`error.name === "Error"` because `client.ts` wraps every host
failure as `new Error(...)`, so the model sees e.g.
`"Analysis failed (python)"` or `"Analysis failed (javascript)"`.
The helper never copies `error.message` verbatim, so a
`throw new Error(FILE_CONTENT)` program or a `throw new Error(INPUT)`
program cannot exfiltrate raw binding values through content text,
`details.blockedReason`, `details.items[].error`, the analyzer
`INPUTS` JSON binding, or any indexed search text.

The raw error message is retained on `SafeExecutionError.raw`
(non-enumerable so `JSON.stringify` and spread logs cannot see it)
for capture warnings and telemetry only. The same normalization
applies to batch item errors, the analyzer `INPUTS` JSON binding,
and the per-tool `details.blockedReason` / `content` text — raw
stdout, file content, or any other binding value cannot reach the
agent when a safe-execution command fails, times out, is aborted,
or an analyzer program throws.

Path-validation errors thrown from the file reader (e.g. `Path
escapes project root`, `File exceeds 64 MiB limit`) keep their
descriptive message because the only caller-controlled substring
they carry is the LLM's own `request.path`, which the LLM already
supplied and is expected to see reflected back.

Source/store/archive validation errors thrown out of
`coordinator.execute` (e.g. `Archive not found: <id>`,
`Invalid archive id: <id>`, `Unsupported source kind`) likewise
reach the model with their static actionable message. Only the
`safeExecution.execute(...)` call inside `handleCommand` is
funneled through `safeFailureReason`; the surrounding validation
layer never goes through the safe-execution classifier.

### Cross-extension identity for `SafeExecutionError`

Pi loads every extension entrypoint through its own Jiti instance
with `moduleCache: false` (see `@earendil-works/pi-coding-agent/dist/
core/extensions/loader.js`). Two extensions (e.g. `safe-bash` and
`think-in-code`) therefore get separate copies of every imported
module; `instanceof SafeExecutionError` compares two distinct class
objects and returns `false`. The Think coordinator's `isSafeExecutionError`
guard bridges this gap with a process-global
`Symbol.for("pi.safe-execution.SafeExecutionError")` brand stamped
on every `SafeExecutionError` instance. The guard reads the brand
plus the closed-set kind validation (a malicious script that stamps
the brand alone still falls closed because the kind must also be in
`SafeExecutionFailureKind`). The brand is non-enumerable so it
never appears in `JSON.stringify(error)` or spread logs, alongside
the existing `kind` and `raw` properties.

The same `Symbol.for` pattern is already used in
`_shared/safe-execution/broker.ts`
(`Symbol.for("pi.safe-execution-core.v1")`).

### Compaction and restore

`session_before_compact` builds a deterministic snapshot capped at
1,500 estimated tokens using Pi's exported `estimateTokens`. Priority
order (high → low):

### Analyzer program syntax

The five native tools expose `language` and `program` parameters whose
descriptions document the analyzer's contract:

- **JavaScript / TypeScript** — the program is loaded as an ES module.
  Valid programs MUST use `export default <value>` to return derived
  text. Top-level `return` is a `SyntaxError` because the script is
  evaluated as a module body, not a function body. Bindings
  (`INPUT`, `INPUTS`, `FILE_CONTENT`, `FILE_PATH`, `ARCHIVES`,
  `ARCHIVE_IDS`, plus caller-supplied names) are exposed as
  `const` locals with frozen objects and no `fetch`, `process`, or
  filesystem globals.
- **Python** — the program runs as a top-level statement block inside
  an Eryx JSPI sandbox. Bindings become locals and the program MUST
  assign to a top-level `result` variable. The value of that
  assignment becomes the returned derived text.

The `description` field on each schema is the source of truth; LLM
tool planners see it directly.

## Exact dependencies

Pinned sandbox components:

- managed `~/.pi/bin/zerobox` `0.3.3-fork.8`, verified by exact binary,
  source, engine, and ordered-patch provenance;
- `typescript@6.0.3` for the QuickJS programmatic transform API and
  `@typescript/native` aliased to `typescript@7.0.2` for the native compiler;
- `@sebastianwessel/quickjs@3.1.0` — JavaScript/TypeScript analyzer.
- `@bsull/eryx@0.6.0` — Python analyzer.

The store uses `bun:sqlite` (ships with Bun). No extra database
dependency is added.

## Prerequisite: Linux + Node JSPI

The extension assumes Linux with the managed Zerobox binary,
`/usr/bin/mkfifo`, and `prlimit` available. The Python analyzer requires `/usr/bin/node` with
`--experimental-wasm-jspi` because Eryx documents JSPI but does not
document Bun support. The dependency-contract test in
`agent/extensions/sandbox/dependency-contract.test.ts` runs an
executable smoke at install time. A missing capability publishes an
unavailable broker state and fail-closes the analysis service.

Pi runtime validation runs under Bun via
`@abdwhb-png/pi-test-harness` with stubbed brokers
(`runtime.integration.test.ts`). The actual real-Linux isolation is
exercised by the focused tests under
`agent/extensions/sandbox/analysis/`.

## No-network policy

The analyzer network access is **always disabled**. Its fixed Zerobox policy
uses an empty outbound allowlist, exposes no inbound-binding or arbitrary Unix
socket capability, and grants writes only to the request's private `HOME` and
`TMPDIR`. The launcher environment contains only its private `ZEROBOX_HOME`;
the final target receives its fixed environment through the private target-env
channel after filesystem/network isolation is active.

There is no `think_fetch_and_index`. Existing web and MCP tools retain
fetching. The `thinkInCode.network` configuration key is locked to
`false` and is never honored otherwise.

## Tool groups

`think_*` tools are exposed through three groups in
`agent/tool-groups.json` so roles can opt in with least-privilege:

| Group            | Members                                                      |
| ---------------- | ------------------------------------------------------------ |
| `@think-inspect` | `think_index`, `think_search`                                |
| `@think-exec`    | `think_execute`, `think_execute_file`, `think_batch_execute` |
| `@think`         | `@think-inspect`, `@think-exec`                              |

Planning/research roles use `@think-inspect`. Execution-capable roles
(`atlas-orchestrator`, `herdr-orchestrator`, `debug`) use `@think`.
The granular split preserves least-privilege: planning agents cannot
reach the analyzer broker. Verifiers in
`brainstorm-forcer/verification.ts` may call `think_search` but never
any execute tool. The legacy `@ctx-inspect`, `@ctx-exec`, and `@ctx`
group definitions were removed at Task 9 cutover.

The `saveTokens` allowlist excludes all five `think_*` names so
post-compression does not erase the pre-reduced result.

## Storage

Per-project stores live under
`~/.pi/agent/think-in-code/projects/<sha256(realpath(cwd))>`.

- Directories: mode `0700`
- Files (DB + archives): mode `0600`
- Archive names: opaque IDs
- Writes: temporary file + atomic rename
- Symlinks rejected at the store root and along every archive path
- Canonical project path persisted alongside so the store can detect
  an impossible hash/path mismatch on reopen

Raw archives are stored **unredacted** so later isolated analysis
remains lossless. Metadata, indexed text, snippets, and session
snapshots are redacted and bounded before persistence or LLM
exposure (`agent/extensions/_shared/redaction.ts`).

The store never opens, migrates, moves, or deletes existing Context
Mode databases under `~/.pi/context-mode/`.

## Retention

- 24-hour TTL on every archive row/file.
- 512 MiB per-project quota with oldest-first eviction.
- Retention runs on session start and after every archive write.
- Never follows symlinks; never deletes outside the project store.

## Compaction and restore

`session_before_compact` builds a deterministic snapshot capped at
1,500 estimated tokens using Pi's exported `estimateTokens`. Priority
order (high → low):

1. Unresolved blockers and errors
2. User decisions and corrections
3. Active objective and open actions
4. Verified facts (file paths, command outcomes, archive references)

Completed and noisy events are dropped. Archive references are always
preserved (they are opaque IDs, not raw bytes). No tool-routing
directive is ever emitted. The snapshot is persisted in SQLite and
published as a custom entry, then marked ready with the compaction
entry id.

The `context` hook appends one hidden custom agent message to
`event.messages` and immediately marks the snapshot consumed. Reload,
fork, and tree navigation must not re-inject a consumed snapshot.
Capture failures are fail-open and visible in tool details; they
never block unrelated Pi operation. Command authorization and
analyzer isolation are fail-closed.

## Configuration

`settings.json → thinkInCode` (downward-clamped defaults shown):

```json
{
    "thinkInCode": {
        "languages": ["javascript", "typescript", "python"],
        "retentionHours": 24,
        "projectQuotaBytes": 536870912,
        "restoreTokenBudget": 1500,
        "searchSnippetChars": 240,
        "indexedSnippetChars": 1024,
        "maxResultBytes": 65536,
        "batchConcurrency": 2,
        "maxBatchCommands": 16,
        "network": false
    }
}
```

The `network` key is intentionally non-configurable and is always
`false`. Other values are clamped downward only — malformed or
out-of-range user values fall back to defaults rather than widening
the ceiling.

## Safety

- Command authorization and analyzer isolation are **fail-closed**.
- Capture/index failures are **fail-open and visible** in tool details.
- No fetch or network path exists; the analyzer cannot reach the
  network.
- The model cannot select a binary, environment variable, working
  directory, shell fragment, or filesystem path on the analyzer.
- Outer sentinel tests prove the worker cannot read the project cwd,
  cannot write a file, cannot reach localhost or Unix sockets, and
  cannot inherit secrets from environment variables.

## Migration from Context Mode

Tasks 1–8 established coexistence; Task 9 performed the cutover:

1. Added documented `thinkInCode` defaults to `agent/settings.json`
   and `agent/settings.example.json`.
2. Removed `npm:context-mode` from `agent/settings.json` and
   `agent/settings.example.json`.
3. Removed the `context-mode` MCP server block from `agent/mcp.json`.
4. Removed the active `@ctx-inspect`, `@ctx-exec`, and `@ctx` group
   definitions from `agent/tool-groups.json` after every role and
   agent consumer migrated to the matching `@think*` groups.

Context Mode databases, package directories, skills,
package-finalizer state, caches, and archives were not edited or
deleted. Rollback does not require data conversion.

## Rollback

To roll back the Task 9 cutover:

1. Restore the `ctx-inspect`, `ctx-exec`, and `ctx` group definitions
   in `agent/tool-groups.json` and revert `@think-inspect` references
   back to `@ctx-inspect` in the affected roles and agents.
2. Re-add the `context-mode` MCP server block to `agent/mcp.json`.
3. Re-add `"npm:context-mode"` to the `packages` list in
   `agent/settings.json` and `agent/settings.example.json`.
4. Reload Pi with `/reload`.

The Think-in-Code store and the Context Mode store are independent
directories, so no data conversion is required. If the current Zerobox release
regresses existing Bash behavior, the retained `fork.6` artifact described in
ADR-023 can restore Bash and analysis together to the previous Zerobox
generation. It does not restore ASRT. A byte-exact ASRT rollback requires either
a user-supplied pre-migration checkpoint or an explicit waiver; never keep a
mixed backend generation.

## File map

| File                   | Purpose                                   |
| ---------------------- | ----------------------------------------- |
| `index.ts`             | Extension registration and lifecycle      |
| `types.ts`             | Shared tool request/result types          |
| `coordinator.ts`       | Tool orchestration policy                 |
| `tools.ts`             | Schema validation and tool handlers       |
| `config.ts`            | Per-project config with downward clamps   |
| `storage/schema.ts`    | SQLite schema, versioned migration        |
| `storage/store.ts`     | ThinkStore: archive/index/search API      |
| `storage/retention.ts` | Retention policy                          |
| `memory/capture.ts`    | Session state capture                     |
| `memory/snapshot.ts`   | Deterministic 1500-token snapshot builder |
| `memory/hooks.ts`      | Hook registration and one-shot restore    |
