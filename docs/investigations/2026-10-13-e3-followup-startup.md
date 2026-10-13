# E3 follow-up: cancellation, deferred imports and startup qualification

## Scope and result

This follow-up to `ae4011e` implements F1 and the regression coverage/documentation requested by F3. It also defers the local `/usage` extension's report dependencies until invocation. F2 was measured without changing the hashing strategy. The installed Hermes package was qualified with its existing `lazyInitialization` option and its original configuration was restored afterward.

Subsequent authorized work adopted Hermes lazy initialization, compared the verifier versions under a matched protocol, and evaluated an unapplied F2 proposal. See [the adoption and F2 evaluation](2026-10-13-e3-f2-evaluation.md) for the current configuration state, measurements and next actions.

The later [F2 and Auto Translate adoption](2026-10-13-e3-f2-adoption.md) applies F2 and implements demand loading for Auto Translate, the only extension candidate selected by the user.

No Zerobox engine source, Pi core release, dependency or package-managed source was changed. No runtime was promoted. The concurrent E1/E2 investigation directory was left untouched.

## F1 — One executable integrity owner and cancellable entry resolution

`readPrivateRuntimeEntry` accepts the admission signal, checks cancellation between filesystem operations, supplies it to provenance/manifest reads and preserves the cancellation reason. The backend supplies that signal and checks cancellation around its initial executable check. The resolver remains responsible for the executable digest, helper digest and complete mandatory Shell/Analysis verification.

The backend's redundant executable read/hash and its `hashFile` injection option were removed. Repository callers of that option were tests. They now use the existing resolver/process boundaries and real distribution fixtures. A regression test verifies one executable read carrying the admission signal. Missing executables still fail with `backend-unavailable`. No controlled before/after timing benefit is claimed for F1 alone.

The entry-cancellation and single-read tests failed for the intended missing behavior before production changes and passed afterward. Existing tampering, deadline and backend failure coverage remains in the focused suite.

## F3 — Supersession while old reads remain pending

The preparation test now holds a read from an old admission open, supersedes that admission and allows the replacement to complete before releasing the old read. It asserts that the old signal was cancelled, that no engine command uses it, that the old resolver drains after release and that the replacement stays enabled. This characterizes the existing lifecycle instead of adding a scheduler.

The bound is eight file-verification workers per resolver invocation. Residual I/O from a cancelled invocation can overlap a new invocation. There is no process-wide eight-operation guarantee.

## U1 — Load usage reporting on demand

The extension entrypoint registers `/usage` without importing the scanner, aggregators, pricing or UI components. Invocation loads the dependencies required by the selected branch. The default inline view does not load the full report widget or pricing module. Dynamic imports use the existing Pi/Jiti loader and module caching.

The import regression test first failed on the eagerly loaded scanner, then passed after the change. A second test loads the actual extension through Pi and invokes `/usage`, `/usage --full` and the non-interactive report. It uses temporary session data and a fixture pricing catalog, renders the real components and replaces only external I/O/terminal interactions.

An isolated comparison used the promoted release's extension loader, a snapshot of the previous entrypoint from `HEAD`, and the changed entrypoint. Jiti's native fast path was disabled to match the test harness loader configuration. Each sample ran in a fresh process and verified command registration. Transpilation/filesystem caches were not reset.

| Sample order | Previous entrypoint | Deferred entrypoint |
| --- | ---: | ---: |
| Before, after | 3,306 ms | 216 ms |
| After, before | 2,633 ms | 141 ms |

These are isolated extension-loading measurements, not whole-Pi startup savings. Work is deferred to the first command invocation; the command tests establish behavior, not latency on the user's complete session history.

## H1 — Hermes qualification and configuration decision

The actual installed package was `npm:pi-hermes-memory@0.9.10`, resolved under `~/.pi/agent/npm/node_modules/pi-hermes-memory`. Four sequential daily CLI runs used normal extension discovery and `--mode json --print --no-session --tools safe_bash`, without a provider prompt. A temporary preload instrumented lifecycle handlers in the promoted release. After `session_start`, it invoked the registered `memory_search` implementation twice with a unique nonmatching query and the runtime-created tool context. It recorded success/count/timing, never memory content.

The comparison actually changed the existing configuration's `lazyInitialization` field for the two lazy samples. It retained policy-only mode and `quickCheckOnOpen: true`. Native `memory-init.*` timings, instead of `session-start.*`, confirmed lazy activation. This supersedes the earlier rejected preload-only override experiment.

| Sample | Hermes session start | First memory search | Second memory search | All session-start handlers complete, from preload |
| --- | ---: | ---: | ---: | ---: |
| Eager 1 | 50.958 s | 53.1 ms | 5.8 ms | 90.969 s |
| Lazy 1 | 0.694 s | 25.788 s | 3.4 ms | 100.135 s |
| Lazy 2 | 0.904 s | 28.924 s | 3.9 ms | 76.107 s |
| Eager 2 | 23.971 s | 10.0 ms | 1.9 ms | 67.020 s |

All eight searches succeeded with zero matches and all four processes exited successfully. The option removes eager database work from the Hermes startup handler, but shifts that work to first use. It does not eliminate the synchronous SQLite integrity scan. Pinned instructions and skill discovery remain eager according to the installed source; this experiment did not independently assert their contents or test cancellation during first use.

Host load was high and variable, with a sampled one-minute load average above 22 on eight logical CPUs. Some focused checks also overlapped the early comparison. Other extension handlers varied substantially. The whole-startup figures therefore do not establish a controlled end-to-end improvement and must not be compared directly with the earlier 48-second first-agent-turn measurement. This was print mode, not TUI readiness, and direct registered-tool invocation, not an LLM tool-call round trip.

The original Hermes configuration was restored byte-for-byte. All 40 protected configuration/source hashes matched the pre-comparison snapshot. Normal extension-owned caches/indexes were not included in that guarantee. Lazy initialization remains a viable opt-in when delaying the first memory operation is acceptable; it is not enabled permanently by this qualification. Reducing the actual database initialization/maintenance cost remains a separate Hermes investigation.

## F2 — Measured memory and event-loop cost

A temporary standalone probe imported the real resolver and verified the installed bundle, containing 211 Shell and 4,014 Analysis entries. It recorded Linux `/proc/self/status` high-water RSS, a 10 ms timer's delay and the elapsed time inside real SHA-256 `update` calls. There was no production instrumentation or alternate verifier.

| Sample | Verification | Initial RSS | Peak RSS | Increase | Total hash-update time | Maximum timer delay |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 2 | 2.976 s | 44.2 MiB | 350.2 MiB | 306.0 MiB | 880 ms | 459 ms |
| 3 | 2.241 s | 44.5 MiB | 388.6 MiB | 344.1 MiB | 741 ms | 397 ms |

The largest file was 123,664,064 bytes and its individual synchronous update took 242–266 ms. The probe includes instrumentation overhead and ambient scheduling/GC effects. It does not isolate every timer delay as hashing, measure digest finalization separately or represent an absolute whole-Pi memory footprint. An initial sample's `process.resourceUsage().maxRSS` was already high before verification and was excluded from the peak-RSS comparison; subsequent samples used Linux process-local high-water data.

F2 remains open with evidence: whole-file buffers and synchronous hashing have a measurable cost. The next bounded experiment is incremental hashing for large files with bounded buffers and cancellation, retaining complete integrity and manifest-order failure semantics. Compare memory, timer delay and admission duration before adopting it. Raising concurrency, weakening verification or increasing the startup deadline is not part of this change.

## Evidence and validation

Diagnostic scripts and sanitized measurement JSON remain under `/tmp/pi-e3-followup/`: `hermes-results.json`, `hermes-protected.json`, `usage-results.json`, and `verifier-2.json` / `verifier-3.json`. The earlier startup investigation is `/tmp/pi-e3-startup-profile/REPORT.md`. Temporary original configuration backups must not be committed or published.

Focused typechecking of changed production/test modules passed. Focused Oxlint passed with warnings in existing code. `bun run lint:boundaries`, required after extension import changes, passed its authoritative graph scan and lint gate with existing warnings. The repository formatter ran on changed production files; its configured test-file exclusions were preserved. Whole-repository tests, global typechecking and a TUI-ready measurement were not run.

The combined sandbox/usage run covered 84 tests: 82 passed, the supersession test exceeded Bun's default 5-second test budget, and the following shutdown scenario failed with an uninitialized shell policy. The preparation file then passed all five scenarios with `--timeout 15000`, retaining the same assertions and production deadlines. The latter failure is consistent with timed-out cleanup overlapping the next test, but that specific interleaving was not instrumented. Both the failed combined run and successful focused rerun are retained as `focused-tests.log` and `preparation-recheck.log`. An earlier four-file sandbox run passed all 47 tests at the default test budget. The cleanup scenario intentionally emits a `session_shutdown — timeout:30` error while asserting safe teardown.

The existing real-bundle qualification was rerun without changing its 20-second acceptance assertions. Startup admission succeeded in 19.090 s, including 16.682 s of distribution verification. The first marker command and the command after replacement both succeeded through real `safe_bash` with sandboxed Zerobox provenance and exit code zero. Replacement preparation took 22.148 s, including 18.494 s in the resolver, so the test **failed** its `< 20 seconds` assertion. This is a functional success and a performance-gate failure, not a green live qualification. The explicit post-success shutdown assertions were not reached; the test's `finally` cleanup ran. Evidence: `/tmp/pi-e3-followup/live.log` and `/tmp/pi-e3-qualification/run-followup.json`.

CPU pressure sampled after this run reported `some avg60=47.17` in `/proc/pressure/cpu`. This establishes substantial contention, but no matched baseline under that contention was measured, so it does not prove the entire latency increase was environmental. The earlier five successful E3 samples below 20 seconds remain historical evidence and do not override this failure.

## Next action

Keep F2 open. First compare the current and previous verifier under the same workload and record host pressure, then evaluate bounded-buffer incremental hashing for large files with the existing integrity, cancellation and deterministic failure tests. Requalify the unchanged 20-second startup/replacement target and the ordinary CLI separately. Hermes's remaining database/maintenance cost needs its own profile before an upstream patch or maintained fork is selected. No change to that package or its integrity checks is justified by the lazy-start comparison alone.
