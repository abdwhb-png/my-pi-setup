# pi-roles architecture

## Runtime boundary

`agent/extensions/pi-roles/index.ts` is the only auto-discovered entrypoint:

```text
pi-roles/index.ts
  -> registerPiRolesCore(pi)
  -> registerRoleFeatures(pi)
```

Core registration always happens before feature registration. The former package and separate feature entry are no longer runtime entries.

## Layout

```text
extensions/
├── _shared/pi-roles/
│   ├── contracts.ts
│   ├── helpers.ts
│   ├── protocol.ts
│   ├── transition-policy.ts
│   └── index.ts
└── pi-roles/
    ├── index.ts
    ├── core/
    ├── features/
    ├── resources/roles/
    └── examples/
```

## Dependency direction

```text
other extensions ─┐
features ─────────┼──> _shared/pi-roles
core ─────────────┘

_shared/pi-roles -X-> pi-roles
```

The shared barrel is the only supported cross-extension import. It owns:

- `contracts.ts`: `RoleSource`, `ActiveRoleState`, schemas, and persisted constants.
- `protocol.ts`: role-switch request and processed markers, tool-policy events, and session readers/writers.
- `transition-policy.ts`: transition authorization and the reload-safe registry stored at `Symbol.for("pi-roles.transition-policies.v1")`.
- `helpers.ts`: default/active-role lookup plus frontmatter and comma-list parsing.

Transition policy inputs depend on the structural `RoleTransitionRole` shape `{ name, handoffGuard? }`; the shared layer does not import `ResolvedRole`.

## Core lifecycle

`core/index.ts` owns the `--role` flag, `/role`, `switch_role`, message rendering, and session hooks.

1. `session_start` reloads settings and roles, restores persisted state on reload/resume, resolves the selected role, and applies model, thinking, tools, status, and persistence.
2. `before_agent_start` consumes an unprocessed switch request once, applies the target role, appends its processed marker, and composes the role prompt.
3. `apply.ts` emits `pi-roles:tool-policy` immediately after setting active tools.

Role state is persisted as `pi-roles:active-role`, so a new Jiti extension instance restores it rather than relying on module identity.

## Features

`features/index.ts` registers the feature modules through the same `ExtensionAPI` instance:

- `atlas-pi-subagents.ts`
- `plan-auto-switch.ts`
- `plan-submission-guard.ts`
- `prompt-role-switch.ts`
- `role-subagents.ts`
- `session-plan-persistence-guard.ts`

`plan-submission-lifecycle.ts` is shared feature logic, not another factory.

Feature-owned transition policies use stable `pi-roles.*` keys. Re-registering a named policy replaces its stale handler after reload.

## Tool visibility

Role frontmatter produces an effective tool policy. Pi's runtime function schemas are authoritative. `tool-groups` consumes `pi-roles:tool-policy` and enforces the same policy at execution time.

`context.ts` does not synthesize a second `Available tools:` prompt section. Its `/context` view queries `pi.getActiveTools()`, so diagnostics follow the live schema after a role transition.

## Tests

Tests stay beside directory-form extension modules and use `bun:test`. Real Pi lifecycle coverage uses `@abdwhb-png/pi-test-harness` for registration, event ordering, role application, Plannotator approval, and tool-policy enforcement.

The migration characterization baseline is:

- 137 core tests.
- 71 feature and shared-bridge tests.
- 208 migrated tests total before adjacent consumer suites.
