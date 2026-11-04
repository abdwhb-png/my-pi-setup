# Portable Pi setup

The setup operator installs an explicitly selected private release on Linux or WSL2 x86_64. It preserves the existing Pi runtime promotion mechanism and installs packages through the daily Pi CLI. No model call is needed for packaging, installation, integrity checks or memory transfer.

## Host prerequisites

Install Git, Python 3, a C/C++ build toolchain (`build-essential` on Ubuntu, required when native package prebuilds are unavailable), Bun, Node.js, GitHub CLI and Socket Firewall using their official installation instructions before running the bootstrap. The operator verifies executable availability; it does not install host tools, modify system services, change kernel settings, or authorize networking. Use the versions qualified with the release. The repository records its Bun package-manager version in `agent/package.json`; the native runtime workflow records its builder toolchain.

Zerobox leases use a short per-user directory under `/tmp`, independent of `HOME` and `TMPDIR`. The root must be owned by the current Unix UID, must not be a symlink and is restricted to mode `0700`; `/tmp` must be root-owned and sticky when writable by other users. The worst-case socket pathname must still fit below 108 UTF-8 bytes. Stale legacy leases under `~/.pi/zbx` are recovered without removing leases belonging to live processes. Ubuntu and WSL2 qualification now exercise long home paths containing spaces and Unicode.

Authenticate GitHub CLI through `gh auth login`, using its normal secure flow. Set up Git access to any private package forks through your existing Git credential channel. Provider credentials are configured separately after installation; never put them in the profile or a release.

The required private repository is `abdwhb-png/my-pi-distribution`. Create it separately, initialize its default branch, and enable immutable releases before the first publication. The setup code remains in the public `abdwhb-png/my-pi-setup` repository. Releases are prepared as drafts, supplied with all assets, then published. Downloads require a private repository, an immutable release, matching GitHub asset attestations, and matching archive digests. The GitHub CLI must support `gh release verify` and `gh release verify-asset`.

## Prepare and publish a distribution

Use the repository's [Pi setup release skill](../.agents/skills/pi-setup-release/SKILL.md) for the complete promotion, preparation, qualification and publication procedure. `develop` is for development; published code must come from an approved commit on `main`.

`pi-setup pack --output DIR [--source-sha FULL_SHA] [--include-global-skills]` reads committed code from the selected main revision while separately capturing the current personal profile and exact installed package versions. It selects the Pi and Zerobox artifacts pinned by that source, not whichever runtime is currently active. Development edits are excluded without changing the checkout. The output directory must not exist; review its private `inventory.json` before uploading anything.

`pi-setup publish --from DIR --tag TAG` creates one private draft and requests qualification. It does not immediately publish a release. The private Actions workflow qualifies that exact package and publishes the same files only when explicitly dispatched with `publish=true` and every required check passes. `publish=false` leaves it in draft. Published tags and assets must never be replaced.

The package contains source resources, the personal profile, pinned packages, repository-owned skills, the packed Pi runtime and the validated Zerobox bundle. Authentication, sessions, caches, memory and machine-specific authority remain excluded. Review prose and skills for private content; automatic redaction is not a complete privacy audit. Optional global memory transfer remains separate.

Global skills under `~/.agents/skills` are excluded by default. Versioned resources under `agent/skills` and skills supplied by installed Pi packages retain their normal selection rules. Manage external skills separately with your existing `~/engineering/agent-tools` synchronization. Pi discovers the destination's `~/.agents/skills` through its normal resource loader; pi-setup does not copy or reconfigure that synchronization. To deliberately snapshot the producer's global skills, pass `pack --include-global-skills`. This copies them into `agent/portable-skills` and adds that resource path to the exported profile, retaining the existing credential and symbolic-link rejection checks. Review the resulting inventory before publication.

When an older managed installation is updated to a release without global skill copies, its managed `agent/portable-skills` files and generated profile reference are removed through the normal update transaction. Unmanaged additions are preserved; edited managed files still block the update. The source profile is never rewritten by packaging, and old immutable archives are never modified.

Release preparation includes storage cleanup before the next package and after verified publication, following the release skill. Downloaded archives and expanded delivery candidates are disposable once their remote or installed copy has been verified. Retain compact source/digest and qualification receipts; keep active/previous runtimes and migration backups separate from disposable build outputs. Local build caches and historical delivery directories are not included in the portable package.

## Install on another machine

Replace `RELEASE_TAG` with the exact qualified tag. Clone the public source into a temporary bootstrap checkout, then invoke its launcher:

```sh
gh repo clone abdwhb-png/my-pi-setup ~/pi-bootstrap -- --branch main
bun ~/pi-bootstrap/bin/pi-setup install --release RELEASE_TAG --dry-run
bun ~/pi-bootstrap/bin/pi-setup install --release RELEASE_TAG
```

The default target is `~/.pi`; `--root DIR` selects a different installation directory. An existing unmanaged installation is refused. In particular, this command does not adopt or overwrite the maintained source checkout. Dry runs can download verified assets into a temporary directory but do not change the target installation.

The installer verifies the complete archive before activation. At the final installation path, it imports the packed Pi release, installs the declared packages through the local daily launcher, runs the package finalizer, stages Zerobox, and generates sandbox authority with the existing development setup command. Bundled local extensions with dependencies must include their Bun lockfiles; provisioning verifies the exact locked direct package versions and restores them with `sfw bun install --frozen-lockfile --ignore-scripts`. It never copies installed `node_modules` from the producer. Host package downloads still require Internet access and retain Socket Firewall protection. This is not an offline installer.

Setup commands report their active stages and elapsed time on stderr, including periodic feedback during long subprocess waits. Package installation reports real package counts. Stdout contains the final result; `cleanup` retains its JSON report for scripts. No persistent setup log is created automatically. Every command supports contextual `--help`; usage errors return exit code 2, operational failures return 1, and successful no-ops return 0. `recover` with no pending operation is an explicit no-op.

The default install/update preview summarizes the destination, verified files, discovered tools and read-only access groups. Use `install --release RELEASE_TAG --dry-run --details` or the corresponding `update` command to inspect every proposed installation root and file. A preview can download verified assets temporarily but does not activate an installation. Completion prints commands using the actual installation root, including a custom `--root`.

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

## Configure provider and compression endpoints

The Pi distribution contains the CPA client and save-tokens adapters. It does not deploy CLIProxyAPI, Headroom or Edgee. Run those services separately or make them reachable through your private tunnel.

| Service | Default base URL | Configuration key | Environment override |
| --- | --- | --- | --- |
| CPA | `http://localhost:8317/v1` | `cpa.baseUrl` | `CLIPROXY_BASE_URL` |
| Headroom | `http://127.0.0.1:8787` | `compressor.backends.headroom.baseUrl` | `HEADROOM_COMPRESSOR_BASE_URL` |
| Edgee | `http://127.0.0.1:8320` | `compressor.backends.edgee.baseUrl` | `EDGEE_COMPRESSOR_BASE_URL` |

CPA settings belong in `~/.pi/agent/config/ai-providers.json`; compression settings belong in `~/.pi/agent/config/save-tokens.json`. Trusted projects can override them in the corresponding `<cwd>/.pi/config/` files. Precedence is exported environment, trusted project configuration, global configuration, then the defaults above. Empty environment overrides are ignored. Save-tokens uses only its selected backend; no automatic switch to another service occurs.

For example, if a tunnel exposes the services on these VPS-side ports, start Pi with the matching addresses:

```sh
export CLIPROXY_BASE_URL="http://127.0.0.1:18317/v1"
export HEADROOM_COMPRESSOR_BASE_URL="http://127.0.0.1:18787"
export EDGEE_COMPRESSOR_BASE_URL="http://127.0.0.1:18320"
pi
```

These commands configure clients; they do not open the tunnel. Set only the variables for the services you use, and persist them in your shell configuration or use the JSON settings for subsequent launches. Keep `/v1` in the CPA base URL; compression URLs are service roots. CPA accepts absolute HTTP(S) URLs without embedded credentials, query parameters or fragments. Configure its access key separately through `CLIPROXY_API_KEY` in the environment or `~/.pi/agent/.env`; credentials remain excluded from distributions.

After editing endpoint configuration files, run `/reload` or restart Pi. Changes to the exported launch environment require restarting Pi. CPA uses the resolved address for model requests, model discovery and catalog cache identity, so a different server cannot inherit another endpoint's cached dynamic models. See the [save-tokens compression guide](../agent/extensions/save-tokens/README.COMPRESSION.md) for backend selection and timeouts.

CPA publishes models only after a live catalog verification. The async extension factory loads cached models.dev metadata and awaits CPA verification before returning, so Pi can resolve an explicit `--provider cpa --model <id>` or `--model cpa/<id>:<thinking>` in a fresh subagent without a pre-existing CPA cache. The later `session_start` verification reuses the result within the configured TTL. Missing credentials, refused authentication, timeouts, network failures and invalid responses withdraw CPA models instead of advertising static fallbacks. A valid empty catalog is authoritative. The last verified catalog remains on disk as metadata during an outage; refreshing models.dev metadata cannot make it available again. Pi's native catalog refresh, including the refresh performed by `/model`, uses the provider's public `refreshModels` callback. The provider stays registered with zero models during an outage so a later refresh can discover its recovery. Checks retain the configured refresh TTL (30 seconds by default); `/cpa-refresh` forces verification and restores models after recovery. Offline/cache-only native refresh callbacks never query CPA or promote an unverified disk catalog; the extension's initial verification remains an explicit request to its configured CPA endpoint. Availability is the last verification result, not continuous endpoint monitoring.

`/providers` and status diagnostics distinguish CPA availability from the presence of credentials. HTTP 401 means the endpoint responded but rejected authentication: check the destination's secure key configuration, then run `/cpa-refresh`. A previously active CPA model cannot accept new prompts or compaction while unavailable; choose another provider with `/model` or restore CPA. Pi's native initial model fallback remains unchanged. No generation request is made by catalog verification.

`ai-providers` uses public Pi extension APIs and leaves scoped model preferences unchanged. Pi's native selector can retain a previously scoped CPA model after it disappears from the available registry; that row is not evidence of availability. Use the `all` view to inspect the available registry and `/providers` for the last CPA verification result. The extension does not modify Pi core or reach into the selector's private state.

## Configure host tools

For tools installed at different host prefixes, use the existing sandbox setup workflow:

```sh
bun ~/.pi/agent/scripts/configure-sandbox.ts preview
bun ~/.pi/agent/scripts/configure-sandbox.ts apply
```

The portable development profile declares logical tool requirements instead of paths from the producer's machine. New distributions discover Node, Bun, Python, Go, PHP/Composer and pnpm on the destination. Discovery follows executable links, gathers runtime resources and exact ELF library files, and optionally resolves mise shims when present. Neither mise nor dev-tools is required. Commands are inspected from a temporary directory outside projects, with bounded output/time and automatic version-manager downloads disabled. The four standard XDG directory selectors are retained for host configuration discovery; unrelated environment variables are omitted. This performs local metadata queries; it never installs a missing tool or trusts project configuration automatically.

PHP's `include_path` and `extension_dir` contain search candidates, which may name directories absent from a valid installation. Discovery grants only existing search directories. Loaded configuration files and executable dependencies remain subject to the normal existence and revalidation checks. A fresh discovery failure does not imply stale stored bindings.

For every supported command, reused and explicit bindings must still expose an executable through their own authorized PATH entries and file selections. Discovery rechecks executable permissions and rejects writable, missing or redirected commands. It never repairs a stale binding by falling back to another installation on the current PATH. The resolved executable behind a launcher receives the same permission checks as the launcher itself.

Qualification runs clean Ubuntu containers separately for system and mise tools before the Ubuntu and WSL2 sandbox jobs. The containers start without distro PHP, Composer, Go or pnpm; system packages are installed only in the system branch. Each layout records actual canonical executable origins, runs all seven tools, checks retained bindings without ambient PATH and executes negative discovery regressions. The pinned dev-tools revision deliberately supplies PHP through APT and links it into mise; that origin is checked explicitly rather than described as a private PHP installation. PHP fixtures additionally exercise absent search directories regardless of system resources. These checks run on changes to `develop` and `main`; their configured presence does not establish a successful CI run.

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

## Runtime retention and cleanup

Successful Pi runtime promotions, Zerobox promotions and portable setup transactions collect unreferenced runtime versions automatically. To inspect or apply the same policy manually:

```sh
pi-setup cleanup --dry-run
pi-setup cleanup
```

Both commands accept `--root DIR`. The JSON report lists each recognized directory, its proposed action and retention reason, allocated bytes, estimated reclaimable bytes and warnings. Preview does not delete versions or stale references. Cleanup keeps current and previous runtimes, installed package pins and links, portable installation snapshot references, and versions pinned by live processes. Unknown directories and symbolic links are retained. Migration backups and historical package-set snapshots have their own lifecycle and are not deleted by this command.

The daily Pi launcher records its resolved runtime before launch; the Zerobox backend records its resolved version before loading it. References bind the owner PID to its Linux process start time and boot identity, so a reused PID cannot retain or release another process's version. Normal exit removes references; a later cleanup reaps references left by killed processes. An older Pi session without this metadata conservatively defers Zerobox collection until it exits. A long-lived process may therefore retain more than the two ordinary runtime versions.

Promotions, package mutations, packaging, setup journal creation and garbage collection share a kernel lock. Python 3 with its standard Unix `fcntl` module, already a host prerequisite, acquires that lock through an inherited descriptor. Mutating child processes inherit it, so interruption of their waiting parent does not permit concurrent cleanup; the kernel releases the lock when its last holder exits. Small control resources live beside the installation: `~/.pi.runtime.lock` and `~/.pi.runtime-users/` for the default root. They are outside portable archives and setup snapshots. Cleanup never requires deleting a stale lock file. Busy or uninspectable relevant processes produce an explicit failure or retention reason instead of an unsafe purge.

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
