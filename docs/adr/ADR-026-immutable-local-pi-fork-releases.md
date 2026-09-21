# ADR-026: Run the local Pi fork from immutable promoted releases

## Status

Accepted

## Date

2026-09-21

## Context

The active Pi setup mixes several unrelated states:

- the globally installed CLI is `@earendil-works/pi-coding-agent@0.84.3`;
- `~/.pi/agent` references the local `~/projects/pi-core` coding-agent package at `0.85.0`;
- semver ranges inside that package resolve nested Pi packages at `0.85.1`;
- older top-level Pi packages at `0.84.2` remain installed;
- the wrapper defaults to `~/projects/pi-core/packages/coding-agent/dist/pi`, so rebuilding development source immediately changes the daily runtime;
- the Herdr shell integration explicitly sets the same unstable source binary.

A local `file:` dependency pins only the referenced package directory. It does not pin that package's semver dependencies to sibling packages from the same checkout. `bun install`, `bun update`, or a package install can therefore create a mixed Pi graph without running `pi update`.

The fork already provides `scripts/local-release.mjs`, which builds and packs every publishable Pi package and can create an isolated installation outside the repository. The missing boundary is controlled promotion into the user's active runtime.

## Decision

### Build immutable releases outside the source checkout

A release manager stores runtime snapshots under:

```text
~/.pi/runtime/pi-core/
├── releases/<release-id>/
├── current -> releases/<release-id>
└── previous -> releases/<release-id>
```

Each release is created in a staging directory and contains:

- all Pi package tarballs produced by the same fork build;
- an isolated Bun production installation using only those tarballs for internal Pi packages;
- a manifest recording schema version, source commit, dirty state, creation time, executable path, coding-agent package root, package versions, and tarball SHA-256 hashes.

Source builds never run from `~/projects/pi-core/**/dist` in normal operation. Editing or building the fork cannot affect the active runtime until an explicit deployment succeeds.

### Promote only after executable verification

`pi-fork deploy` performs the complete transition:

1. build and pack the fork through its existing local-release workflow;
2. install the packed packages in a new isolated directory;
3. verify every internal Pi package comes from the release tarballs and uses one coherent version set;
4. run focused CLI, RPC, extension-loading, and subagent package-root smoke checks through the package's Bun entry when its declared CLI is a Node bundle;
5. write the release manifest and make the release read-only;
6. synchronize `~/.pi/agent` dependency pins and overrides to exact immutable tarball paths;
7. atomically promote the release by replacing `current`, preserving the former target as `previous`.

Any failure before the final symlink swap leaves the active runtime unchanged. Agent manifest and lockfile changes are backed up and restored if synchronization fails.

`pi-fork rollback` validates `previous`, restores matching agent pins, checks package coherence, then swaps `current` and `previous` atomically. It does not rerun startup smoke checks.

### Make the wrapper the stable runtime boundary

`~/.pi/bin/pi` remains the public launcher because `~/.pi/bin` precedes `~/.bun/bin` in the login PATH. It resolves only the active release manifest. An explicit test/development override remains possible through an opt-in environment variable, but no shell integration sets it implicitly.

The wrapper exports the active release's exact coding-agent package root for subagents. Package-root discovery selects the outer package root rather than a copied `dist/package.json`, preventing `dist/dist/index.js` resolution.

### Block runtime self-updates

While the fork runtime is active:

- reject bare `pi update`;
- reject `pi update self`, `pi update pi`, and `pi update --self`;
- allow `pi update --extensions` and an explicitly named extension source;
- continue finalizing package configuration after allowed package mutations.

The fork changes only through `pi-fork deploy` or `pi-fork rollback`.

### Pin the agent's Pi dependency graph

`~/.pi/agent/package.json` contains exact local tarball dependencies and `overrides` for every internal `@earendil-works` package from the active release. It contains one `@abdwhb-png/pi-test-harness` entry. Generic `bun install` and `bun update` may change unrelated dependencies, but cannot resolve Pi internals from the registry while these overrides remain valid.

A coherence check compares the active runtime manifest, agent manifest, lockfile, and installed package roots. Run it with `pi-fork verify`; runtime startup validates the release manifest and package root, but does not rerun the full coherence scan. A missing or invalid active release never silently falls back to the global Pi package.

## Alternatives considered

### Run directly from the fork's `dist/`

Rejected because a development build immediately mutates the daily runtime and rollback requires rebuilding old source.

### Replace or patch the global Bun installation

Rejected because global package-manager state remains updateable and Pi harness policy forbids patching global Bun installation as a package fix.

### Containerize the complete Pi runtime

Rejected because it complicates TUI, local extensions, credentials, and filesystem integration without improving the explicit promotion boundary.

## Consequences

### Positive

- Source edits and builds cannot affect active Pi before promotion.
- All internal Pi packages come from one build.
- `pi update` cannot replace the fork runtime.
- Agent installs cannot silently float Pi internals to a newer registry patch.
- Promotion and rollback are atomic and independently verifiable.

### Negative

- Releases consume additional disk space.
- Deployment takes time because it builds, packs, installs, and runs focused runtime smoke checks. The fork's full upstream test suite is not modified or run by deployment.
- Changes to Pi package composition require updating the release manifest contract.
- Scripts that bypass `~/.pi/bin/pi` and invoke `~/.bun/bin/pi` directly remain outside this guarantee and must be migrated.

## Verification

Acceptance requires:

- active runtime path resolves below `~/.pi/runtime/pi-core/releases/`;
- modifying or rebuilding `~/projects/pi-core` does not change `pi --version` or active hashes;
- every installed internal Pi package matches active manifest version and tarball hash;
- no `0.84.x` or registry-sourced `0.85.1` Pi package remains in `~/.pi/agent` after migration;
- blocked self-update forms exit non-zero before invoking Pi;
- extension-only updates still work and run package finalization;
- failed deployment leaves `current`, agent manifest, and lockfile unchanged;
- rollback restores previous executable, package root, pins, and smoke-test results;
- subagents resolve `<package-root>/dist/index.js`, never `<package-root>/dist/dist/index.js`.
