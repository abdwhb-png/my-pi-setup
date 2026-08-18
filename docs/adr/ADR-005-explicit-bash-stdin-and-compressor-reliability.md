# ADR-005: Use Explicit Bash Stdin and Recoverable Compression

> **Superseded (2026-08-18)**: the per-group byte thresholds described in §3
> (`minBytesByGroup`, `minBytes`) are **removed**. Input thresholds are now
> expressed in estimated tokens via `minTokensByGroup` (defaults
> `shell: 1400 / read: 2700 / search: 1400`). Bytes survive only as the
> transport safety guard `maxFallbackBytes`. See `README.COMPRESSION.md` and
> `benchmarks/reports/token-calibration.md`.

## Status

Accepted

## Date

2026-07-19

## Context

Pi's local Bash backend closes stdin with `stdio: ["ignore", "pipe", "pipe"]`.
This is deterministic and protects the TUI, print mode, and RPC mode from a
child process consuming terminal input, but it prevents commands from receiving
caller-supplied input. A Sail command exposed the symptom, but hard-coding Sail
or Docker would leave the same failure for any command that reads stdin.

Tool-result compression had separate reliability gaps:

- one global `minBytes` threshold applied to every tool category;
- compressed replacements discarded original `details`;
- raw archiving was disabled by default and prepended metadata to output;
- Pi's durable `fullOutputPath` was not copied when visible output was already
  truncated;
- archive storage had no retention bound.

The solution must avoid inherited terminal stdin, Pi core patches, competing
`bash` registrations, and hidden loss of output or metadata.

## Decision

### 1. Accept stdin as explicit tool input

`bash` and `safe_bash` accept optional UTF-8 `stdin`. The value is written
exactly, without an implicit newline, then the stream is closed. Input is capped
at 1 MiB by UTF-8 byte length. When omitted, stdin remains closed.

`agent/extensions/_shared/bash-exec.ts` owns shared process behavior: shell
resolution, stream collection, timeout, abort, process-tree cleanup, and
post-exit pipe idle grace.

### 2. Keep existing tool owners

`agent/extensions/sandbox/index.ts` remains owner of `bash` and
`agent/extensions/safe-bash/index.ts` remains owner of `safe_bash`. Pi keeps the
first extension registration for a tool name, so `pi-overrides` must not add a
second `bash` registration.

Sandboxed `bash` uses the shared execution backend after command wrapping.
`user_bash` retains its existing input contract. Making `safe_bash` enter the
sandbox remains outside this decision.

### 3. Resolve compression thresholds by group

Compression uses configurable `minBytesByGroup` values:

- `shell`: 4,096 bytes for `bash` and `safe_bash`;
- `read`: 8,192 bytes for `read`;
- `search`: 4,096 bytes for `grep`, `find`, and `ls`.

Legacy `minBytes` remains accepted. Resolution order is explicit group value,
legacy global value, then group default. Global and project nested group values
merge per key.

### 4. Preserve and archive original results

Compression merges its metadata into original object details. Non-object custom
details remain available under `originalDetails`. Every transformed result is
archived by default; users may explicitly set `archiveOriginal: false`.

Archive files contain exact output bytes without a metadata header. When Pi
provides `details.fullOutputPath`, that complete file is copied instead of the
already-truncated display text. Compression or archive failure is fail-open: the
original tool result remains unchanged.

### 5. Bound archive storage

Archive cleanup runs once at session start. Managed files older than 30 days
are removed, then oldest managed files are removed until managed storage is at
most 1 GiB. Unknown files, directories, and symlinks are ignored. A sole newest
oversized archive is retained and reported as exceeding the soft cap.

## Alternatives Considered

### Detect Sail or Docker commands

Rejected. Command-name heuristics solve symptoms, miss other stdin consumers,
and become a permanent allowlist maintenance burden.

### Inherit terminal stdin globally

Rejected. Child commands could consume Pi TUI keystrokes, hang unattended
print/RPC sessions, and behave differently by launch mode.

### Add a separate `bash_exec` tool

Rejected. It duplicates the shell API and does not help `safeBash: replace`
sessions that intentionally expose only `safe_bash`.

### Fork or patch Pi core

Rejected. The feature can be implemented through public `BashOperations` and
extension tool definitions without maintaining a downstream core patch.

### Register `bash` from `pi-overrides`

Rejected. Duplicate tool ownership is load-order-sensitive and can bypass the
sandbox owner.

## Consequences

### Positive

- Any command can receive deterministic caller-provided stdin.
- Terminal input is never inherited.
- Small outputs remain verbatim according to tool category.
- Compressed output keeps original metadata and a recoverable raw source.
- Archive growth is bounded without touching unrelated files.

### Negative

- Explicit-stdin execution mirrors some private Pi process lifecycle behavior
  because Pi does not expose stdin through `BashOperations`.
- Raw archiving consumes disk and performs one cleanup scan per session.
- Legacy and grouped threshold settings coexist until legacy support is removed
  in a future explicit migration.
- `safe_bash` remains outside sandbox even when sandbox is enabled.

## Verification

- Shared Bash tests cover exact stdin, byte limits, closed default stdin,
  stdout/stderr order, process lifecycle, EPIPE, and idle-grace completion.
- Safe-bash and sandbox tests import real extension modules and execute their
  registered tool definitions.
- Compressor tests cover each group boundary, UTF-8 byte accounting, metadata
  merge, full-output archive source, cap and Edgee fail-open paths.
- Archive tests cover exact bytes, source copying, age/size pruning, symlink and
  unknown-file safety, and missing directories.
- Project gates remain `bun run typecheck`, `bun run lint:check`,
  `bun run fmt:check`, `bun run check:parse`, and `bun test` from `agent/`.
