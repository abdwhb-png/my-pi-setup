# ADR-019: Think-in-Code native extension

## Status

Accepted — amended 2026-09-05; sandbox backend superseded by ADR-023

## Date

2026-08-31

## Amendment (2026-09-05)

This ADR remains accepted for Think-in-Code's functional architecture: native
tools, shared safe execution, fixed analysis workers, storage, redaction,
session capture, and one-shot restoration. [ADR-023](./ADR-023-zerobox-sandbox-backend.md)
supersedes every ASRT-specific backend decision in the original version.

The amendment also corrects the verification record. Focused automated tests
are green, but no durable artifact was found for the originally claimed
end-to-end smoke through a separately launched Pi CLI process. That smoke
remains an acceptance task rather than completed evidence.

## Ownership amendment (2026-09-05)

[ADR-024](./ADR-024-bash-execution-ownership-and-sandbox-runtime.md)
supersedes the shared Safe Bash service, separate analysis broker, and mixed
telemetry ownership described in this ADR's Architecture, Exact dependencies,
and Migration sections. Think-in-Code keeps its three public tools, store, workers,
redaction, capture, and restore behavior, but owns its command policy,
telemetry, and `/think-audit` lifecycle.

## Public interface amendment (2026-09-05)

Replace the original five-tool surface with three public tools. Route
`command`, `content`, `archives`, `file`, and `batch` through the required
`think_execute.action` discriminator. Keep `think_note` and `think_search`
separate so Pi's name-level active-tool policy can distinguish execution,
indexed writes, and indexed reads. Successful non-empty analyses auto-index
their derived output except for `action=file`; arbitrary file programs can copy
or transform `FILE_CONTENT`, so reviewed file conclusions require an explicit
`think_note`. Blocked, failed, and empty analyses do not index. The `context`
hook injects a hidden routing message derived from the currently active tools,
including the Pi Lens versus indexed-recall boundary.

## Context

Pi relied on the `context-mode` MCP server to reduce data entering the
model context: a CLI binary that ran commands, persisted raw output,
exposed an FTS5 index over redacted snippets, and re-analyzed stored
results on demand. Two problems surfaced.

1. **Process boundary is the wrong abstraction.** The Context Mode
   pipeline already relied on `safe_bash` for command authorization and
   redirection, then forked its own runtime to escape that gateway. The
   fork re-implemented parts of the safe-execution pipeline without
   inheriting the redirect/rewrite/regex-guard policy, the sandbox
   broker state, the audit telemetry, or the dangerous-mode authorizer.
   Concretely, Context Mode bypassed `safeBash.guardPolicy` and could
   run commands that `safe_bash` had just blocked. The dual pipeline also
   produced nested tool results (`safe_bash` + `ctx_execute`) for what
   was logically one operation, double-counting against the context
   budget.

2. **No analyzer isolation.** Context Mode analyzed model-supplied
   JavaScript and Python inside the host Pi process using standard
   `eval`/`Function` for JavaScript and the host Python interpreter for
   Python. No sandbox, no resource limits, no network disable, no
   filesystem restriction. A model that emitted an infinite loop could
   hang the host; a model that imported `os` could read the project or
   exfiltrate data through any open socket.

Pi 0.84.2 provides the primitives that resolve both problems: a shared
safe-execution broker (`Symbol.for("pi.safe-execution-core.v1")`), a separate
analysis broker, a typed tool registration surface, and a hook lifecycle that
supports `session_before_compact` / `session_compact` / `context` for one-shot
post-compaction restoration. Pi's sandbox extension now publishes both Bash
and analysis operations over the accepted Zerobox backend. The test harness can
verify Pi wiring but does not by itself prove discovery or compaction in a
separately launched Pi CLI process.

## Decision

Replace Context Mode with a native extension,
`agent/extensions/think-in-code`, that registers three native Pi tools
(`think_execute`, `think_note`, `think_search`) and persists project-local evidence in a
per-project SQLite FTS5 store + raw archive directory.

The decision is recorded as ADR-019 because the Task 9 implementation
plan referenced "ADR-018"; that slot was already taken by
ADR-018-pi-dangerous-mode-unattended-prompt-suppression.

### Architecture

Four deep boundaries, each owned by exactly one extension or shared
service.

1. **`agent/extensions/_shared/safe-execution/`** owns command
   authorization (regex guard, native-tool redirect, rewrite),
   telemetry (`origin: "think_execute" | "think_batch_execute" |
"safe_bash"`), and shared publication through
   `Symbol.for("pi.safe-execution-core.v1")`. Owner-token semantics
   prevent stale extension instances from publishing or releasing the
   service. Uninitialized, errored, and stale-owner states fail closed.
   `safe-bash` remains the policy and telemetry owner; the broker is a
   function-call surface, not a Pi tool, so a Think-in-Code invocation
   produces exactly one outer tool result.

2. **`agent/extensions/_shared/analysis/sandbox-analysis-broker.ts`**
   owns the provider-neutral publication contract for strict analysis
   operations. `agent/extensions/sandbox/analysis/` executes those operations
   under a fresh Zerobox `analysis-strict` lease outside the QuickJS/Eryx WASM
   runtimes. Fixed worker IDs (`quickjs` or `python`), downward-clamped limits,
   length-prefixed JSON over stdio, process-group cleanup, and the concurrency
   semaphore prevent the model from selecting a binary, environment variable,
   working directory, shell fragment, or filesystem path.

3. **`agent/extensions/sandbox/analysis/`** owns the per-language
   workers. `quickjs-worker.ts` runs JavaScript and TypeScript inside
   QuickJS WASM, blocking `process`, `Bun`, `Deno`, dynamic host
   imports, filesystem, network, and child-process access by virtue of
   the WASM environment. `python-worker.mjs` runs Python inside Eryx
   WASM in a dedicated Node `--experimental-wasm-jspi` worker because
   Eryx documents JSPI but does not document Bun support.

4. **`agent/extensions/think-in-code/`** owns tool orchestration, the
   per-project SQLite FTS5 store, the on-disk archive directory,
   session capture, snapshot building, and one-shot restore. It does
   not duplicate policy, sandbox, or redaction logic; it composes the
   three shared services.

### Exact dependencies

- Zerobox `0.3.3-fork.8` — outer Linux isolation through the managed CLI at
  `~/.pi/bin/zerobox`, verified by immutable provenance and SHA-256 as defined
  by ADR-023. It is not an npm dependency and is never resolved from `PATH`.
- `@sebastianwessel/quickjs@3.1.0` — JavaScript/TypeScript analyzer,
  exact-pinned.
- `@bsull/eryx@0.6.0` — Python analyzer, exact-pinned. User explicitly
  accepted Bun installation without Socket Firewall coverage;
  compensating controls (process-group cleanup, no project mount, private
  target environment, sentinel tests) remain mandatory.
- `typescript@6.0.3` — programmatic API used by the QuickJS TypeScript path.
- `@typescript/native: "npm:typescript@7.0.2"` — native TypeScript 7 compiler
  in the sandbox package. The root `agent` manifest and compiler use the direct
  dependency `typescript@7.0.2`. The nested `pi-roles` installation retains its
  own transitive TypeScript `5.9.3`; it is not the root agent compiler.

`bun:sqlite` ships with Bun and is used directly for the per-project
store; no extra database dependency is added.

### Prerequisite

The extension assumes Linux with the managed Zerobox binary, compatible
Bubblewrap support, `prlimit`, and `/usr/bin/node` with
`--experimental-wasm-jspi` for the Python analyzer. The sandbox probe and
dependency contract execute the required smokes; a missing capability or
provenance mismatch publishes an unavailable broker state and fail-closes. Bun
does not currently document JSPI behavior, so Eryx runs under dedicated Node
workers.

### No-network policy

Analyzer network access is always disabled by the Zerobox
`analysis-strict` profile. Each request receives a private lease with its own
`HOME` and `TMPDIR`; target environment values are allowlisted and applied only
after host-side setup and confinement. The profile exposes neither project cwd
nor arbitrary host paths, loopback, public network, inbound binding, or
arbitrary Unix sockets. There is no `think_fetch_and_index`; existing web and
MCP tools retain fetching. The `thinkInCode.network` configuration key is
locked to `false` and is never honored otherwise.

### Storage and redaction

Per-project stores live under
`<homedir>/.pi/agent/think-in-code/projects/<sha256(realpath(cwd))>`,
with the canonical project path persisted alongside so the store can
detect an impossible hash/path mismatch on reopen. Directories use
mode `0700`, files use mode `0600`, archive names are opaque IDs,
writes use a temporary file plus atomic rename, and symlinks are
rejected at the store root.

Raw archives are stored **unredacted** so later isolated analysis is
lossless. Metadata, indexed text, snippets, and session snapshots are
redacted and bounded before persistence or LLM exposure
(`agent/extensions/_shared/redaction.ts`). Retention runs on session
start and after every archive write: 24-hour TTL on every row/file,
512 MiB per-project quota with oldest-first eviction, never follows
symlinks, never deletes outside the project store. Existing Context
Mode databases (`~/.pi/context-mode/`) are never opened, migrated,
moved, or deleted.

### Compaction protocol

`session_before_compact` builds a deterministic snapshot capped at
1,500 estimated tokens using Pi's exported `estimateTokens`. Priority
order (high → low): unresolved blockers and errors; user decisions and
corrections; active objective and open actions; verified facts (file
paths, command outcomes, archive references). Completed and noisy
events are dropped. The snapshot is persisted in SQLite and published
as a custom entry, then marked ready with the compaction entry id.
The `context` hook appends one hidden custom agent message to
`event.messages` and immediately marks the snapshot consumed.
Reload, fork, and tree navigation must not re-inject a consumed
snapshot. Capture failures are fail-open and never block unrelated Pi
operation; command authorization and analyzer isolation are
fail-closed.

### Migration and coexistence

The implementation established automated coexistence coverage before the
cutover: planning/research roles use `@think-inspect`,
execution-capable roles (`atlas-orchestrator`, `herdr-orchestrator`,
`debug`) use `@think`, the verifier allowlist in
`brainstorm-forcer/verification.ts` includes `think_search` but never
    any execute tool, and the `saveTokens` allowlist excludes all three
`think_*` names so post-compression does not erase the pre-reduced
result.

The completed cutover was intentionally narrow:

- Add documented `thinkInCode` defaults to `agent/settings.json` and
  `agent/settings.example.json` (fixed languages, downward-clamped
  limits, 24-hour retention, 512 MiB quota, 1,500-token restore budget).
- Remove `npm:context-mode` from `agent/settings.json` and
  `agent/settings.example.json`.
- Remove the `context-mode` MCP server block from `agent/mcp.json`.
- Remove the active `@ctx-inspect`, `@ctx-exec`, and `@ctx` group
  definitions from `agent/tool-groups.json` after every role and agent
  consumer migrated.

Context Mode databases, package directories, skills, package-finalizer
state, caches, and archives are not edited or deleted; rollback does
not require data conversion. The Think-in-Code store and the Context
Mode store are independent directories.

### Rollback

Rollback restores the three configuration changes in reverse order:

1. Restore the `ctx-inspect`, `ctx-exec`, and `ctx` group definitions in
   `agent/tool-groups.json` and revert `@think-inspect` references back
   to `@ctx-inspect` in the affected roles and agents.
2. Re-add the `context-mode` MCP server block to `agent/mcp.json`.
3. Re-add `"npm:context-mode"` to the `packages` list in
   `agent/settings.json` and `agent/settings.example.json`.

After restoring configuration, reload Pi with `/reload`. The Think-in-Code
store and the Context Mode store are independent, so no data conversion is
required. Do not restore ASRT as part of this rollback. Any sandbox rollback
follows ADR-023 and restores Bash and analysis together from one verified
Zerobox generation; a mixed backend state is unsupported.

## Alternatives Considered

### Fix the dual pipeline inside Context Mode

Rejected. The Context Mode CLI is an out-of-tree package whose fork
re-implements safe-bash semantics. Aligning it would require either
forking it into this repository or coordinating an upstream change.
Neither approach keeps the harness's source of truth in one place.

### Build a thin Pi wrapper around the existing Context Mode binary

Rejected. The wrapper would still rely on an unsandboxed host Python
for analysis and on `eval`/`Function` for JavaScript. The architectural
problems survive the wrapper.

### Disable Context Mode through a wrapper rather than removing the

package

Rejected. The MCP server starts eagerly; wrapping it would not stop
its pre-existing tool registration from leaking through
`mcp:ctx_*` references still in `tool-groups.json` until those are
also migrated. The narrow cutover removes the source of the leak.

### Expose every operation through one `think_*` tool

Rejected after the interface amendment. `think_execute` unifies the five
analysis source actions because they share one execution permission class.
`think_note` and `think_search` remain separate because writing durable notes,
reading indexed evidence, and running analyzers have distinct least-privilege
boundaries. One universal tool would prevent roles from expressing those
boundaries through Pi's name-level active-tool policy while saving little
schema context.

## Consequences

### Positive

- One outer `think_*` tool result per command. No nested `safe_bash`
  result.
- The analyzer cannot reach the network, the filesystem, the host
  environment, or the project cwd.
- The model cannot select a binary, an environment variable, a working
  directory, a shell fragment, or a filesystem path on the analyzer.
- Raw archives remain available for isolated analysis without
  re-running the source command.
- Capture failures never block unrelated Pi operation.
- The shared safe-execution broker removes the duplicate pipeline
  that previously diverged from `safe_bash` policy.
- Three native tools integrate with the existing tool-groups policy
  surface (`@think-inspect`, `@think-exec`, `@think`) without
  requiring a private MCP bridge.
- Focused automated gates prove the three tools, broker contracts, bounded
  results, storage, role policies, and deterministic scenarios. A separate
  real-Pi smoke remains required for final end-to-end acceptance.

### Negative

- Zerobox and the maintained fork remain young. Immutable provenance,
  adversarial integration tests, and fail-closed broker state limit update and
  API risk but do not eliminate it.
- Eryx depends on host JSPI behavior not documented for Bun. The
  dedicated Node worker plus an executable preflight prevents an
  unsupported Bun fallback but adds an operational requirement.
- Outer sandbox profiles must expose required runtime libraries and private
  lease paths without exposing project/home data. Sentinel tests, target-env
  isolation, no cwd mount, and inner WASM isolation are mandatory evidence but
  not a guarantee.
- Raw archives can contain secrets. Mode `0600`, opaque IDs, project
  isolation, 24-hour TTL, 512 MiB quota, and no direct raw-search
  return reduce exposure; they do not make raw archives non-sensitive.
- Session capture cannot prove arbitrary assistant prose. Provenance
  labels and priority rules keep unverified assistant summaries
  distinct from tool-backed facts.
- Removing Context Mode changes role tool resolution beyond two
  configuration files. The migration tests, the dedicated
  `task7-group-resolution.test.ts`, and the real Pi role checks are
  mandatory cutover gates.

## Verification

Verified on 2026-09-05:

1. The focused Think suite passed 212 tests with 1,234 assertions across 23
   files. It covers the three-tool registration, portable `StringEnum` schemas,
   strict action validation, auto-indexing, adaptive routing, snapshot
   coexistence, file boundaries, storage, telemetry, and role groups.
2. The real-Pi smoke passed through a separately launched offline Pi process
   and wrote evidence to `/tmp/think-in-code-real-pi-evidence`.
3. The serialized three-tool schema is 2,392 characters, below the 2,600
   regression ceiling and the previous five-tool surface. The strict
   inspect-only schema is 504 characters.
4. Focused TypeScript validation reports no errors in the changed Think,
   Brainstorm, Save Tokens, role, or tool-group files. The project-wide
   typecheck still reports 20 errors outside this change.
5. The focused production lint has no errors. Existing warnings remain. The
   project-wide lint is not a green gate because the repository already contains
   warnings outside this change.
6. The project-wide test run reached 4,075 passing tests, 43 failures, and 2
   errors across 292 files. The two Think 64 MiB boundary failures from that
   concurrent run pass when rerun in isolation; the remaining global failures
   are not accepted as evidence for this interface amendment.

No `bun run check`, `bun run check:parse`, or build command runs
without separate user approval (D14).
