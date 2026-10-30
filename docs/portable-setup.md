# Portable Pi setup

The setup operator installs an explicitly selected private release on Linux or WSL2 x86_64. It preserves the existing Pi runtime promotion mechanism and installs packages through the daily Pi CLI. No model call is needed for packaging, installation, integrity checks or memory transfer.

## Host prerequisites

Install Git, Python 3, a C/C++ build toolchain (`build-essential` on Ubuntu, required when native package prebuilds are unavailable), Bun, Node.js, GitHub CLI and Socket Firewall using their official installation instructions before running the bootstrap. The operator verifies executable availability; it does not install host tools, modify system services, change kernel settings, or authorize networking. Use the versions qualified with the release. The repository records its Bun package-manager version in `agent/package.json`; the native runtime workflow records its builder toolchain.

Authenticate GitHub CLI through `gh auth login`, using its normal secure flow. Set up Git access to any private package forks through your existing Git credential channel. Provider credentials are configured separately after installation; never put them in the profile or a release.

The required private repository is `abdwhb-png/my-pi-distribution`. Create it separately, initialize its default branch, and enable immutable releases before the first publication. The setup code remains in the public `abdwhb-png/my-pi-setup` repository. Releases are prepared as drafts, supplied with all assets, then published. Downloads require a private repository, an immutable release, matching GitHub asset attestations, and matching archive digests. The GitHub CLI must support `gh release verify` and `gh release verify-asset`.

## Prepare and publish a distribution

Run from the maintained source installation after reviewing and committing the intended setup code:

```sh
~/.pi/bin/pi-setup pack --output ~/pi-release-candidate
```

The output directory must not exist. Review `inventory.json` locally before publishing. `setup.tgz` contains the committed setup resources, a snapshot of the personal profile, the current packed Pi runtime and the validated Zerobox bundle. `release.json` records the archive checksum and source commit. Packaging rejects changed or untracked setup code, altered Pi tarballs, unsupported package sources, missing resources, and invalid runtime distributions.

The profile captures settings, model selection, eligible extension configuration, keybindings and Hermes configuration. Package sources are pinned to installed npm versions and Git commits. Resource selection filters remain intact. Shared skills from `~/.agents/skills` are captured under the installation-owned `agent/portable-skills` directory and declared in settings. This is a generated distribution copy: edit the original skill source and regenerate the release, rather than maintaining the copy independently. Symlinks and credential-like files in this external skill tree require explicit resolution before packaging. The snapshot does not change the destination machine's `~/.agents` directory.

Authentication, provider secret files, sessions, caches, memories, project trust, sandbox machine identity and other machine-specific authority are excluded. The configuration redactor is an additional rejection check, not proof that arbitrary prose or skill source cannot contain sensitive information. Review the explicit inventory and profile before the publication action. Keep the candidate directory private.

Publish only the reviewed candidate, using a new immutable tag:

```sh
~/.pi/bin/pi-setup publish --from ~/pi-release-candidate --tag setup-2026-10-31.1
```

Publication does not happen during packaging or tests. A publication failure may leave a draft release; inspect that draft in GitHub before retrying. Published tags and assets must not be replaced.

## Install on another machine

Clone the public source into a temporary bootstrap checkout, then invoke its launcher:

```sh
gh repo clone abdwhb-png/my-pi-setup ~/pi-bootstrap
bun ~/pi-bootstrap/bin/pi-setup install --release setup-2026-10-31.1 --dry-run
bun ~/pi-bootstrap/bin/pi-setup install --release setup-2026-10-31.1
```

The default target is `~/.pi`; `--root DIR` selects a different installation directory. An existing unmanaged installation is refused. In particular, this command does not adopt or overwrite the maintained source checkout. Dry runs can download verified assets into a temporary directory but do not change the target installation.

The installer verifies the complete archive before activation. At the final installation path, it imports the packed Pi release, installs the declared packages through the local daily launcher, runs the package finalizer, stages Zerobox, and generates sandbox authority with the existing development setup command. It never copies installed `node_modules` from the producer. Host package downloads still require Internet access and retain Socket Firewall protection. This is not an offline installer.

Add the target's `bin` directory to your shell's `PATH`, configure providers through the existing secure channels, and run:

```sh
~/.pi/bin/pi-setup check
```

`check` verifies managed files, the Pi package graph, resolved package versions and commits, Zerobox integrity, and local tool bindings. It reports remaining host configuration instead of silently widening permissions. It does not establish provider connectivity, provider quality, or native sandbox execution qualification.

For tools installed at different host prefixes, use the existing sandbox setup workflow:

```sh
bun ~/.pi/agent/scripts/configure-sandbox.ts preview
bun ~/.pi/agent/scripts/configure-sandbox.ts apply --bindings ~/pi-local-bindings.json
```

The bindings file uses the existing `environment.installations` format documented in the sandbox configuration guide. For initial installation, pass `--bindings ~/pi-local-bindings.json` to `install`. The operator retains these bindings locally for subsequent updates; they are excluded from distributions and rollback preserves their current values. Missing host installations abort provisioning and restore the previous setup. Install those tools separately or correct their bindings before retrying. Configuration of local proxies, provider services, Docker and browsers remains a host responsibility.

## Update, rollback and recovery

Stop Pi before changing its installation. Use a shell whose working directory is outside the target:

```sh
~/.pi/bin/pi-setup update --release setup-2026-11-01.1 --dry-run
~/.pi/bin/pi-setup update --release setup-2026-11-01.1
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

Related documents: [Pi architecture and runtime](ABOUT-PI.md), [sandbox configuration](../agent/extensions/sandbox/docs/configuration.md), [runtime distribution](../agent/extensions/sandbox/runtime/distribution/README.md), [implementation verification](verification/2026-10-31-portable-pi-setup.md), [GitHub immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases).
