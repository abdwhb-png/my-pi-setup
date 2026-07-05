# Plan: Audit Mode Implementation

**Date**: 2026-07-04
**Status**: Draft
**Related ADR**: `docs/adr/ADR-003-audit-mode-tool-policy-architecture.md`

## Goal

Implement a flat `/audit-mode` toggle with config-defined profiles that can:

- prefer native `grep` / `find` / `ls` / `read` over shell equivalents,
- relax native search restrictions like `.gitignore` filtering,
- surface hidden files more explicitly,
- keep compression enabled in normal audit mode,
- relax or disable compression in advanced audit mode,
- preserve extension boundaries so extensions never import from other
  extensions and only depend on `_shared`.

## Constraints

- Shared logic must live under `_shared/audit-mode/`.
- `pi-overrides`, `safe-bash`, and `save-tokens` may consume shared audit
  policy, but must not import one another.
- Runtime UX stays flat:
  - `/audit-mode on`
  - `/audit-mode off`
  - `/audit-mode advanced`
  - `/audit-mode status`
- Tool flags must be configurable via merged settings from:
  - `~/.pi/agent/settings.json`
  - `<cwd>/.pi/settings.json`
- Follow TDD for each implementation slice.

## Scope

### In scope

- Shared audit policy contract and runtime state.
- Audit-mode owner extension.
- `pi-overrides` integration for native tool behavior.
- `safe-bash` integration for stricter shell-to-native redirect policy.
- `save-tokens` integration for audit-sensitive compression policy.
- Focused tests for policy resolution, state transitions, and consumer behavior.

### Out of scope

- Any change to sandbox behavior.
- Any change to slow-mode behavior.
- New UI widgets beyond a minimal status/reporting path if needed.
- Rewriting native tool factories upstream in Pi core.

## Target Files

### New shared files

- `agent/extensions/_shared/audit-mode/audit-policy.ts`
- `agent/extensions/_shared/audit-mode/audit-state.ts`
- `agent/extensions/_shared/audit-mode/audit-tool-routing.ts`

### New owner extension

- `agent/extensions/audit-mode/index.ts`
- `agent/extensions/audit-mode/index.test.ts`

### Consumer changes

- `agent/extensions/pi-overrides/index.ts`
- `agent/extensions/safe-bash/index.ts`
- `agent/extensions/_shared/bash-guard.ts`
- `agent/extensions/save-tokens/local-tool-result-compressor.ts`
- `agent/extensions/save-tokens/tool-results/core.ts`
- `agent/extensions/save-tokens/config.ts`
- `agent/extensions/save-tokens/config.test.ts`
- `agent/extensions/save-tokens/local-tool-result-compressor.test.ts`

### Optional follow-up files

- `agent/extensions/pi-overrides/index.test.ts` if missing or insufficient
- `agent/extensions/_shared/audit-mode/*.test.ts`

## Profile Model

Resolved profile names:

- `standard`
- `audit`
- `advanced`

Required policy fields:

- `preferNativeTools`
- `listing.showHidden`
- `find.ignoreGitignore`
- `grep.ignoreGitignore`
- `read.unchanged`
- `compression.disableForSearch`
- `compression.disableForRead`
- `compression.disableForShellResults`

Default semantics:

- `standard`: current behavior.
- `audit`: native restrictions relaxed, compression still enabled.
- `advanced`: everything from `audit`, plus compression relaxations.

## Implementation Phases

### Phase 1 — Shared policy contract and runtime state

**Goal**: Create the shared policy surface before touching consumer
extensions.

#### Steps

1. Add `audit-policy.ts` with:
   - profile name types,
   - settings schema/types,
   - defaults,
   - config normalization,
   - merge helpers,
   - `resolveAuditPolicy(...)`.
2. Add `audit-state.ts` with:
   - runtime getter/setter for the active mode,
   - session-safe reset/init helpers,
   - a single resolved state object for consumers.
3. Add `audit-tool-routing.ts` with:
   - shared helpers to decide whether a shell command should be redirected,
   - helpers for “prefer native” behavior,
   - no direct dependency on extension implementations.

#### TDD

- Write tests first for:
  - config normalization,
  - global/project merge precedence,
  - default profile resolution,
  - active state set/get/reset,
  - routing helper behavior by profile.

#### Validation

- Shared tests pass.
- No consumer extension imports are needed yet.

### Phase 2 — Owner extension and command surface

**Goal**: Add the runtime controller that owns `/audit-mode`.

#### Steps

1. Create `extensions/audit-mode/index.ts`.
2. On `session_start`, load merged settings and initialize shared state to the
   resolved default profile.
3. Register command:
   - `/audit-mode on`
   - `/audit-mode off`
   - `/audit-mode advanced`
   - `/audit-mode status`
4. `status` should display:
   - active profile,
   - resolved flags,
   - whether project config overrides global config.

#### TDD

- Tests for command parsing and state transitions.
- Tests for `status` output shape.

#### Validation

- Command toggles shared state correctly.
- Session start initializes state predictably.

### Phase 3 — `safe-bash` routing integration

**Goal**: Make shell-to-native redirect policy audit-aware without moving
danger logic out of its owner.

#### Steps

1. Keep danger detection in `bash-guard.ts`.
2. Refactor shell redirect behavior so audit-sensitive parts read from
   `_shared/audit-mode/audit-tool-routing.ts`.
3. Update `safe-bash/index.ts` so it consults shared policy before deciding how
   strongly to redirect commands like:
   - `grep`
   - `rg`
   - `find`
   - `fd`
   - `ls`
   - optionally `cat`-like reads later if needed.

#### TDD

- Add tests for redirect behavior under:
  - `standard`
  - `audit`
  - `advanced`

#### Validation

- Dangerous shell commands still block exactly as before.
- Redirect strictness changes only via shared audit policy.

### Phase 4 — `pi-overrides` native tool behavior integration

**Goal**: Make built-in tools honor audit policy.

#### Steps

1. Update `pi-overrides/index.ts` to consult shared audit policy at runtime.
2. Shape native tool behavior for:
   - `find.ignoreGitignore`
   - `grep.ignoreGitignore`
   - `listing.showHidden`
   - stronger native-tool preference if applicable.
3. If the native factory APIs do not expose required flags, wrap or adapt the
   tool definitions locally in `pi-overrides` rather than modifying unrelated
   extensions.

#### TDD

- Tests for native tool registration under audit modes.
- Tests that ignored files become visible in `audit` / `advanced`.
- Tests that hidden file visibility behaves as configured.

#### Validation

- Built-in tools remain the owner-supported path.
- No cross-extension imports are introduced.

### Phase 5 — `save-tokens` audit-aware compression

**Goal**: Make compression policy respond to audit profiles.

#### Steps

1. Extend `save-tokens` config/runtime resolution if needed so compression code
   can combine local compressor config with shared audit policy.
2. Update `tool-results/core.ts` so routing/compression decisions consult the
   active audit profile.
3. Preserve default behavior in `standard`.
4. In `audit`, keep compression enabled.
5. In `advanced`, relax or bypass compression according to flags:
   - `disableForSearch`
   - `disableForRead`
   - `disableForShellResults`

#### TDD

- Add tests for tool-result handling under all three profiles.
- Verify `grep` / `find` / `bash` behaviors are profile-sensitive.
- Verify `audit` keeps compression on.
- Verify `advanced` disables configured compression slices only.

#### Validation

- Existing compression behavior stays unchanged in `standard`.
- `advanced` preserves completeness for exact-search workflows.

### Phase 6 — End-to-end integration and regression checks

**Goal**: Verify the architecture behaves coherently across all consumers.

#### Steps

1. Add integration-style tests where practical to prove that:
   - changing audit mode updates shared state,
   - `safe-bash` redirect behavior changes,
   - `pi-overrides` native search behavior changes,
   - `save-tokens` compression behavior changes.
2. Verify `status` shows the effective resolved configuration.
3. Re-run focused suites for touched areas.

#### Validation commands

- `bun test` for new shared audit-mode tests
- `bun test extensions/save-tokens/...`
- `bun test extensions/safe-bash/...`
- `bun test` for `pi-overrides` tests if present
- `bun run typecheck`
- `bun run lint:check`

If full typecheck is blocked by unrelated existing failures, record those and
still verify all touched files and focused suites.

## Order of Execution

Recommended implementation order:

1. Shared policy files
2. Owner extension
3. `safe-bash`
4. `pi-overrides`
5. `save-tokens`
6. Integration/regression validation

This order keeps dependencies one-directional and reduces rework.

## Risks and Mitigations

### Risk: Native tool factories do not expose `.gitignore` bypass

**Mitigation**:
- Keep the adaptation local to `pi-overrides`.
- Wrap factory behavior there if necessary.

### Risk: Shared runtime state becomes implicit and hard to debug

**Mitigation**:
- Make `/audit-mode status` explicit and verbose enough to show resolved flags.
- Keep state helpers tiny and testable.

### Risk: Compression exceptions drift from audit semantics

**Mitigation**:
- Treat audit policy as the only source of truth.
- Do not encode audit-specific booleans directly in `save-tokens` outside the
  shared policy layer.

## Acceptance Criteria

The implementation is complete when:

1. `/audit-mode on|off|advanced|status` works.
2. Audit profiles are configurable from merged settings.
3. No extension imports another extension.
4. Shared logic exists only under `_shared/audit-mode/`.
5. `safe-bash`, `pi-overrides`, and `save-tokens` all consult the same active
   shared policy.
6. `audit` relaxes native search/listing restrictions while keeping compression
   enabled.
7. `advanced` additionally relaxes or disables configured compression slices.
8. Focused tests, typecheck, and lint pass for all touched areas, or unrelated
   pre-existing blockers are clearly identified.