# Runtime Retention Implementation Plan

> Execute locally with the TDD skill. Repository instructions prohibit implementation or review delegation without explicit authorization.

**Goal:** Bound local Pi and Zerobox runtime storage while preserving current, rollback, package-pinned and live-session versions, then clean the installed stores.

**Architecture:** Reuse the Pi runtime store and Zerobox staging owner for retention decisions. A shared filesystem module owns kernel locking, process identities and runtime usage references. The existing setup CLI previews and applies both owners' cleanup; successful promotions invoke their owner's cleanup.

**Tech stack:** Strict TypeScript, Bun tests, Node filesystem/process APIs and Python 3's standard `fcntl` module. No dependency installation or new service.

## Constraints

- Preserve unrelated staged files and personal state; develop on `develop`.
- Delete only recognized, directly managed release directories. Never follow deletion targets through symlinks.
- Preserve current/previous versions, installed package references and live runtime users. Conservatively retain Zerobox releases while legacy Pi sessions have no precise reference.
- Serialize promotions, reference creation and garbage collection with the same kernel lock. Setup transactions establish their journal under that lock.
- Leave migration backups and historical package-set snapshots untouched.
- Run deterministic tests in temporary installations. Actual installation/sandbox qualification belongs in GitHub Actions.

## Tasks

- [x] Add a failing public CLI test for `pi-setup cleanup --dry-run`.
- [x] Implement shared locking and PID/start-time/boot-bound runtime references in `agent/extensions/_shared/runtime-storage.ts`, with filesystem and real child-process tests.
- [x] Extend `agent/bin/pi-runtime-store.ts` and `agent/bin/pi-fork-release.ts` with safe release/state retention and serialized promotion.
- [x] Extend the Zerobox staging owner with a previous-version reference, bounded legacy recovery and owner-specific retention.
- [x] Pin the concrete Pi runtime in `bin/pi` and the concrete Zerobox runtime when its backend resolves the managed executable.
- [x] Add cleanup preview/application to `agent/bin/setup/cli.ts`; preserve bootstrap help without installed Pi packages. Protect setup journal creation against concurrent garbage collection.
- [x] Verify current/previous/package/live-process protection, PID reuse, dry-run behavior, unknown/symlink refusal, lock conflicts and automatic post-promotion cleanup.
- [x] Update the portable guide and release skill, run focused checks and the required boundary graph, inspect the real preview, then apply cleanup and verify protected paths/configuration.

## Validation and completion

Focused executable RED/GREEN tests precede implementation. Validate types and lint on affected modules, run all affected owner suites once stable, and rerun only checks invalidated by later edits. Report actual reclaimed storage, retained versions, blocked legacy references and unrun CI checks. No new publication is part of this task.
