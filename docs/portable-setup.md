# Portable Pi setup

The setup operator installs an explicitly selected private release on Linux or WSL2 x86_64. It preserves the existing Pi runtime promotion mechanism and installs packages through the daily Pi CLI. No model call is needed for packaging, installation, integrity checks or memory transfer.

## Host prerequisites

Install Git, Python 3, a C/C++ build toolchain (`build-essential` on Ubuntu, required when native package prebuilds are unavailable), Bun, Node.js, GitHub CLI and Socket Firewall using their official installation instructions before running the bootstrap. The operator verifies executable availability; it does not install host tools, modify system services, change kernel settings, or authorize networking. Use the versions qualified with the release. The repository records its Bun package-manager version in `agent/package.json`; the native runtime workflow records its builder toolchain.

Zerobox leases use a short per-user directory under `/tmp`, independent of `HOME` and `TMPDIR`. The root must be owned by the current Unix UID, must not be a symlink and is restricted to mode `0700`; `/tmp` must be root-owned and sticky when writable by other users. The worst-case socket pathname must still fit below 108 UTF-8 bytes. Stale legacy leases under `~/.pi/zbx` are recovered without removing leases belonging to live processes. Ubuntu and WSL2 qualification now exercise long home paths containing spaces and Unicode.

Authenticate GitHub CLI through `gh auth login`, using its normal secure flow. Set up Git access to any private package forks through your existing Git credential channel. Provider credentials are configured separately after installation; never put them in the profile or a release.

The required private repository is `abdwhb-png/my-pi-distribution`. Create it separately, initialize its default branch, and enable immutable releases before the first publication. The setup code remains in the public `abdwhb-png/my-pi-setup` repository. Releases are prepared as drafts, supplied with all assets, then published. Downloads require a private repository, an immutable release, matching GitHub asset attestations, and matching archive digests. The GitHub CLI must support `gh release verify` and `gh release verify-asset`.

## Prepare and publish a distribution

Use the repository's [Pi setup release skill](../.agents/skills/pi-setup-release/SKILL.md) for the complete promotion, preparation, qualification and publication procedure. `develop` is for development; published code must come from an approved commit on `main`.

`pi-setup pack --output DIR [--source-sha FULL_SHA]` reads committed code from the selected main revision while separately capturing the current personal profile and exact installed package versions. It selects the Pi and Zerobox artifacts pinned by that source, not whichever runtime is currently active. Development edits are excluded without changing the checkout. The output directory must not exist; review its private `inventory.json` before uploading anything.

`pi-setup publish --from DIR --tag TAG` creates one private draft and requests qualification. It does not immediately publish a release. The private Actions workflow qualifies that exact package and publishes the same files only when explicitly dispatched with `publish=true` and every required check passes. `publish=false` leaves it in draft. Published tags and assets must never be replaced.

The package contains source resources, the personal profile, pinned packages, shared skills, the packed Pi runtime and the validated Zerobox bundle. Authentication, sessions, caches, memory and machine-specific authority remain excluded. Review prose and skills for private content; automatic redaction is not a complete privacy audit. Optional global memory transfer remains separate.

## Install on another machine

Replace `RELEASE_TAG` with the exact qualified tag. Clone the public source into a temporary bootstrap checkout, then invoke its launcher:

```sh
gh repo clone abdwhb-png/my-pi-setup ~/pi-bootstrap -- --branch main
bun ~/pi-bootstrap/bin/pi-setup install --release RELEASE_TAG --dry-run
bun ~/pi-bootstrap/bin/pi-setup install --release RELEASE_TAG
```

The default target is `~/.pi`; `--root DIR` selects a different installation directory. An existing unmanaged installation is refused. In particular, this command does not adopt or overwrite the maintained source checkout. Dry runs can download verified assets into a temporary directory but do not change the target installation.

The installer verifies the complete archive before activation. At the final installation path, it imports the packed Pi release, installs the declared packages through the local daily launcher, runs the package finalizer, stages Zerobox, and generates sandbox authority with the existing development setup command. Bundled local extensions with dependencies must include their Bun lockfiles; provisioning verifies the exact locked direct package versions and restores them with `sfw bun install --frozen-lockfile --ignore-scripts`. It never copies installed `node_modules` from the producer. Host package downloads still require Internet access and retain Socket Firewall protection. This is not an offline installer.

To run `pi` directly from any directory, permanently add the installation's `bin` directory to your shell's `PATH`. The installer does not edit shell startup files. For the default `~/.pi` target, run the appropriate block once; if you used `--root DIR`, substitute that target's `bin` directory.

For Bash (the usual Ubuntu/WSL shell):

```bash
echo 'export PATH="$HOME/.pi/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

For Zsh:

```zsh
echo 'export PATH="$HOME/.pi/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

Verify command resolution:

```sh
command -v pi
```

The result must point to `.pi/bin/pi` under your home directory (or your custom target), rather than another Pi installation. The command will also be available in new interactive terminals. Configure providers through the existing secure channels, check the installation, then launch Pi:

```sh
pi-setup check
pi
```

`check` verifies managed files, the Pi package graph, resolved package versions and commits, Zerobox integrity, and local tool bindings. It reports remaining host configuration instead of silently widening permissions. It does not establish provider connectivity, provider quality, or native sandbox execution qualification.

For tools installed at different host prefixes, use the existing sandbox setup workflow:

```sh
bun ~/.pi/agent/scripts/configure-sandbox.ts preview
bun ~/.pi/agent/scripts/configure-sandbox.ts apply
```

The portable development profile declares logical tool requirements instead of paths from the producer's machine. New distributions discover Node, Bun, Python, Go, PHP/Composer and pnpm on the destination. Discovery follows executable links, gathers runtime resources and exact ELF library files, and optionally resolves mise shims when present. Neither mise nor dev-tools is required. Commands are inspected from a temporary directory outside projects, with bounded output/time and automatic version-manager downloads disabled. The four standard XDG directory selectors are retained for host configuration discovery; unrelated environment variables are omitted. This performs local metadata queries; it never installs a missing tool or trusts project configuration automatically.

`install --dry-run` reports the discovered commands and proposed read-only installations before creating a target or transaction. Missing tools, ambiguous launchers, unavailable libraries and overly broad automatic directory grants fail visibly. Installation revalidates the observed resources before and after provisioning; a change causes rollback. Global installation authority is machine-local and stays outside the distribution. Generated `agent/config/setup-bindings.json` is a local setup snapshot; the current sandbox authority takes precedence over that snapshot during updates. Explicit `--bindings FILE` takes precedence over both.

For an existing setup, inspect and explicitly replace discovered bindings with:

```sh
bun ~/.pi/agent/scripts/configure-sandbox.ts preview --rediscover
bun ~/.pi/agent/scripts/configure-sandbox.ts apply --rediscover
```

Ordinary checks and updates retain valid existing bindings. Stale bindings fail instead of silently following a relocated executable. `--rediscover` is not accepted by `check`. Reapplication with unchanged resources is a no-op, and publication preserves other authority settings and creates a backup.

Manual bindings remain available for supported tools in unusual layouts and for legacy distributions. The file uses the existing `environment.installations` format documented in the sandbox configuration guide. Pass it with `--bindings FILE` to installation or configuration. Corepack metadata inspection requires its selected pnpm version to be cached already; discovery does not fetch it. Unknown launchers or runtime dependencies require explicit installation bindings. Legacy packages that still contain fixed paths keep their previous behavior and need manual bindings on a different host. Automatic discovery requires a new distribution containing the logical profile and updated provisioner.

Missing host tools abort before activation. Install them separately; Pi does not install host prerequisites. Configuration of proxies, provider services, Docker and browsers remains a host responsibility. A supported host and successful static inspection do not establish native sandbox execution or full TLS/service readiness.

## Advanced: import only the fork runtime

This procedure is specific to this repository and manages only Pi core. For a complete installation on another machine, use the `pi-setup install` procedure above.

`~/.pi/bin/pi-fork import /path/to/packed` installs a previously built Pi release without the `pi-core` source checkout. The directory must contain `release-manifest.json` and its referenced tarballs. Transfer the `packed/` directory, not an installed `node_modules` tree. Import verifies the package hashes, copies only the declared archives into staging, installs dependencies through Socket Firewall, runs the runtime smoke checks, synchronizes the agent pins, and promotes the runtime only after coherence verification. Bun, Node and Socket Firewall must already be available. An existing release with the same identity is rejected, as with `deploy`.

## Update, rollback and recovery

Stop Pi before changing its installation. Use a shell whose working directory is outside the target:

```sh
~/.pi/bin/pi-setup update --release NEXT_RELEASE_TAG --dry-run
~/.pi/bin/pi-setup update --release NEXT_RELEASE_TAG
~/.pi/bin/pi-setup rollback --dry-run
~/.pi/bin/pi-setup rollback
```

The operator records installed file fingerprints and refuses modified managed files or collisions with local additions. It does not merge personal configuration automatically. Reconcile the reported differences with the maintained profile before retrying. Installing the already active release is a no-op after integrity checking. Running Pi processes and interrupted setup transactions block activation.

Updates use a sibling staging directory and preserve the previous complete installation. This favors recoverability over disk efficiency: allow enough disk space for the current installation, a staging copy, the previous installation and downloaded assets. User data is retained locally in these owner-only backups; backups are never included in a distribution. Older backups are not automatically pruned.

Activation writes a journal outside the target. The daily launcher and `pi-fork` refuse ordinary launches while that journal exists. The provisioning child is admitted only with the matching transaction identifier. An ordinary failure restores the original installation; after a process interruption, run the bootstrap launcher to recover:

```sh
bun ~/pi-bootstrap/bin/pi-setup recover
```

Recovery refuses a still-running transaction. Rollback restores the previous managed code, profile and runtimes, while keeping current authentication, memory, sessions, sandbox authority and other unmanaged state. It also refuses conflicting edits. Keep the bootstrap checkout until installation and updates have been checked.

## Optional global memory transfer

Memory is a separate local archive and is never uploaded by `publish`:

```sh
~/.pi/bin/pi-setup memory export --output ~/pi-global-memory.json
# Transfer the owner-only file through your private channel.
~/.pi/bin/pi-setup memory import --input ~/pi-global-memory.json
```

Stop Pi before either operation. The archive contains the canonical global `MEMORY.md`, `USER.md`, global failure entries and `STANDING.md`. Project entries are excluded using Hermes' own scope reconciliation. The archive contains no session database, messages, session indexes, recovery history or project memory directories. Historical paths in memory prose are preserved.

Export checks that every SQLite global memory is represented by the canonical Markdown data and refuses an incomplete export. Import requires an empty global memory destination and rebuilds a fresh searchable database with the actual Hermes implementation. Existing memory is never merged or replaced. Repeating an identical import is a no-op. An old `agent/memory` configuration follows Hermes' migrated `agent/pi-hermes-memory` destination; an unmigrated legacy directory requires Hermes migration before transfer. The transport adapter is qualified for the installed `pi-hermes-memory` version `0.9.10`; another version requires explicit adapter validation and fails visibly.

## Verification boundaries

The automated setup tests use temporary homes, real filesystem transactions, real archive handling, the installed Hermes modules and isolated SQLite databases. Dependency installation is substituted only in transaction tests; those tests do not establish network installation or sandbox execution on a second host. Release admission additionally requires actual installation on native Ubuntu 24.04 x86_64 and WSL2 x86_64, and the existing native Zerobox qualification. Record those results with the release before treating it as qualified for both platforms.

Related documents: [Personal Pi setup overview](ABOUT-MY-PI.md), [sandbox configuration](../agent/extensions/sandbox/docs/configuration.md), [runtime distribution](../agent/extensions/sandbox/runtime/distribution/README.md), [implementation verification](verification/2026-10-31-portable-pi-setup.md), [GitHub immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases).

The portable installation mechanism passed the [Ubuntu and WSL2 CI qualification](verification/2026-10-31-portable-pi-ci.md) at commit `2a03c42c164e2c76064bd0fe677a0f3d8c5e5dd7`, using a synthetic profile and the historical host constraints recorded in that report. The report preserves both successful evidence and failures that led to fixes; this result does not qualify the complete personal profile or publish a distribution.

Private profile, publication and provider qualification runs only in GitHub Actions; see [the private qualification runbook](portable-private-qualification.md).

The [follow-up qualification](verification/2026-10-31-portable-pi-ci-followup.md) records removal of the short-HOME constraint, repeated runner checks, and private workflow prerequisites.

The [portable tool discovery qualification](verification/2026-11-02-portable-tool-discovery.md) records successful installation and sandbox execution with system tools and real mise shims on both Ubuntu and WSL2. It also records the prepared private candidate and the separate personal-profile qualification boundary.

The [portable setup workflow](../.github/workflows/portable-setup-validation.yml) rebuilds and qualifies the native runtime by default. When native inputs are unchanged, its optional `native_runtime_run_id` input can reuse an unexpired artifact from an original portable setup run whose `native-runtime / native` job succeeded. The workflow verifies that producer, compares native runtime source owners and dependency inputs, checks the archive hash, and records its origin in `native-runtime-source.json` alongside each platform's evidence. The comparison conservatively covers the runtime/shared owners and dependency inputs listed in the workflow; changing one requires a fresh build under this policy. Current portable type checks, operator tests and installation contracts still run. A failed builder, changed native inputs or expired artifact prevents reuse; there is no automatic fallback or pin change. A run that only reused an artifact cannot serve as the original producer. Artifacts are retained for 14 days.
