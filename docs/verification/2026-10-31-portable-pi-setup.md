# Portable Pi setup implementation verification

Date: 2026-10-31. Scope: the local implementation of `pi-setup`, packed Pi runtime import, launcher transaction gates and optional global Hermes memory transfer. Operator instructions are in [Portable Pi setup](../portable-setup.md).

## Implemented behavior

- Build a private distribution from committed setup code, portable personal configuration, pinned package sources, captured global skills, validated Pi tarballs and Zerobox resources. Exclude credentials, sessions and memory. Reject uncommitted setup code before collecting the profile.
- Publish to the dedicated private repository through draft-to-immutable-release promotion; verify repository privacy, release attestations, asset attestations, archive digests and extracted file inventory when downloading.
- Install or update a managed snapshot using directory staging and an external recovery journal. Refuse unmanaged installations, changed managed files, local collisions and running Pi processes. Preserve current local data during rollback and recover interrupted activation.
- Import the packed Pi runtime through the existing Socket Firewall, smoke-check and promotion implementation. Install packages through the daily Pi CLI, preserve package resource filters, stage Zerobox at its final path and apply existing sandbox tool bindings. Host tools are checked rather than installed.
- Transfer canonical global Hermes Markdown separately, filter project-scoped failures with Hermes' own implementation and rebuild a clean searchable SQLite index. Refuse SQLite-only global memories that would be lost and refuse overwriting existing destination memory.

## Executed checks

Commands were run from `~/.pi/agent` unless stated otherwise.

| Check | Result |
| --- | --- |
| `bun test --isolate bin/setup bin/pi-fork-cli.test.ts bin/pi-fork-release.test.ts bin/pi-runtime-store.test.ts bin/pi-wrapper-lib.test.ts extensions/_shared/redaction.test.ts` | 82 passed, 0 failed; 284 assertions |
| Focused packaging, transaction, diagnostic and profile tests under Bun 1.3.14 | 13 passed, 0 failed; subsequent fresh-process/transitive-resolution regression also passed on Bun 1.3.14 |
| Pi release regression suite repeated under Bun 1.3.14 | 10 consecutive local executions passed; intermittent CI timeouts remain recorded separately |
| `bun run lint` | Exit 0, with warnings; includes extension boundary and storage checks |
| `bun run typecheck` | Exit 1; the same four pre-existing diagnostics listed below, none in the setup implementation |
| Formatting for changed setup TypeScript files | Passed with the repository formatter and repository options; ignored `bin` files were explicitly selected |
| `git diff --check` from `~/.pi` | Passed |

The typecheck diagnostics concern `fullOutputPath` on `{}` at `extensions/__tests__/integration/agent-browser-sandbox-artifacts.integration.test.ts:156`, and `signal` on `never` at `extensions/sandbox/preparation.test.ts:104` and `extensions/sandbox/runtime/runtime-bundle.test.ts:141` and `:216`. These unrelated files were not changed to hide the baseline failures. Lint is not a zero-warning qualification; JSON validation boundaries and existing repository code still produce warnings.

The tests use temporary directories and isolated homes. Archive extraction, file fingerprints, directory activation, rollback and recovery run against real filesystem operations. Tests exercise actual Hermes storage and index reconciliation with temporary SQLite databases. The GitHub CLI is substituted at the process boundary to cover private publication, verified download and asset-verification refusal without creating a remote release. Package installation is substituted in setup transaction tests; the runtime import tests retain the existing simulated package installer and real promotion/coherence logic. Profile tests cover relocation outside `~/.pi`, local authority preservation and initialization of the changelog marker before recording integrity.

Verified regression cycles include mutable package-source rejection, legacy Hermes memory directory selection and the `pi-fork` transaction gate. Archive round-trip tests exposed and corrected a mismatch between source file modes and normalized archive permissions. Existing redaction characterization tests passed before and after separating pure redaction from TUI display formatting.

## Release boundaries and remaining qualification

No dependency was installed into the live setup, no live credentials or memories were exported, and no private repository or release was created. The current source checkout was not adopted as a managed installation. The implementation is committed on the dedicated CI candidate branch `codex/portable-setup-ci-20261031`; the live source checkout retains its uncommitted changes, which `pack` deliberately rejects. No distribution release has been published. The isolated candidate excludes unrelated local changes and history.

The installer uses the existing sandbox development setup implementation and example profile already present as separate workspace changes. A release must include reviewed versions of `agent/scripts/configure-sandbox.ts`, its sandbox capability dependencies and `agent/config/sandbox.development.example.json`; this work did not rewrite those changes.

Actual Ubuntu 24.04 and WSL2 execution is tracked in the [CI qualification report](2026-10-31-portable-pi-ci.md), including failed runs and the final admission status. Real GitHub immutable-release publication/download and provider connectivity remain unrun. The complete repository test suite was not run because validation was scoped to the changed runtime and operator surfaces. Filesystem transaction tests establish ordinary failure and process-interruption recovery, not power-loss durability. These limits must remain visible when admitting an actual release.
