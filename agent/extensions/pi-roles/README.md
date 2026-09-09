# Integrated pi-roles extension

`pi-roles` changes the model, reasoning level, active tool schemas, and system-prompt layer of the current top-level Pi session. It is integrated into this harness and auto-discovered from `agent/extensions/pi-roles/index.ts`; it is not installed or published as a separate package here.

The root factory registers the core first and the role-aware features second. Other extensions import cross-extension contracts only from:

```ts
import {
    getActiveRole,
    requestRoleSwitch,
    registerRoleTransitionPolicy,
} from '../_shared/pi-roles/index.ts';
```

## Roles

Roles are Markdown files with YAML frontmatter:

```md
---
name: reviewer
description: Review changes without editing them
model: openai/gpt-5.5
thinking: high
tools: read, grep, find, ls
extends: base-reviewer
handoffGuard: review-complete
---

Review the requested changes and report concrete findings.
```

The filename must match `name`. Supported fields are `name`, `description`, `model`, `thinking`, `tools`, `intercom`, `extends`, and `handoffGuard`.

Tool semantics are tri-state:

- Missing or null `tools`: inherit the current or parent tool policy.
- Empty `tools: ""`: expose no tools.
- A comma-separated list: expose only those tools. Named aliases such as `@inspect` are resolved by `tool-groups`.

Discovery order is project, user, then built-in:

1. `<project>/.pi/roles/*.md`
2. `~/.pi/agent/roles/*.md`
3. `agent/extensions/pi-roles/resources/roles/*.md`

The first role with a given name wins. The integrated extension ships `pi-agent` and `role-assistant`.

## Commands and tool

- `/role` or `/role list`: list discovered roles.
- `/role current`: show the active role.
- `/role reload`: reload role files and reapply the current role.
- `/role <name>`: switch without clearing conversation history.
- `/role <name> --reset`: start a new session under the role.
- `switch_role`: LLM-callable equivalent of `/role <name>`.
- `/abandon-plan`: feature-owned escape from a guarded plan workflow.

Startup precedence is pending reset, `--role`, `PI_ROLE`, `settings.json["pi-roles"].defaultRole`, then built-in `pi-agent`.

## Settings

User settings live in `~/.pi/agent/settings.json`; project settings live in the nearest `.pi/settings.json`. Project fields override user fields.

```json
{
    "pi-roles": {
        "roleScope": "both",
        "defaultRole": "pi-agent",
        "systemPromptMode": "strict-additive",
        "intercomMode": "off",
        "warnOnMissingMcp": true,
        "showStatus": true,
        "showWidget": true
    }
}
```

`systemPromptMode` controls how a role body composes with Pi's base prompt. `enableSystemPromptAppend` remains accepted as the compatibility setting. A role may override the global intercom mode.

## Runtime contracts

Persistent identifiers remain stable:

- `pi-roles:active-role`
- `pi-roles:switch-request`
- `pi-roles:switch-processed`
- `pi-roles:notification`
- `pi-roles:tool-policy`

`pi-roles:tool-policy` carries the effective role allowlist. `tool-groups` consumes it to keep the active LLM schemas aligned with the role and to retain execution-time enforcement.

When a custom `SYSTEM.md` is active, function schemas are the only source of truth for available tools. The context extension does not append a textual `Available tools:` section. `/context` reads the current runtime set through `pi.getActiveTools()`.

## Integrated features

The same factory owns:

- Plannotator approval auto-switch from a planning role to the configured default role.
- Plan submission and persistence guards.
- Prompt-triggered role switching.
- Role-aware subagent routing and Atlas integration.
- Revision lifecycle handling.

These modules live under `features/`; they are not separately auto-discovered extensions.

## Development

Run focused tests from `agent/`:

```sh
bun test --isolate extensions/_shared/pi-roles/**/*.test.ts extensions/pi-roles/**/*.test.ts
```

The shared layer must never import from the integrated extension. Core, features, and external consumers depend on `extensions/_shared/pi-roles/index.ts`.
