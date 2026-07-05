# ADR-003: Audit Mode as a Shared Tool Policy Architecture

## Status
Accepted

## Date
2026-07-04

## Context

Pi currently has three separate areas that influence how the agent explores the
workspace:

1. `pi-overrides` registers native `read`, `grep`, `ls`, and `find`, and adds
   those tools to the active toolset.
2. `safe-bash` wraps shell execution and blocks shell forms like `grep`, `find`,
   and `ls` in favor of native tools through `redirectShellCommand(...)`.
3. `save-tokens` compresses tool results after execution, which is useful for
   exploration but can be risky for exact audits and mechanical refactors if a
   summarized search result hides late matches.

This creates a real product need: the user wants a mode they can toggle at
runtime, like `/slow-mode` or `/sandbox`, that shifts Pi from efficient
exploration behavior toward exhaustive audit behavior.

The desired behavior is not limited to compression. In the user's preferred
workflow, audit mode should also:

- prefer native `grep`, `find`, `ls`, and `read` more aggressively over shell
  equivalents,
- relax native search restrictions such as `.gitignore` filtering for `grep`
  and `find`,
- surface hidden files more explicitly for discovery,
- keep compression enabled in the default audit mode,
- provide an advanced audit mode that additionally relaxes or disables
  compression for exact-search workflows.

There is one architectural constraint that rules out the obvious but wrong
implementation: **extensions must not import from other extensions**. Shared
logic must live under `_shared`, and extensions may only depend on that shared
layer.

Without a dedicated architecture, audit logic would be scattered across
`save-tokens`, `safe-bash`, and `pi-overrides` as ad hoc conditionals. That
would be difficult to read, difficult to test, and likely to drift as new tools
or modes are added.

## Decision

### 1. Introduce a flat runtime audit-mode toggle with config-defined profiles

Pi will expose a flat command surface:

- `/audit-mode on`
- `/audit-mode off`
- `/audit-mode advanced`
- `/audit-mode status`

The command does not hardcode behavior. It selects a named profile.

Behavior is defined in merged settings from:

- `~/.pi/agent/settings.json`
- `<cwd>/.pi/settings.json`

Project-local settings override global settings.

The resolved profile model is:

- `standard`
- `audit`
- `advanced`

The chosen default semantics are:

- **`audit`**: relax native tool restrictions while keeping compression enabled.
- **`advanced`**: everything from `audit`, plus compression relaxations for
  exhaustive workflows.

### 2. Store all shared audit policy under `_shared/audit-mode/`

To respect extension boundaries, the shared layer will be a dedicated folder:

- `_shared/audit-mode/audit-policy.ts`
- `_shared/audit-mode/audit-state.ts`
- `_shared/audit-mode/audit-tool-routing.ts`

These files are the only shared dependency surface for audit mode.

They own:

- profile names and flag schema,
- defaults and config merge logic,
- runtime state for the active audit profile,
- shared routing policy helpers for shell-vs-native decisions.

They do **not** own:

- command registration,
- UI widgets,
- compression implementation,
- native tool factory registration,
- sandbox or slow-mode logic.

### 3. Use one runtime owner extension and multiple policy consumers

One dedicated runtime owner extension will register `/audit-mode ...`, load the
resolved config, activate profiles, and persist active mode state if needed.

Consumer extensions will read shared policy at runtime:

- `pi-overrides` shapes native `read`, `grep`, `ls`, `find`
- `safe-bash` shapes shell-to-native redirect policy
- `save-tokens` shapes compression policy for tool results

No consumer imports another extension directly.

### 4. Define audit mode as a policy object, not a boolean

The effective policy should resolve to a flag object roughly equivalent to:

```ts
type AuditProfileName = "standard" | "audit" | "advanced";

interface AuditPolicy {
  profile: AuditProfileName;
  preferNativeTools: boolean;
  listing: {
    showHidden: boolean;
  };
  find: {
    ignoreGitignore: boolean;
  };
  grep: {
    ignoreGitignore: boolean;
  };
  read: {
    unchanged: boolean;
  };
  compression: {
    disableForSearch: boolean;
    disableForRead: boolean;
    disableForShellResults: boolean;
  };
}
```

This preserves the flat UX while keeping flags configurable in settings.

### 5. Adopt the following default profile behavior

#### `standard`

Current behavior:

- native tools exposed by `pi-overrides`
- shell commands redirected by `safe-bash`
- compression behaves as configured today in `save-tokens`

#### `audit`

Default audit profile:

- built-in `find` ignores `.gitignore`
- built-in `grep` ignores `.gitignore`
- native-tool preference becomes stricter than standard mode
- hidden files are more explicitly surfaced in listing/discovery behavior
- `read` stays unchanged
- compression remains enabled

#### `advanced`

Advanced audit profile:

- everything from `audit`
- compression is relaxed or bypassed for exact-search workflows
- intended for exhaustive audits, migration inventories, and mechanical
  refactors where completeness matters more than token savings

## Architecture

### Shared folder layout

```text
agent/extensions/_shared/
  audit-mode/
    audit-policy.ts
    audit-state.ts
    audit-tool-routing.ts
```

### Ownership split

#### Audit-mode owner extension

Owns:

- command registration
- profile activation (`on`, `off`, `advanced`, `status`)
- settings loading and profile resolution
- runtime state writes to the shared audit state

Does not own tool behavior or compression logic.

#### `pi-overrides`

Owns:

- native tool registration for `read`, `grep`, `ls`, `find`
- native tool execution-time behavior changes based on resolved audit policy

Specific audit-sensitive behaviors:

- whether `find` respects `.gitignore`
- whether `grep` respects `.gitignore`
- how hidden files are surfaced
- whether native tools should be favored more strongly in the active toolset

#### `safe-bash`

Owns:

- dangerous shell command blocking
- shell-to-native redirect enforcement

It remains the owner of shell mediation, but audit-specific shell routing rules
must be delegated to `_shared/audit-mode/audit-tool-routing.ts` so the shell
policy is not duplicated.

#### `save-tokens`

Owns:

- tool-result compression
- compression telemetry
- compression widget / notifications

It reads the resolved audit policy to decide whether exact-search flows should:

- keep normal compression,
- relax compression,
- or bypass compression entirely.

### Runtime data flow

```text
session_start
  └─ audit-mode owner loads merged settings
       └─ resolves profiles
            └─ writes active audit policy to _shared runtime state

tool registration / execution
  ├─ pi-overrides reads shared audit policy
  │    └─ shapes native find/grep/ls/read behavior
  ├─ safe-bash reads shared audit policy
  │    └─ shapes shell-to-native redirect strictness
  └─ save-tokens reads shared audit policy on tool_result
       └─ shapes compression behavior

/audit-mode on|advanced|off|status
  └─ owner updates shared runtime state
       └─ consumers observe new policy on their next execution path
```

This preserves extension isolation while allowing all related behaviors to move
together under one policy switch.

## Configuration Model

The configuration should be nested under a single settings key. Exact naming may
be tuned later, but the shape should follow this pattern:

```json
{
  "auditMode": {
    "defaultProfile": "standard",
    "profiles": {
      "standard": {
        "preferNativeTools": false,
        "listing": { "showHidden": false },
        "find": { "ignoreGitignore": false },
        "grep": { "ignoreGitignore": false },
        "read": { "unchanged": true },
        "compression": {
          "disableForSearch": false,
          "disableForRead": false,
          "disableForShellResults": false
        }
      },
      "audit": {
        "preferNativeTools": true,
        "listing": { "showHidden": true },
        "find": { "ignoreGitignore": true },
        "grep": { "ignoreGitignore": true },
        "read": { "unchanged": true },
        "compression": {
          "disableForSearch": false,
          "disableForRead": false,
          "disableForShellResults": false
        }
      },
      "advanced": {
        "preferNativeTools": true,
        "listing": { "showHidden": true },
        "find": { "ignoreGitignore": true },
        "grep": { "ignoreGitignore": true },
        "read": { "unchanged": true },
        "compression": {
          "disableForSearch": true,
          "disableForRead": false,
          "disableForShellResults": true
        }
      }
    }
  }
}
```

This keeps runtime UX flat while making tool flags configurable in settings as
requested.

## Alternatives Considered

### A. Put `/audit-mode` entirely inside `save-tokens`

- **Pros**: Very small initial change.
- **Cons**: Wrong abstraction. Audit mode would only control compression, while
  the real requirement also affects native tool behavior and shell routing.
- **Rejected**.

### B. Put audit logic directly inside `pi-overrides`

- **Pros**: Native tools are already there.
- **Cons**: `pi-overrides` would become the accidental policy owner for shell
  routing and compression concerns it does not own.
- **Rejected**.

### C. Store runtime state inside the owner extension and let others import it

- **Pros**: Simple in local code.
- **Cons**: Violates the boundary rule that extensions must not import from
  other extensions.
- **Rejected**.

### D. Boolean audit mode only

- **Pros**: Simpler implementation.
- **Cons**: Cannot express the distinction between normal audit behavior and the
  stronger advanced compression-bypass behavior; also poor fit for future
  extensibility.
- **Rejected**.

### E. Flat toggle + configurable profiles under `_shared` (chosen)

- **Pros**: Preserves clean UX, centralizes policy, respects extension
  boundaries, and supports future growth.
- **Cons**: Requires a small shared policy subsystem and one new owner
  extension.
- **Accepted**.

## Consequences

### Positive

- One coherent architecture controls native discovery, shell mediation, and
  compression policy together.
- Runtime UX stays simple and familiar.
- Settings remain expressive and granular.
- Extension boundaries stay intact because shared logic lives only under
  `_shared`.
- Future modes can reuse the same policy framework.

### Negative

- Introduces one additional shared subsystem to maintain.
- Requires coordinated changes in at least three consumer extensions.
- The built-in native tool factories may need wrapping or augmentation if their
  current API does not expose `.gitignore` behavior in a configurable way.

### Risks

- If native tool factories do not allow `.gitignore` bypass, `pi-overrides` may
  need to own a custom wrapper layer instead of directly forwarding factory
  behavior.
- If runtime shared state is implemented too implicitly, it can become hard to
  debug; the `status` command must therefore show resolved profile and flags.

## Implementation Notes

- The owner extension should be small and policy-only.
- The shared audit state should remain generic and not embed UI or extension
  internals.
- `safe-bash` should keep danger logic in `bash-guard.ts`, but audit-specific
  redirect strictness should move to the shared audit routing helper.
- `save-tokens` should keep its current ownership of compression telemetry and
  rendering; it should only change how compression decisions are made.
- `pi-overrides` should remain the owner of native tool registration and native
  exploration semantics.

## Follow-up Work

1. Add the `_shared/audit-mode/` policy modules.
2. Add the owner extension and `/audit-mode` command surface.
3. Refactor `safe-bash` redirect policy to consult shared audit routing.
4. Refactor `pi-overrides` to apply audit-sensitive native tool options.
5. Refactor `save-tokens` to apply audit-sensitive compression policy.
6. Add focused tests for profile resolution, runtime state, shell routing, tool
   behavior shaping, and compression-mode transitions.