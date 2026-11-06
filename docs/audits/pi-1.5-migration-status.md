# Pi 1.5 migration status

The daily runtime is now Pi 1.5.0, release `1.5.0-7722134adab8-db35f9bcb15f`, with the published npm harness `@abdwhb-png/pi-test-harness@0.11.0`. The previous Pi 1.1.0 release is retained. Optional Pi packages were not updated. The core runtime remains locally promoted; harness publication and remote CI are recorded in the follow-up below.

## Source revisions

- Core: `~/engineering/pi-core`, branch `pi-core-v1.5.0`, commit `7722134adab83cbf5d491db7142f10644d23a011`, integrating upstream `v1.5.0` while retaining the fork contracts.
- Harness: `~/engineering/pi-integrations/pi-test-harness`, released on `main` at `7983deb33d5be8bc06765334915fdc20262c30fb`, tag `v0.11.0`, with Pi 1.5 peers. The initial local qualification used commit `72d03a60cb36c2a00d802d4759a9b6d7ba083fe3`.
- Setup: prompt access is narrowed for non-user events; schema builders import TypeBox directly; fixtures use the Pi 1.5 event, render and execution-result contracts. Typecheck and type-aware lint share the extension compatibility view through the base tsconfig.
- The active Pi 1.1 source maps matched 662 source entries in the original fork checkout before integration.

## Verified evidence

- Core dependency installation through Socket Firewall: no audit vulnerabilities.
- Core offline build, the complete npm run check, and the final root TypeScript check passed, including the startup cleanup correction and its core-owned regression.
- Focused configuration: 51 tests passed. Extension runner, extension subpath imports, and interactive layout: 90 passed. Four selected TUI test files passed.
- Setup file resolver and role tests: 101 passed against the existing runtime. The complete profile qualification is recorded below.
- Harness: 60 unit tests passed. Its integration suite failed on upstream Pi 1.5 when a startup callback threw during close: the session remained busy. Moving the callback under the existing startup cleanup boundary in the candidate fork made all 96 integration tests pass. Four Bun extension-loading tests passed.
- Harness tarball was built locally at `/tmp/pi-test-harness-v1.5/dist/package.tgz`. Lint and all four installed-consumer cases passed: root npm tarball and minimal tarball, each under Node and Bun. Runtime dependency audit reported zero vulnerabilities; the 13 development-tool advisories remain recorded without a broad dependency update.

## Codemode worker test correction (2026-11-06)

The two Bun process-lifetime failures were caused by the subprocess observer waiting for exit, although the documented Bun contract guarantees settlement without waiting for exit. A minimal worker without Pi or QuickJS reproduced the distinction: Node exited for JavaScript and WebAssembly workers, Bun exited for JavaScript but stayed alive for WebAssembly after terminate()/unref(). The worker runtime implementation was not changed.

The Bun tests now observe the fixture's settlement report before terminating the disposable child in finally. A --hold-open fixture option deliberately keeps the child alive, so this separation is deterministic even if Bun fixes worker termination. The original observer failed this scenario after 20 seconds; the corrected observer passes. The one-second settlement assertion remains unchanged. Node still checks both result and natural process exit. Existing actual-worker-exit and admission-release tests remain intact.

The complete `npm run check` passed after this correction. All 226 Codemode tests passed (6 files), with Bun 1.4.3 installed and no skipped cases. The CI test(other) job now installs Bun 1.4.3 through the SHA-pinned official setup action; this workflow change has not run remotely. This correction required no global Bun patch or production worker change. The documented Bun limitation persists.

Evidence: `/tmp/pi15-worker-minimal.mjs`, `/tmp/pi15-worker-contract-red.log`, `/tmp/pi15-worker-contract-green.log`, `/tmp/pi15-codemode-complete.log`, `/tmp/pi15-check-worker-fix.log`.

## Other qualification failures retained

The generated settings schema was regenerated through the owning generate:schemas command; both schema and startup-name files passed (16 tests). The startup-name case was previously killed by its unchanged 10-second child deadline under highly parallel execution; it completes in approximately two seconds in the bounded run. Both deep-chain files passed with one worker (55 tests), preserving their 20,000-task inputs and 60-second test deadlines. The pi-env daemon was built with locked Cargo dependencies through Socket Firewall; its suite passed 101 tests with one explicitly optional case skipped.

The isolated test launcher now forwards VITEST_MAX_WORKERS. A new public shell-boundary regression first failed because the limit was stripped, then passed while still proving credentials are excluded. The complete isolated command `VITEST_MAX_WORKERS=1 ./test.sh` finished with exit code 0 and no unexpected failures. It passed 58 script tests, 94 agent tests, 1,769 AI tests, 2,889 Chord tests, 226 Codemode tests, 2,910 coding-agent tests, both durable retention runs (1,909 each), 545 store tests, 37 Workers tests, 101 pi-env tests, and all remaining package suites. Existing optional skips and declared expected failures were retained.

Harness installed-consumer qualification caught stale bundled skill metadata (0.10.0 in a 0.11.0 artifact). The package-owned guide and API reference were reconciled with the new version/peer contract, preserving the assertion. All rebuilt artifact consumer checks passed under Node and Bun. A core-owned regression now verifies startup callback rejection restores idle state and permits the next prompt; it passed against the real suite harness.

## Setup and installed profile qualification

The initial isolated setup used the exact packed fork artifacts, the immutable local harness archive, all 51 extension entrypoints, and the existing package selections. It excludes authentication files and sessions. A read-only host filesystem and disabled network protected the real profile during lifecycle qualification. Both a user prompt and a custom message reached the simulated provider; startup, shutdown and resource discovery reported no errors. No paid provider was called.

The original full setup attempt recorded missing metadata/examples/package links in the scratch copy and one obsolete schema-error wording assertion. A subsequent complete run also exposed three remaining test-only TypeBox imports and two fixtures that assumed a real `~/projects` directory and a home outside `/tmp`; these were corrected without changing production policy. These failures were retained in `/tmp/pi15-setup-entire-suite.log`. The corrected assertion still requires both forbidden fields to produce errors without reaching the analysis backend. The fixture copy and package links were completed before the final full run. The home expansion test uses the existing home itself, and the tmp-denial test uses an explicit project path outside the denied root.

An initial daily activation was reverted when setup typecheck exposed outdated fixtures. Pi 1.1 and the original harness dependency files were restored through the guarded rollback. Subsequent qualification used the isolated Pi 1.5 installation. The owner rollback also passed in the isolated profile, including refusal when recorded dependency files changed.

The base tsconfig now owns the extension-facing Pi AI type resolution. Previously, typecheck saw the compatibility view while lint saw native Pi AI schema types, producing four errors in Herdr template expressions. The complete lint command passes after aligning these resolutions; existing warnings remain visible. Setup typecheck passes.

Final setup evidence: `/tmp/pi15-setup-final-suite.log`, `/tmp/pi15-setup-final-lint.log`, `/tmp/pi15-setup-final-types.log`, `/tmp/pi15-profile-qualification/final-candidate-turns.json`. Earlier focused RED/GREEN and profile/rollback receipts are retained under `~/.pi/agent/artifacts/pi-upgrade-1.5.0/evidence/`.

## Final local result

The complete setup suite passed 6,017 tests across 496 files, with 120 explicitly skipped tests, zero failures and zero unhandled errors. Complete lint, typecheck, formatting of changed files and whitespace checks passed. All 27 resolved top-level dependency versions match the isolated qualification; the live manifest retains existing semver ranges while the scratch manifest pins their resolved versions. Daily `pi-fork verify` and typecheck passed after activation.

The activation record, original dependency files and guarded rollback script are retained under `~/.pi/agent/artifacts/pi-upgrade-1.5.0/`. Run `python3 ~/.pi/agent/artifacts/pi-upgrade-1.5.0/rollback.py` to restore the recorded Pi 1.1 runtime and harness dependencies; it refuses changed dependency files or unexpected runtime links. New Pi launches use 1.5.0; existing sessions were not restarted.

## Qualification limits

The initial migration did not rerun remote CI, Node 22/24 or Windows; the harness follow-up below adds that coverage for the package. Real provider generation, Docker and browser workloads remain unverified. The Bun WebAssembly worker lifetime limitation remains documented. The setup and core fork were not externally published; harness publication is recorded below.

## npm harness release follow-up (2026-11-06)

Harness 0.11.0 was additionally qualified against the official Pi 1.5.0 packages before publication. Its existing native shutdown test reproduced the startup callback cleanup regression in official Pi. The harness now cancels at its existing request preparation boundary, before and after the prior asynchronous callback. It no longer throws from Pi's startup notification. All nine shutdown tests and the complete 156-test suite pass without the personal core fix; assertions and timeouts were preserved.

The development dependency audit is clean after updating Vitest to 5.0.3, resolving the affected Vite dependency and applying the documented Minimatch override. Both installed artifact formats pass under Node and Bun. The complete remote CI passed Linux/Windows Node 22/24 and Bun 1.4.3, including installed consumers: [PR qualification](https://github.com/abdwhb-png/pi-test-harness/actions/runs/42187313736), [main qualification](https://github.com/abdwhb-png/pi-test-harness/actions/runs/42188196301).

The [OIDC release workflow](https://github.com/abdwhb-png/pi-test-harness/actions/runs/42188197990) published npm 0.11.0 with provenance and created [v0.11.0](https://github.com/abdwhb-png/pi-test-harness/releases/tag/v0.11.0). Registry metadata appeared before the tarball; installation waited until the archive was accessible and its SHA-512 matched the registry. Bun initially retained the prior local artifact because it had the same package name/version. A forced Socket Firewall installation with the frozen lockfile replaced it. All 13 installed JavaScript modules now match the qualified build byte-for-byte, and the installed session source matches the released source.

The setup pins npm version `0.11.0` in its development dependencies; the local vendor archive and companion files were removed. This is a development dependency, not a configured Pi resource package. The recorded Pi 1.1 rollback preimages remain intact; the activation guard was refreshed for the final dependency files. Release and installation receipts are retained under `~/.pi/agent/artifacts/pi-test-harness-release-0.11.0/`.

Post-installation validation: all 318 harness-consuming setup tests passed across 67 files, with 35 explicit skips and zero failures. Typecheck and `pi-fork verify` passed against the registry installation. The full 6,017-test setup suite was not repeated because only the harness dependency changed; its consumers were rerun.
