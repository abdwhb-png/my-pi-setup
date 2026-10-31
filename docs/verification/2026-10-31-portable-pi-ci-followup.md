# Portability qualification follow-up

This follow-up removes the known HOME pathname limit and prepares private profile, publication and provider checks in GitHub Actions. It preserves the historical results in the [original CI report](2026-10-31-portable-pi-ci.md). No real provider request, personal-profile installation or native sandbox contract was run on the workstation during this follow-up.

## Implemented changes

- Default leases use `/tmp/pi-z-<uid in base36>` with owner validation, symlink refusal, mode `0700`, a trusted sticky parent and the existing 108-byte socket budget. Stale legacy `~/.pi/zbx` recovery preserves live owners. Explicit root overrides retain their existing behavior and socket-budget checks.
- Type-safe filesystem spies preserve cancellation assertions, and the browser artifact test narrows its unknown tool details before checking the output path. No assertions were removed to satisfy TypeScript.
- The public workflow rebuilds the native runtime from pinned sources through the existing native validation workflow. Downstream jobs consume the artifact from their own run, eliminating dependency on an old run's retention period. Ubuntu and WSL2 each run two independent repetitions with long Unicode HOME paths. The Analysis IPC contract also uses a long Unicode home.
- The native runner restores the pinned `pi-subagents` source and the existing frozen Markdown-link and cron dependencies before the global typecheck. Local package manifests and installed dependencies were not changed.
- The private manual workflow is installed in `abdwhb-png/my-pi-distribution`. Repository privacy and immutable-release configuration were verified. Its canonical source remains in this repository, with a [self-contained runbook](../portable-private-qualification.md). Actual profile input and provider credentials are deliberately supplied through private GitHub channels.

## Local deterministic checks

The two new private-temp regressions first failed for the intended behaviors: long HOME exceeded the socket budget, and a foreign-owned directory was accepted and chmodded. They passed after the production fix. The focused private-temp, runtime-bundle and preparation suites passed 38 tests with 205 assertions. The provider-budget regression first failed because a negative input price could be offset by an output price; the corrected provider guard suite passed five tests with 27 assertions using a fake provider boundary and no network request.

The global agent typecheck and the dedicated qualification-script typecheck passed. The authoritative extension-boundary graph check passed. Focused lint completed without errors; existing warnings and intentional sequential I/O/provider checks remain, so this is not a zero-warning lint claim. YAML parsing, shell syntax and Git whitespace checks passed. The browser artifact integration test was typechecked but not executed locally; real sandbox contracts remain CI-only.

## Runner evidence

| Run | Result and interpretation |
| --- | --- |
| [41179963201](https://github.com/abdwhb-png/my-pi-setup/actions/runs/41179963201) | Failed at global typecheck because the native runner had not restored `pi-subagents`, `satteri`, and `croner`. Their exact existing roots and lockfiles were added to runner preparation; the gate was retained. |
| [41180773220](https://github.com/abdwhb-png/my-pi-distribution/actions/runs/41180773220) | Private preflight exposed HTTP 403 from the immutable-release settings endpoint with `GITHUB_TOKEN`. Read-only candidate verification now uses release verification with the standard token. Publishing explicitly requires a repository-scoped secret with Contents write and Administration read. No install, publication or provider call ran. |

The corrected private preflight [41180883219](https://github.com/abdwhb-png/my-pi-distribution/actions/runs/41180883219) reached the expected `release not found` refusal with the standard Actions token. Installation, publication and provider steps were skipped, confirming that a missing candidate does not fall back to another input.

## Remaining qualification boundaries

Private profile qualification requires a privately supplied immutable candidate release. Publication additionally requires `PI_DISTRIBUTION_TOKEN`; provider qualification requires the selected credential secrets, case metadata, explicit dispatch and budget. These inputs have not been copied from the workstation. A workflow being installed is not a successful personal-profile/provider qualification.

Provider calls are bounded by selected cases, requested output tokens and timeouts. The budget guard uses configured prices and reported costs; it does not replace a provider-side financial cap. Private-profile qualification currently runs on Ubuntu, while the synthetic mechanism is exercised on Ubuntu and WSL2. Power-loss durability and offline installation remain outside the qualification contract. Earlier intermittent release-test timeouts remain unexplained; independent complete CI repetitions provide regression evidence, not proof of the original cause.
