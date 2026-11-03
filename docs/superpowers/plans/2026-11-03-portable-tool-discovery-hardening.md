# Portable Tool Discovery Hardening Plan

> Execute locally with TDD. Keep real installation and sandbox qualification in GitHub Actions. Do not delegate implementation or launch additional review lanes.

**Goal:** Correct optional-resource handling and retained-command validation for all supported tools, and prevent CI host preparation from masking portability failures.

**Architecture:** Extend the existing discovery owner and qualification script. Retained bindings keep their authorized paths and revalidate requested commands through those paths. Fresh discovery and reuse share executable checks. Existing Ubuntu/WSL2 sandbox jobs remain; clean-container system/mise jobs run real tool metadata and negative contracts independently of runner-installed development tools.

**Constraints:** Preserve current development changes and personal state; work on `develop`. Keep required resources strict and optional search paths explicitly optional. Never silently rediscover a retained command outside its authorized installation. Use temporary fixtures, bounded probes and existing supply-chain controls. Do not install tools or run a real Pi installation on this workstation. No provider generation or publication.

## Tasks

- [x] Reproduce missing PHP extension search directories with an isolated interpreter fixture, then fix the PHP probe without weakening checks for loaded configuration or dependencies.
- [x] Add parameterized regressions across Node, Bun, Python, Go, PHP, Composer and pnpm for retained commands that lose execution permission, disappear, become unsafe or escape their authorized resource selection. Reuse the existing executable permission policy and watch actual command identities.
- [x] Exercise required-resource failures and successful retained bindings across all commands; verify explicit bindings and unchanged publication behavior through setup/CLI tests.
- [x] Extend real tool contracts in CI to include Python imports, Go execution, Node/Bun execution and package-manager startup, optional PHP search directories, all-command missing PATH cases, and retained permission failures.
- [x] Separate common host prerequisites from system-only packages. Reuse the qualification script in clean Ubuntu containers for system and mise discovery. Record actual executable origins and assert intended selection; document that the pinned dev-tools revision supplies PHP through APT.
- [x] Wire clean tool contracts into the public qualification gate and retain structured evidence on failure. Keep native Ubuntu and WSL2 sandbox execution checks.
- [x] Run focused deterministic tests, typechecks, boundary/storage guards and scoped lint; validate workflow syntax and executable shell control flow using disposable fakes. Document exactly which real CI checks have and have not run.

## Design boundaries

The existing shared host preparation installs distro PHP and Composer before its mise branch, and the pinned dev-tools revision itself links APT PHP into mise. A new PATH alone cannot establish filesystem isolation. Fresh Ubuntu containers give the static tool contracts a clean filesystem without introducing another production installer. Running the full native sandbox qualification inside Docker remains possible but is not required: the existing Ubuntu/WSL2 jobs already own kernel execution checks.
