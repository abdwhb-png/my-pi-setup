# Portable tool discovery qualification

The implementation and qualification logic at `9c078c478369eacc588782a586ae98badf5b90b7` passed [GitHub Actions run 41492942000](https://github.com/abdwhb-png/my-pi-setup/actions/runs/41492942000). Installation remains independent of dev-tools and mise: a logical development profile resolves existing host commands, their executable links and runtime resources, then publishes machine-local installation bindings through the existing sandbox authority. Missing or ambiguous resources fail before activation. Explicit bindings remain available, valid existing authority is retained, and `--rediscover` replaces bindings only when requested.

## Runtime evidence

Each platform/layout combination ran once in the final run. Both targets use Ubuntu 24.04 x86_64; WSL2 runs inside its Linux filesystem under an actual Microsoft WSL2 kernel. Destination homes contain spaces and Unicode and already contain host tools before Pi installation.

| Platform | Tool layout | Result | Evidence |
| --- | --- | --- | --- |
| Ubuntu | System/direct installations | Passed | [Case record](2026-11-02-portable-tool-discovery/ubuntu-system.json) |
| Ubuntu | Published dev-tools installation, with real mise shims first on PATH | Passed | [Case record](2026-11-02-portable-tool-discovery/ubuntu-mise.json) |
| WSL2 | System/direct installations | Passed | [Case record](2026-11-02-portable-tool-discovery/wsl2-system.json) |
| WSL2 | Published dev-tools installation, with real mise shims first on PATH | Passed | [Case record](2026-11-02-portable-tool-discovery/wsl2-mise.json) |

The mise fixture uses dev-tools commit `8d4972dacefca9c95bfd6d374d9e51c35fbafb7b` from release `v0.3.0`. No dev-tools repository change was made. Restoring the shim directory after Bun activation ensures discovery actually exercises the optional mise resolution path. The installed sandbox uses the resolved tool installations without requiring mise inside it.

Each case passed 158 operator/launcher regression tests with 646 assertions, the portable operator/qualification type check, clean installation, daily launcher verification, actual host-tool execution, the installed Pi `bash`/`safe_bash` contract, optional global-memory transfer, update, idempotency, rollback and refusal of modified managed files. These are repeated executions of the same suite across four environments. Node, Bun, Python and PHP executable paths match the discovered host executables; Python imports `ssl` and `json`, Composer and pnpm report the discovered versions, and Go compiles and runs a program using `fmt` with networking and CGO disabled. An attempted write to the host Node executable is refused in every case.

| Tool | System/direct fixture | mise fixture |
| --- | --- | --- |
| Node | 24.18.0 | 26.13.0 |
| Bun | 1.3.14 | 1.4.4 |
| Python | 3.12.3 | 3.15.2 |
| Go | 1.22.2 | 1.27.3 |
| PHP | 8.3.6 | 8.5.12 |
| Composer | 2.7.1 | 2.11.1 |
| pnpm | 10.34.8 | 12.16.1 |

Stored evidence normalizes disposable paths with `~`, `${QUALIFICATION_ROOT}` and `${RUNNER_HOME}`. Raw paths and command logs remain in the Actions artifacts. The [run record](2026-11-02-portable-tool-discovery/run.json) identifies the exact jobs and source commit.

## Native artifact reuse and refusals

The native builder job in [run 41477468233](https://github.com/abdwhb-png/my-pi-setup/actions/runs/41477468233/job/125386715698) succeeded. Later host-tool qualification jobs in that source run failed; those failures do not qualify the old tool-discovery implementation. The final run explicitly reused only its qualified native artifact after verifying the producer job, unchanged native runtime source owners and dependency inputs, and the archive hash. The runtime release is `native-41477468233-1`, and the native archive SHA-256 is `e81f87f82b3988fcbc4e18c749ae8a77a649f59ea5871c301ddee3dfb301c3e2`.

A fresh native build in [run 41487165375](https://github.com/abdwhb-png/my-pi-setup/actions/runs/41487165375) failed when the locked Ubuntu snapshot returned HTTP 503. The snapshot and package pins were retained. Fresh reconstruction remains the workflow default; explicit verified reuse avoids that external download when the component inputs are unchanged. The final run's `native-runtime` job was deliberately skipped and its `native-reuse` job passed.

Two additional workflow runs established fail-closed behavior. [Run 41492948256](https://github.com/abdwhb-png/my-pi-setup/actions/runs/41492948256) refused a source whose native builder failed. [Run 41493914000](https://github.com/abdwhb-png/my-pi-setup/actions/runs/41493914000) refused a separate test branch that changed the native input lock. Both stopped before artifact download and skipped the platform installations. The test-only input change is absent from the implementation branch. These expected failures are separate from the successful final qualification.

The [failure and refusal record](2026-11-02-portable-tool-discovery/failures-and-refusals.json) preserves the earlier release-age refusal, spaced shebang fixtures, Unicode runtime resolution defect, PHP resource limit, missing PHP data, redundant grants that exceeded the helper argument limit, split Go SDK resources, and missing XDG selectors during isolated mise queries. Superseded partial runs are not counted as successful qualification.

## Local verification

The final focused suite passed 49 tests with 214 assertions across installation, provisioning, distribution, development configuration, tool discovery, doctor and CLI tests. The agent-wide type check and dedicated portability-script type check passed. Extension boundaries passed. Focused Oxlint completed without errors and retained warnings at JSON boundaries and existing assertion sites. No suppression was added, and agent dependency manifests and locks remain unchanged. Shell syntax and Git whitespace checks passed. Fixture tests also verify broad-root refusal, misleading shared-library symlinks, permission and link changes after preparation, XDG propagation, omission of unrelated environment variables, and resolution of versioned executable aliases.

All actual host-tool installation and sandbox execution checks ran in GitHub Actions. Local work used isolated fixture commands, static checks, archive handling and candidate preparation. Personal sandbox authority and the daily promoted runtime were not activated or changed for qualification.

## Prepared private candidate

The owner-only candidate directory is `~/.cache/pi/portable-candidates/portable-tool-discovery-9c078c4`. It contains `setup.tgz`, `release.json` and `inventory.json`, built from the qualified source commit. The archive is 147,247,721 bytes, inventories 6,217 files and pins 11 package sources. Its SHA-256 is `3e9e5d737a2ee1eeacda976e2f41976893a41262661448c932fc747b6a46de68`.

The candidate bundles the same CI-qualified native component, including binary SHA-256 `890d5dee15c4ac13a58e9b5fc8442913973202b619547e92ec1e5ff0ea31f19e`. Its logical development profile contains no producer-specific installation roots. Static inventory checks confirmed exclusion of authentication files, provider secret files, sessions and personal memory state. The standard packer redaction check also passed. The private archive and inventory were not committed or uploaded, and no release tag was created.

## Qualification boundaries

This run qualifies the portable installation mechanism with a synthetic profile and real toolchains on the stated platforms. The prepared personal profile has not undergone fresh complete profile/provider qualification. No provider calls were made for this change. Publication and VPS installation remain separate actions, and no VPS was contacted.

Corepack inspection requires its selected pnpm version to be cached already; discovery performs no automatic download. Nonstandard launchers and additional runtime dependencies may require explicit bindings. Other platforms, CGO, project dependency installation, browser/Docker configuration and TLS/service readiness require their own qualification. The [installation guide](../portable-setup.md) and [private qualification runbook](../portable-private-qualification.md) describe the relevant operator workflows.
