---
name: pi-setup-release
description: Promote, package, qualify and publish this repository's personal Pi setup, or finalize and clean up its development branches. Use only for this Pi setup repository; host-tool installation and independent extension releases have their own workflows.
---

# Pi setup releases

## Authority and source

Develop on `develop`. Promote only the validated scope to `main` when authorized; publish only a reviewed commit from `main`. Implementation, promotion, qualification and publication are separate actions: use existing session authorization and state any remaining action explicitly instead of requesting repeated confirmation or claiming an isolated branch is complete.

Inspect branches and worktrees before creating another. Work directly on `develop` when isolation is unnecessary; otherwise reuse one task branch with a descriptive name, without an automatic `codex/` prefix. Keep deliberate CI failures outside integration branches. After authorized integration, inspect ancestry and content for squashed or replaced work, preserve active/dirty worktrees, archive unique historical commits when removing them, and clean up obsolete local and remote task branches within the authorized scope. Never force-push to resolve a concurrent update.

## Validate and promote code

1. Inspect the current checkout, user changes, remote refs and linked worktrees. Freeze the intended promotion scope; do not merge unrelated or unvalidated development work merely because it shares `develop`.
2. Apply the repository TDD and validation rules. Run actual installation and sandbox checks in GitHub Actions, never against the daily installation. Provider generation is a separate optional qualification and stays disabled unless explicitly authorized with a budget.
3. Promote the validated scope to `main` when authorized, push it, and record its full SHA. Fetch `origin/main` before selecting the release revision. Do not rewrite history or change the working checkout to manufacture release eligibility.
4. Keep the private distribution workflow identical to the canonical `.github/workflows/portable-private-qualification.yml` in this repository. Synchronize it when that canonical file changes, then verify the private workflow revision before dispatch.

## Prepare one private package

Run the maintained setup operator; the checkout may remain on `develop`:

```sh
install -d -m 700 ~/.cache/pi/release-candidates
bun ~/.pi/bin/pi-setup pack --output ~/.cache/pi/release-candidates/RELEASE_TAG
```

The output directory must not exist. `--source-sha FULL_SHA` selects a historical approved main commit; the default is the freshly fetched main tip. The packer reads code from that Git snapshot, independently of committed, modified or untracked development files. It captures the current personal profile and exact installed package versions separately. Pi tarballs and the Zerobox release must match the selected source pins; a newer active runtime is not substituted. Missing or mismatched artifacts fail visibly: obtain the matching qualified artifacts through the existing runtime workflow instead of rebuilding or activating them on this workstation.

Review `inventory.json` and the captured profile locally. Verify the source SHA, package pins, runtime identities, archive digest and intended skills/configuration. Redaction is a rejection check, not proof that arbitrary prose contains no private data. Keep this directory owner-only. Credentials, sessions, memory, caches and machine authority must remain excluded. Resolve unsupported resources explicitly; never suppress packaging failures or rewrite personal files just to pass them.

## Qualification without publication

Use the final release tag from the start. Upload only `setup.tgz` and `release.json` to one private draft in `abdwhb-png/my-pi-distribution`, using `gh release create --draft`. Do not finalize it in the UI.

Dispatch `portable-private-qualification.yml` in that private repository with the exact `source_sha`, `candidate_release`, `candidate_sha256` from the package and `publish=false`. The workflow verifies main ancestry, canonical code, pinned runtimes, archive integrity and draft asset identity before installation. Full qualification covers installation, sandbox execution, update, idempotency, rollback, modified-file refusal and the complete installed profile lifecycle. Public Ubuntu/WSL2 mechanism qualification remains separate from the private Ubuntu profile test.

Wait for the specific run and inspect the structured private evidence. `qualification.json` must pass with `scope: full`; `profile.json` must pass and identify the same source and archive. Missing evidence is incomplete qualification. Verify the candidate remains a draft. `profile_only` can diagnose a failure but cannot authorize publication.

## Publish the same files

For a new package with explicit publication authorization:

```sh
bun ~/.pi/bin/pi-setup publish --from ~/.cache/pi/release-candidates/RELEASE_TAG --tag RELEASE_TAG
```

This creates a draft and requests the private workflow with `publish=true`; its successful dispatch is not publication success. Watch the run identified by its release tag. The workflow rechecks both assets, runs complete qualification, then finalizes this same draft and verifies attestations and the normal client download. It never rebuilds the archive or publishes a second tag.

For an existing draft, inspect it and dispatch the same workflow with its original source/digest and `publish=true`; do not call the create operation again. It requalifies the same files before publishing. Provider generation remains disabled by default.

A failure before finalization leaves the draft unpublished. Preserve its evidence and diagnose it; do not automatically retry whole jobs, replace assets after successful qualification, or create another tag to hide a failure. A failure after finalization may leave an immutable published release: report that state and inspect it instead of attempting replacement or deletion. Retain the run URL, source SHA, archive SHA and publication evidence.

## Install and memory

On the destination, follow [the installation guide](../../../docs/portable-setup.md), authenticate GitHub CLI through its normal secure flow, and install the explicitly qualified tag. Bootstrap from `main`. Add the installation's `bin` directory to PATH and configure provider credentials through the secure destination channels. Do not put secrets into chat, workflow inputs or release assets.

Memory transfer is optional and separate through `pi-setup memory export/import`. Sessions are not transferred. Host tools, local services, Docker and browsers are separate host responsibilities; Pi discovers supported host tools without requiring dev-tools or mise.

The [private qualification reference](../../../docs/portable-private-qualification.md) owns credential names, provider cases and their verification limits. Use the existing operator and workflows; do not add a second installer or a release orchestration framework.
