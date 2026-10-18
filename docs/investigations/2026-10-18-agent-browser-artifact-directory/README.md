# Configurable Agent Browser artifact directory

The change is merged into the canonical checkout at `~/engineering/pi-integrations/pi-agent-browser-native` and its GitHub `main` at commit `0e93616c00afd8e773eaf4508f2fb9242bf862a0`, through [pull request 1](https://github.com/abdwhb-png/pi-agent-browser-native/pull/1). The merge has the same tree as the fully qualified candidate `c5ec4976ad2796163492fcebdc028cd2608100f6`. The daily Git-managed package was updated through `~/.pi/bin/pi` using `pi update git:github.com/abdwhb-png/pi-agent-browser-native` and resolves to that exact merge commit. Daily Pi core remains 1.1.0. Personal Pi settings are byte-identical to the pre-update backup. No npm publication or personal artifact-configuration migration was performed.

## Problem and contract

Agent Browser previously returned full redacted snapshot paths outside the project, under a host session directory or process-private temporary directory. A project-only Zerobox shell could not read those files, even though the browser tool had verified their existence on the host.

Automatic redacted snapshots and oversized result/observation spills now use `artifacts.directory` from the existing package configuration. Its default is `.pi/artifacts/agent-browser`, relative to the Pi project. The store adds the Pi session identifier and unique file names. Absolute paths and `~/` are supported. Global, project and override configuration retain the existing precedence and project inclusion rules.

The outer tool call captures the selected root once, including native preparation, batch/code work and final observation. Directory selection does not depend on the native browser's launch directory or a temporary operation-directory selection. Explicit exports, screenshots, downloads and recordings retain their destinations. Existing files and transcript references are not migrated or removed.

The current artifact owner continues to enforce file permissions, session-directory permissions, protected paths, byte budgets and retention. Existing configured-root permissions are preserved. Failed storage produces explicit unavailable/spill diagnostics rather than a silent fallback outside the sandbox. An invalid configuration returns a validation failure before the requested browser command is dispatched.

The setting does not grant filesystem permissions. The default works with an existing project-readable policy. A custom root must already be readable under the active sandbox policy.

## Configuration interface

```json
{
  "artifacts": {
    "directory": ".pi/artifacts/agent-browser"
  }
}
```

The existing package configuration CLI gains `artifacts directory set <directory>`, `artifacts directory clear`, and `artifacts directory status`, with the established global/project selectors. Status includes the configured/default value and resolved directory. Validation and path resolution are shared with the runtime.

## Executable evidence

- Configuration tests first failed because the new field was ignored, then passed for validation, precedence and path resolution.
- The CLI test first failed with `Unknown command: artifacts`, then passed for set, clear, status, project selection, preserved unrelated fields and invalid-input rejection.
- The snapshot test first failed on the old host-only path. It now verifies a configured directory, a configuration edit during the call, a later resumed call, preserved earlier bytes and an explicit export.
- The root-permissions regression first observed `0750` being changed to `0700`. The storage owner now preserves the configured root while retaining `0700` session directories and `0600` files. All 12 temp/storage tests passed after the correction.
- The configuration failure regression observed `upstream-error` before the boundary classified it as `validation-error`.
- The six neighboring suites passed 73 tests covering configuration, snapshots, observations, budgets and execution-directory anchoring. After the final default-path resolver cleanup, ten focused configuration and snapshot regressions passed. The final bundle builds, typechecks and passes strict lint on the changed code files.
- The real Pi/Agent Browser/Zerobox consumer test passes with the candidate and fails with the daily package. The candidate test initializes the private shell before creating the browser artifact, reads the exact returned path through `safe_bash`, compares its SHA-256 with host bytes, and verifies that an outside-project marker remains inaccessible. It uses a local HTTP page and an isolated browser socket directory. No LLM call or external website is involved.
- Extension ownership boundaries pass. The integration test is skipped in normal test runs and requires an explicit integration flag.

## Reproducing the consumer check

The consumer test lives at `~/.pi/agent/extensions/__tests__/integration/agent-browser-sandbox-artifacts.integration.test.ts`. Build the candidate first, then run the following from `~/.pi/agent`:

```bash
PI_AGENT_BROWSER_SANDBOX_CONTRACT=1 \
PI_AGENT_BROWSER_SANDBOX_SOURCE=/tmp/pi-agent-browser-artifact-fix/dist/extensions/agent-browser/index.js \
bun test --isolate extensions/__tests__/integration/agent-browser-sandbox-artifacts.integration.test.ts
```

The source variable identifies the actual compiled extension entrypoint. The test resolves it before loading Pi. To reproduce the original failure, point it at the daily package's compiled entrypoint instead. The test owns its configuration, HTTP fixture, project, host marker and socket directory, and removes those resources after shutdown.

## Verification record

The canonical package quality command was started with npm 12.0.1. Source-backed npm-exec tests run through an ephemeral Socket Firewall wrapper. No dependency manifest or lockfile was changed. The full run is recorded in `/tmp/piab-artifact-quality-final.log`; initial diagnostics are retained separately in `/tmp/piab-artifact-quality.log`. The full run completed with 1,548 passes, two failures, and 49 skips (1,599 tests). The failures are the unchanged concurrent session-lock test (one acquisition returned undefined within its 1,000 ms deadline) and the 250 ms cold-start guard (309.4, 362.0 and 446.7 ms). The session-lock case passed when rerun alone on both the candidate and the canonical checkout. Alternating measurements with the same SDK version also exceeded the startup budget on the canonical checkout. These observations do not establish the cause of either timing failure, and the full quality run remains failed. Neither assertions nor deadlines were weakened. The rebuilt final candidate passed focused verification. Its isolated startup rerun still failed the unchanged 250 ms threshold with samples of 263.1, 249.0 and 274.0 ms, recorded in `/tmp/piab-artifact-final-startup.log`. The same isolated guard also failed on the unchanged canonical checkout with samples of 283.7, 282.6 and 253.7 ms (`/tmp/piab-artifact-final-baseline-startup.log`). This comparison does not establish causality or prove the absence of a candidate performance regression. No performance fix is claimed.

The real consumer comparison is recorded in `/tmp/piab-artifact-baseline-sandbox.log` and `/tmp/piab-artifact-candidate-sandbox.log`. The final source-entrypoint consumer check is also recorded in `/tmp/piab-artifact-candidate-source-sandbox.log`. The rebuilt final compiled entrypoint also passed the real consumer test (one test, seven assertions), recorded in `/tmp/piab-artifact-final-compiled-sandbox.log`. The implementation worktree used an untracked `node_modules` symlink to the canonical checkout solely for verification. That worktree and the disposable SDK reproduction installations were removed after integration; the committed source is retained in the canonical repository. Runtime versions observed during qualification are Node 24.18.0, Bun 1.4.3, and native Agent Browser 0.38.2. Installation was subsequently authorized and completed as recorded below. Existing running sessions still require an extension reload or restart to load the new package.

## Delivery compatibility correction

The first [official Pi CI job](https://github.com/abdwhb-png/pi-agent-browser-native/actions/runs/39126712380/job/117673309757) selected official SDK 1.3.0 and completed 1,600 tests with 1,550 passes, one failure and 49 skips. The sole failure was the existing resumed-tool fixture. Official Pi 1.3.0 `AgentSession._restoreToolsFromTranscript` restores the complete active tool loadout from the normalized system transcript. The fixture recorded only an advanced-tool delta and omitted the initial loadout, so native restoration correctly selected that one tool.

The failure was reproduced with a disposable official 1.3.0 dependency graph before changing the fixture. Commit `55788c8` records the initial fixture loadout before the later delta. All 14 tool-surface tests then passed on both locked Pi 1.0.2 and official Pi 1.3.0. Assertions, production code and dependency manifests were not changed by this correction. Typecheck and strict lint of the changed test passed. The full CI was restarted on the corrected revision.

## CI acceptance after fixture correction

The corrected revision passes the full [official Pi compatibility job](https://github.com/abdwhb-png/pi-agent-browser-native/actions/runs/39128201380/job/117677736461): 1,551 passes, zero failures, 49 skips, official Pi 1.3.0. It also passes the [maintained fork compatibility job](https://github.com/abdwhb-png/pi-agent-browser-native/actions/runs/39128201380/job/117677736432): 1,555 passes, zero failures, 45 skips, fork Pi 1.3.0 at `9dd6a9064c9e2c631f39a1776dafd95af7e052af`. Native Linux lifecycle and the macOS package smoke pass on the corrected revision.

The first corrected-revision quality attempt stopped at the existing 1,200,000 ms child-process timeout inside `verify-quality-mutations.mjs`, during its clean acceptance baseline. The partial journal contains no failed assertion, but it does not prove completion or acceptance. The enclosing workflow has a separate 45-minute limit. One controlled rerun was requested on the same SHA without changing any assertion, timeout, CI file or production source. The controlled rerun also hit the same nested 20-minute timeout while clean tests were progressing. No failed assertion was present in the partial rerun journal, but neither attempt completed acceptance. The interrupted attempt is retained in `/tmp/piab-artifact-ci-quality-final.log`.

## Quality orchestration correction

Commit `c5ec497` removes the conflicting nested whole-gate timeout from `verify-quality-mutations.mjs`; the existing 45-minute CI job deadline remains. The script still requires the complete clean quality gate. For the allowance-origin negative control, it then invokes the same real origin-isolation test directly instead of rerunning the unrelated browser matrix. Other negative controls still run through the full acceptance command and stop at their intended stage. The expected failing command, diagnostic and evidence file remain mandatory. No assertion or startup/runtime performance threshold was modified.

The actual origin probe passes on the normal configuration and rejects the actual unsafe allowance in an isolated copy with the expected no-floating-promises assertion. All ten gate-wiring tests pass. Focused strict lint, formatting, scope, policy and whitespace checks pass. Full CI acceptance was restarted on the corrected revision. The two interrupted journals remain available as `/tmp/piab-artifact-ci-quality-final.log` and `/tmp/piab-artifact-ci-quality-retry.log`.

## Final delivery and installed-package acceptance

All routine checks pass on candidate `c5ec4976ad2796163492fcebdc028cd2608100f6`: [code quality](https://github.com/abdwhb-png/pi-agent-browser-native/actions/runs/39131600908), [official/fork compatibility and macOS package smoke](https://github.com/abdwhb-png/pi-agent-browser-native/actions/runs/39131601459), and [native Linux lifecycle](https://github.com/abdwhb-png/pi-agent-browser-native/actions/runs/39131601340). The optional workflow-dispatch native fleet qualification remains skipped as designed. The final quality job completes with 1,551 passes, zero failures and 49 skips, and successfully rejects all five intended mutations. Its accepted journal is `/tmp/piab-artifact-ci-quality-accepted.log`. Earlier incomplete or failed runs above remain historical evidence and were not relabeled.

After merge, the daily Pi CLI updated only `git:github.com/abdwhb-png/pi-agent-browser-native`. Pi's configured `npmCommand` routes dependency operations through Socket Firewall. The finalizer resolves the package root to `~/.pi/agent/git/github.com/abdwhb-png/pi-agent-browser-native`; its Git HEAD is the exact merge commit. Package metadata remains version 0.9.4; the Git commit identifies this fork update. There are no tracked modifications in the installed package. Bun regenerated its untracked lockfile through the authorized package-manager operation. The previous untracked lockfile and private Pi settings backup are retained under `/tmp/piab-pre-update-rm57z92t` with private file permissions.

The installed compiled entrypoint then passed the real consumer integration test using local SDK Pi 1.1.0 and `pi-test-harness` 0.10.0: one test, seven assertions, zero failures. It verifies the returned project's artifact bytes through a previously initialized Zerobox sandbox and confirms the outside-project marker remains inaccessible. Evidence is `/tmp/piab-artifact-installed-sandbox.log`. The promoted daily Pi runtime remains 1.1.0, and personal settings are byte-identical to the pre-update backup. Running interactive sessions were not restarted or controlled; reload extensions or restart Pi to activate the package there. Existing host-only artifact paths are not migrated.
