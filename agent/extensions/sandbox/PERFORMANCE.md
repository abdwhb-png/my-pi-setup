# Pi performance changes, 2026-10-10

The changes are confined to the local footer package and shell extensions. Daily Pi remains on the promoted 0.87.1 release. No pi-core source, release, host authorization or personal sandbox grant was changed.

## Implementation

- **A1:** The footer shares one context and usage snapshot across both placements. It uses Pi's authoritative context measurement and thinking getter. Session, leaf, model, thinking, persisted-message, tree and compaction changes invalidate the snapshot. The cache does not call `getEntries()` on every redraw, including on Pi versions without `getEntryCount()`.
- **A2:** An unchanged command reuses the policy prepared for that command, then resolves current authority immediately before spawn. A regression asserts two policy resolutions and refusal when asynchronous preparation changes authority. Host execution has the same final authorization check. Forced preparation preserves callback receivers.
- **A3:** One monotonic command deadline covers preparation, admission, spawn setup and execution. Equivalent replacement requests share startup. A cancelled waiter cannot cancel another waiter's startup. Supersession and shutdown invalidate candidates. Engine probes are asynchronous and cancellable. Startup and shutdown each have a 30-second ceiling. File verification still checks every declared hash. Cleanup remains owned and retryable, including leases or spawn specifications arriving after cancellation. Execution provenance preserves validated numeric phase timings.

## Footer benchmark

The benchmark used the real footer entrypoints and promoted Pi context calculation with an in-memory session containing 7,400 synthetic user messages. It rendered both placements 20 times after one initial pair. The baseline was footer commit `3821962`; the updated footer includes upstream v3.1.0 and commit `4a1b22a`. This measures redraw CPU work, not model response or shell execution latency.

| Measurement | Before | After |
| --- | ---: | ---: |
| First pair of renders | 166 ms | 30 ms |
| Next 40 renders | 1,310.96 ms | 32.15 ms |
| Context calculations in those 40 renders | 40 | 0 |

The warm redraw measurement improved by about 41 times in this fixture. One calculation remains necessary when the session revision changes. Actual gains depend on session size, content and redraw frequency.

## Runtime qualification

A fresh isolated Pi test session loaded the real Sandbox and Bash public entrypoints, the pinned managed Zerobox bundle and the existing Conda authorization. It ran the real `crypto-vault` Python, without a model API call or a host-mode fallback. Analysis preflight was substituted at its external process boundary, so this is not a live Analysis-worker qualification. Agent state, leases and configuration were confined to temporary directories. The real Python reported `Python 3.13.11` with admitted sandbox execution for an initial command, an unchanged command and a command after a configuration replacement. The daily Pi RPC CLI separately loaded the canonical footer package and registered `fancy-footer` and `fancy-footer-local` without extension errors.

In one successful run, unchanged configuration preparation took 37 ms, the full unchanged call took 4.4 seconds, and a replacement call took 19.4 seconds. Its recorded phases included 14.8 seconds of verification, 2.5 ms of shutdown and 4.0 seconds of process execution. These are observations from this machine, not performance guarantees. Full verification remains material work. A 10-second command budget correctly expired during replacement verification, before that command could dispatch. The original screenshot's multi-minute stall was not reproduced, and these changes do not establish its exact historical cause.

## Consolidation and preservation

The only footer checkout is `~/engineering/pi-integrations/pi-fancy-footer/`, on `codex/fancy-footer-upstream-v3`. Upstream v3.1.0 is pinned at `2c597ff9b95e7d263ef97596af459c13add89d3b`. Integration commits are `3c36f1f` and `4a1b22a`. The local callback API, `./api/metrics`, responsive placements and existing dependency pins remain. The upstream Durable adapter is a separate optional export and was not activated or dependency-upgraded.

The old linked worktree was consolidated through Git. Its five pre-existing edits were restored as uncommitted changes after the implementation commits. Historical refs, patches, exact original file hashes, checkout artifacts and dependencies are retained in `~/engineering/backups/pi-fancy-footer/20261010T190040Z/`. The complete bundle was independently restored and passed `git fsck`. Daily Pi declares the canonical local package and resolves its footer symlink there. No remote push or running-session restart was performed.

## Validation boundaries

The full footer suite passed 204 tests after restoring the existing user edits. Scoped execution tests cover authority changes during preparation, deadlines before spawn, cancelled waiters, equivalent and superseding replacements, shutdown, process facts, partial output, late cleanup failures, phase parsing and callback receivers. Test fixtures use temporary agent directories and restore global state. An existing runtime-distribution fixture now sets private directory and manifest permissions explicitly instead of depending on the shell umask.

Extension boundary checking passed. Focused lint passed with warnings, and focused typechecking passed. The repository-wide typecheck remains blocked by the unchanged installed `pi-mcp-adapter/unix-socket-transport.ts:33`, where `string | NonSharedBuffer` is passed to a Buffer-only parameter. The complete agent test suite was not run. The targeted execution and lifecycle suites cover the changed shared contracts. Raw benchmark scripts and validation outputs are retained with the consolidation backup for review.
