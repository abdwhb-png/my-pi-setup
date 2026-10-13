# E3: Hermes adoption, deferred-loading inventory and F2 evaluation

Status update: the user subsequently selected only Auto Translate and authorized F2 adoption. Both are now implemented. See [the adoption report](2026-10-13-e3-f2-adoption.md). The unapplied-proposal descriptions and broader candidate recommendations below record the preceding evaluation, not the current implementation scope. Pi Session Recall is user-owned and explicitly deferred.

## Result and scope

H1 is adopted in personal configuration: Hermes now uses `lazyInitialization: true`. F1 remains a useful cancellation and ownership fix with a small measured timing difference. F2 has a tested, unapplied proposal using 1 MiB blocks for large files. Its strongest measured benefit is lower memory and shorter individual synchronous hash calls. It did not materially improve the complete startup/replacement qualification in the two live samples.

This work changes Hermes configuration and records an extension inventory and evaluation artifacts. It does not apply F2 to the active extension, modify other extensions, update third-party packages, change Zerobox, promote Pi core, commit, or push. Existing F1/F3 and `/usage` changes and the concurrent E1/E2 work remain intact.

## H1 — Adopt the existing Hermes option

The installed source remains `npm:pi-hermes-memory@0.9.10`, resolved from `~/.pi/agent/npm/node_modules/pi-hermes-memory`. Only `lazyInitialization` was added to `~/.pi/agent/hermes-memory-config.json`, preserving the other content and file mode. The installed `loadConfig()` returned `lazyInitialization: true`, `memoryMode: "policy-only"`, and `quickCheckOnOpen: true`. The option takes effect when Hermes initializes in a new Pi session. No package or core release promotion is needed.

The [preceding qualification](2026-10-13-e3-followup-startup.md) measured Hermes's startup handler at 0.694–0.904 s with lazy initialization, but the first memory search still took 25.788–28.924 s. This adoption does not remove that work or disable the database integrity check. Those are historical timings, not a new controlled whole-Pi startup comparison. The previous report's configuration restoration describes the earlier experiment and is superseded by this adoption.

## U2 — Inventory of further deferred-loading candidates

The inventory follows the configured package roots and actual entrypoints. It is source analysis, including a completed Pi expert discovery report. Historical import timings are screening evidence only. They are not additive savings or measurements of the proposed changes. No new package version or compatibility recommendation is made.

| Candidate | Existing import/use boundary | Recommended scope | Evidence and validation needed |
| --- | --- | --- | --- |
| U2a: `auto-translate` | `agent/extensions/auto-translate/index.ts:13–21` imports the AI compatibility layer and translator before the enabled/nonempty guards at `65–94` | First local candidate. Import translation code only after the request passes those guards. Keep command registration, configuration, widget and pass-through handling immediate. | Historical import around 0.747 s. Verify disabled/empty input loads no translator, first translation works, and errors retain current behavior. |
| U2b: SDD review UI | `agent/extensions/sdd-orchestrator/index.ts:7–9,51–52` eagerly imports/injects UI used by operations in `extension-tools.ts:909–913,1662–1677,1699–1777` | Defer each review UI at its operation boundary. Preserve workflow registration, reconciliation, gates and shutdown. | No isolated timing. Verify prepare, review and live review, including first-use cancellation. |
| U2c: `pi-session-recall` | Configured Git fork `agent/git/github.com/abdwhb-png/pi-session-recall/dist/pi-extension.js:1–23` eagerly imports/constructs the recall service. Its five tools use it at `33–175`. | Defer the service until a tool needs it, and completion dependencies until a query needs completion. Change fork source and regenerate its distribution. | No isolated timing. Verify all five tool registrations remain immediate and concurrent first calls initialize correctly. |
| U2d: `pi-web-access` | Installed package entrypoint imports provider adapters at source `index.ts:38–77`, while search execution starts in tool/command paths at `1405+` and `2266+` | High-interest third-party candidate. In a maintained fork or upstream change, load the selected adapter at execution while preserving routing, schemas and network policy. | Installed version 0.38.0, historical import around 2.562 s, bundle about 1.06 MB. Verify fallback providers and first-use errors. Do not patch managed installed files. |
| U2e: `pi-agent-browser-native` | Configured Git fork `dist/extensions/agent-browser/index.js:43525–43530` constructs the runtime and registers lifecycle/tools. Bundle about 1.77 MB. | Profile first. A possible split defers execution machinery while retaining grants, enforcement and registration. | No isolated timing. Higher coupling and security risk than U2a–U2d. Hidden tools alone do not make their runtime safe to defer. |
| U2f: Save Tokens analytics | `agent/extensions/save-tokens/telemetry/commands.ts:21–29` imports analytics used by stats/export at `496–501,580–585` | Measure before changing. Keep observers immediate, consider deferring archive scanning dependencies. | Appears lightweight. No demonstrated material startup cost. |

PiLens already defers TDI/map/performance reports in `~/engineering/shared-services/pi-lens/dist/index.js:143616–143654,143805–143810`. Its historical 3.126–4.101 s `session_start` time concerns another lifecycle path and needs separate profiling. `rpiv-todo` already defers its overlay at its Git fork's `index.ts:67–78`. Permission enforcement should remain in its current startup order.

Recommendation: start with U2a, then U2b, with an isolated loader comparison and real first-use test for each. U2c and U2d belong in their owning forks. Keep registration and lifecycle enforcement immediate, defer only dependencies that an explicit operation needs, and verify repeated/concurrent calls through the installed Pi/Jiti loader. A generic lazy-loader framework, blanket parallel extension loading and disabling extensions are not required.

## C1 — Comparison protocol and load limits

Two comparisons used the same installed Zerobox bundle, `~/.pi/runtimes/zerobox/2026.10.01.docker-trust.1`, with 211 Shell and 4,014 Analysis entries. A fresh Bun process ran each sample with CPU affinity `6,7`, the real backend `probe()`, complete integrity verification and actual engine capability probes. No file, engine, deadline or expected digest was mocked. No other test/benchmark from this task ran concurrently with these samples.

Each comparison ran `A B B A A B B A`. The first pair warmed filesystem/transformation caches and was retained but excluded from medians, leaving three measured samples per version. Each sample recorded host CPU busy time and Linux CPU pressure over its lifetime. This is a matched workload and execution protocol, not an exclusive or identically loaded host. No cold-cache or statistical-significance claim is made.

The variants were the committed E3 verifier at `ae4011e`, the existing uncommitted F1/F3 follow-up, and an isolated F2 copy of that follow-up. Only the two runtime files were materialized per baseline. Other implementation dependencies were shared from the workspace. All sixteen probes succeeded with identical capability results and the same resolved-bundle signature, `3d09c58fc98b30612423f9f20b3fe8f3bf6d9ecf921b4e00f0a96b6ef0ceb47c`.

## F1 — Committed E3 versus current follow-up

| Metric, median of three measured samples | Committed E3 | F1/F3 follow-up |
| --- | ---: | ---: |
| Backend probe | 1,884 ms | 1,834 ms |
| Resolver within probe | 1,399 ms | 1,436 ms |
| Peak process RSS | 435.3 MiB | 427.7 MiB |
| Maximum timer delay | 315 ms | 279 ms |
| CPU pressure | 12.80% | 12.23% |
| Hash update count | 4,219 | 4,218 |

The overall median difference is 50 ms, approximately 2.7%. The resolver itself was slightly slower in these samples. The one removed hash and the existing single-read test support the elimination of redundant work, but three measurements do not establish a reliable overall speedup. F1 should be retained primarily for one integrity owner and cancellation propagation. F3 remains useful lifecycle regression coverage and adds no performance mechanism.

## F2 — Bounded-buffer proposal

The [unapplied patch](2026-10-13-e3-f2-evaluation/f2-chunked.patch) extends the existing resolver. It returns the already-validated file stat from `secure()`, keeps the current `readFile` path for files at most 1 MiB, and reads larger executable/helper/component files through a reusable 1 MiB buffer. Every byte still contributes to the existing SHA-256 digest. Manifest parsing, eight workers per resolver invocation, deterministic manifest-order failures and existing filesystem checks remain in place.

Each large file retains ownership of its descriptor until a pending read and close settle. Cancellation is checked before and after each read. The implementation does not abort an in-flight kernel read, introduce background hashing workers, cache integrity results, raise concurrency or relax the admission deadline. Small-file selection uses the observed size, so this is not an absolute memory bound for files that grow concurrently after validation. It does not solve pre-existing filesystem mutation races.

| Metric, median of three measured samples | Current whole-file hashing | F2, 1 MiB blocks |
| --- | ---: | ---: |
| Backend probe | 1,942 ms | 1,662 ms |
| Resolver within probe | 1,537 ms | 1,280 ms |
| Initial process RSS | 125.7 MiB | 127.0 MiB |
| Peak process RSS | 415.8 MiB | 144.1 MiB |
| Longest individual synchronous hash update | 193.2 ms | 7.7 ms |
| Total hash-update time | 589 ms | 562 ms |
| Maximum timer delay | 321 ms | 170 ms |
| Per-sample timer-delay p99 | 44.6 ms | 54.8 ms |
| CPU pressure | 13.36% | 11.76% |
| Host CPU busy | 45.53% | 39.97% |

F2 consistently used less memory: peak RSS ranged 386–449 MiB before and 141–147 MiB after. The median reduction was about 65%. The smaller synchronous update reduced the largest indivisible hashing interval. Total hashing work remained similar, as expected from processing the same bytes. Timer p99 did not improve consistently, and scheduling, other synchronous work and GC still contribute to pauses.

The backend-probe median improved by about 14%, but the F2 samples also had somewhat lower ambient load. Treat the latency result as directional. Memory and individual hash-call reductions are stronger evidence than a precise throughput percentage. A different block size, a streaming API or worker threads remain technically possible, but this experiment does not justify their added complexity or claim that 1 MiB is optimal.

## C2 — Real startup and replacement qualification

The unchanged real `safe_bash` qualification ran once with each resolver, sequentially, using the same CPU affinity and temporary agent configuration. The test exercised initial admission, an actual Zerobox marker command, configuration replacement, another marker command, provenance, and explicit shutdown. The installed Pi and test-harness package roots were verified. It did not load the user's complete extension set or measure TUI readiness.

| Live sample | Startup admission | Replacement preparation | CPU pressure over test process | Result |
| --- | ---: | ---: | ---: | --- |
| Current follow-up | 2.003 s | 5.182 s | 34.448% | Passed |
| F2 proposal | 1.913 s | 5.237 s | 34.378% | Passed |

Both variants satisfied the unchanged 20-second assertions. All four commands reported real sandboxed Zerobox execution and exit code zero, and both explicit shutdowns completed. Zerobox emitted its existing temporary-directory helper-alias warning in both variants. It did not prevent execution and was not suppressed. These two samples demonstrate functionality under comparable observed pressure, but no meaningful complete-scenario speedup for F2. They also do not invalidate the preceding follow-up's 22.148 s replacement failure under a different, heavily contended workload.

## Validation and reproducibility

V1: The first new public-resolver test failed before the prototype because a hash update received 3,145,747 bytes instead of at most 1,048,576. It passed after the change. Six prototype cases cover bounded updates/no whole-file read, the last partial block of engine/helper/component files, cancellation while a read and subsequent close are held, and an explicit I/O failure with descriptor closure. Existing integrity, ordering, cancellation, backend and deadline tests were loaded against the isolated implementation. All 48 tests passed. The six new cases passed again after formatting and naming/type-annotation cleanup.

V2: Focused TypeScript checking passed for the isolated implementation and its affected tests. The proposal patch passes `git apply --check` against the current follow-up. Formatting ran only on the two proposal files with repository formatting options. The standalone temporary-tree Oxlint invocation could not resolve Bun/Node types for the new test and reported two derivative error-type diagnostics, despite the separate TypeScript check passing. Its diagnostic log is retained. This is not a clean type-aware lint result. The resolver also retains intentional sequential-await warnings, including the new read loop. Do not parallelize blocks that share a buffer and file offset to satisfy that warning.

V3: Both live qualifications passed with 16 assertions each. The full repository suite, a full ordinary-CLI/TUI startup comparison and new first-use Hermes timing were not run. The extension inventory was not implemented or benchmarked. No project-wide check was necessary for a personal configuration change and an unapplied proposal.

Sanitized samples and source hashes are retained in [the evidence directory](2026-10-13-e3-f2-evaluation/): `f1-results.json`, `f2-results.json`, `live-results.json`, and `source-provenance.json`. Source hashes distinguish the committed, follow-up and final formatted proposal. Absolute home paths in retained sample metadata are normalized to `~/`. Configuration contents and private backups are excluded.

The diagnostic workspace remains `/tmp/pi-e3-f2-evaluation/`. It contains the three source snapshots, `measure.ts`, `compare.py`, `live.test.ts`, the failing/passing test logs and the focused-check logs. From `~/.pi/agent`, the comparisons were `python3 /tmp/pi-e3-f2-evaluation/compare.py committed followup f1` and `python3 /tmp/pi-e3-f2-evaluation/compare.py followup chunked f2`. The live runs used `PI_E3_VARIANT=followup` or `chunked`, `PI_E3_RUN=live-<variant>`, and `taskset -c 6,7 bun test --isolate /tmp/pi-e3-f2-evaluation/live.test.ts`. Do not rerun these comparisons concurrently with other validation and interpret the recorded host pressure before comparing durations.

## Recommended next actions

A1: Adopt the F2 patch in the local sandbox extension for its memory and cancellation granularity benefits, then run the repository-context focused lint/typecheck and existing preparation/supersession tests. Keep the eight-worker bound and admission deadline unchanged. The artifact is ready for review, but is not active in this evaluation.

A2: Implement and benchmark U2a, followed by U2b if its isolated import cost warrants it. Preserve immediate registration and test real first use. Profile U2c/U2d in their owning repositories before committing to maintained forks or upstream work.

A3: Profile Hermes's remaining first-use database initialization separately if that latency is unacceptable. Lazy initialization changes when the cost is paid. It does not establish which database maintenance operation should change.
