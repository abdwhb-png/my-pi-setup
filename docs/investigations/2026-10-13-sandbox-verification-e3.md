# E3 sandbox verification implementation and qualification

## Result

The runtime distribution verifier now checks up to eight entries concurrently. Shell and Analysis remain mandatory for admission and are verified in that order, so the total concurrency never exceeds eight. Five fresh-process qualifications passed both startup and replacement against the installed Zerobox distribution. All ten admissions finished below the agreed 20-second acceptance threshold. The production 30-second deadline is unchanged.

This change addresses the sequential distribution verification identified in [the E3 diagnosis](./2026-10-13-live-delegation-e2e/verified-causes.md). It does not establish why host filesystem latency varied in the original failing runs.

## Implementation

`agent/extensions/sandbox/runtime/runtime-bundle.ts` remains the sole implementation owner. Component entries are structurally validated and normalized before workers perform filesystem checks. Returned entries retain manifest order. All existing path, ownership, permission, digest, symlink and unlisted-file checks remain in place. No cache, dependency, user setting, manifest schema or public interface was added.

Workers stop taking new entries after an integrity failure and await all already active checks. When several entries fail, the earliest manifest entry determines the reported cause. Cancellation is checked between filesystem operations and propagated into reads. The resolver drains its pending operations, while the existing outer execution deadline still releases the caller promptly. Cancellation retains its original reason and cannot lead to a late Zerobox launch.

## Regression evidence

The first RED test held the first component read and demonstrated that the previous serial loop could not start the remaining readers. GREEN validates overlapping reads, the limit of eight, completion in a deliberately different order and stable manifest output. Two additional RED tests demonstrated that cancellation could still start a subsequent read and was not passed to active reads. Both pass after the cancellation changes.

Focused tests cover tampering, missing files, duplicate and unsafe entries, conflicting entry types, unlisted files, writable paths, redirected parents, escaping or absolute symlinks, changed link targets, valid internal links, cancellation before I/O and during verification, deterministic failure selection, and draining. Backend tests use the real resolver and verify zero engine calls both at interruption and after delayed reads settle.

The following six suites passed, totaling 67 tests:

```sh
cd ~/.pi/agent
bun test --isolate extensions/sandbox/runtime/runtime-bundle.test.ts extensions/sandbox/runtime/zerobox-deadline.test.ts extensions/sandbox/runtime/zerobox-backend.test.ts extensions/sandbox/runtime/service.test.ts extensions/sandbox/preparation.test.ts extensions/sandbox/runtime/distribution/distribution.test.ts
```

In the initial combined run, 63 tests passed and four distribution tests rejected the Codex sandbox's `/tmp`, which was owned by UID 65534. The unchanged distribution suite was rerun outside that sandbox and all ten tests passed. The trust validator was not weakened. The replacement cleanup test intentionally exercises a shutdown timeout and emits its expected extension diagnostic.

Focused TypeScript checking passed with a temporary config extending `agent/tsconfig.typecheck.json` and including the three changed TypeScript files. Focused Oxlint passed with warnings for `unknown` boundaries and awaited operations in bounded workers or directory traversal. `bun run lint:boundaries` passed with unrelated existing warnings. Formatting was applied through `fmt:files`; repository formatter configuration excludes test files. `git diff --check` passed. The full agent suite and repository-wide typecheck were not run.

## Installed runtime qualification

Each row is a separate Bun process loading the real Sandbox and Bash extension entrypoints through the installed Pi test harness. The model stream is scripted. The verifier, engine probes, shell preparation, replacement, and shell process are real. Analysis startup is not substituted, but Analysis readiness was not separately asserted. Agent configuration, project files, probe directories and leases belong to temporary directories. Stale lease recovery is scoped to those directories. No personal configuration is used as a mutable fixture.

The command after each admission is `safe_bash` running `printf E3_SHELL_OK`. All ten calls reported `status=sandboxed`, `backend=zerobox`, exit code zero and the expected marker. Replacement is triggered by changing an environment value in the temporary sandbox configuration, and the test verifies that the runtime fingerprint changes and distribution verification runs again. Every successful run completed explicit session shutdown.

| Run | Startup admission | Startup bundle verification | Replacement preparation | Replacement bundle verification |
| --- | ---: | ---: | ---: | ---: |
| 1 | 2.380 s | 1.827 s | 4.014 s | 2.640 s |
| 2 | 2.021 s | 1.417 s | 3.996 s | 2.586 s |
| 3 | 1.985 s | 1.507 s | 3.503 s | 2.286 s |
| 4 | 2.118 s | 1.623 s | 4.309 s | 2.949 s |
| 5 | 3.026 s | 2.387 s | 4.171 s | 2.968 s |

Startup admission is measured around the Sandbox session-start handler. Replacement preparation comes from the actual tool execution provenance and includes replacement admission and retirement work. These measurements exclude the rest of the daily CLI's ambient extension loading and model startup. They are observations on this machine, not universal performance guarantees or a controlled speedup ratio against the older diagnosis. Filesystem caches were not cleared.

The concrete engine was `~/.pi/runtimes/zerobox/2026.10.01.docker-trust.1/bin/zerobox`, with provenance version `0.3.3-fork.17`. The Pi runtime and test harness resolved under `~/.pi/agent/node_modules/`. Their resolved paths and the binary, manifest and helper digests are recorded in each raw result. No core release was promoted.

The first fixture used an overly long temporary lease path and was rejected by the existing Linux AF_UNIX socket budget check. Shortening the temporary root fixed the fixture without a production change. Zerobox also reported its existing warning about refusing helper aliases under `/tmp`; strict probing and the recorded shell executions still succeeded with sandboxed provenance.

No known E1/E2 qualification process was active before the live series, and no E3 probe process remained afterward. Four protected configuration files were byte-identical across the final four repeats. Comparison with the originating investigation's older 38-file snapshot found only `agent/settings.json` had changed; that older snapshot spans the separate E1/E2 work. This task did not write that file.

Raw evidence, the executable Bun test and summary are retained in `/tmp/pi-e3-qualification/`. The accepted samples are `run-1.json`, `run-2624023.json`, `run-2624334.json`, `run-2624633.json` and `run-2625127.json`. The focused typecheck configuration is `/tmp/pi-e3-typecheck.json`.

## Next action

Open a new ordinary Pi session to load the changed local extension and check shell availability with the normal personal configuration and ambient extensions. Existing sessions are not restarted by this change. The E3 implementation, regression tests and this report form a separate commit from E1/E2. No push or runtime promotion is included.
