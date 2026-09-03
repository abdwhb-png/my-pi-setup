# Tool Groups Extension

Group tool names under `@` aliases so roles, agents, subagents, CLI tool
allowlists, presets, and extensions can reuse compact tool sets.

## How It Works

Register groups in `toolGroups.groups` or the legacy `tool-groups.json`
fallback. Each group maps to an ordered list of exact tools, nested `@group`
references, or glob patterns.

The extension expands aliases in the active tool set during `session_start`,
`input`, and `before_agent_start`. Concrete members replace the aliases before
the model can call tools. When `pi-roles` publishes `pi-roles:tool-policy`, the
extension keeps that policy sticky across late tool registration and blocks
out-of-policy calls at `tool_call`.

For an aliased CLI `--tools` or `-t` list, the Pi wrapper defers filtering until
`session_start`. This keeps the complete registry available for nested groups
and globs, then applies the resolved list before the first model turn.

## Configuration

### Primary: `tool-groups.json`

Global definitions live in `~/.pi/agent/tool-groups.json`:

```json
{
    "groups": {
        "inspect": ["read", "grep", "find", "ls"],
        "web": ["web_search", "fetch_content", "get_search_content"],
        "docs": ["mcp:context7", "mcp:deepwiki"],
        "review": ["@inspect", "memory_search", "@docs", "@web"]
    }
}
```

A project may add `<cwd>/.pi/tool-groups.json`. Project groups replace global
groups with the same name.

### Optional settings override

The shared loader still supports `toolGroups.groups` in global or project
settings for compatibility. If that settings key contains normalized data, it
wins and dedicated files are skipped. Keep the key absent when using
`tool-groups.json`.

### Members

- Exact tool, such as `"read"`: included when registered; otherwise emits an
  `unknown-tool` diagnostic.
- Nested group, such as `"@inspect"`: expands recursively. Cycles emit a
  `cycle` diagnostic and do not activate the cyclic reference.
- `*` glob, such as `"mcp:*"`: matches zero or more characters.
- `?` glob, such as `"d?l?te"`: matches one character at each `?`.

Globs match registered concrete tools, not synthetic `@` aliases. A glob that
matches nothing emits `unmatched-pattern`.

Group names must match `/^[a-z][a-z0-9_-]*$/`. Invalid names, invalid member
values, and empty members are discarded during normalization.

### Mutable policy and stable invariants

`agent/tool-groups.json` is the source of truth for user-owned group policy.
Role frontmatter and subagent overrides may change over time without updating a
hardcoded test snapshot. `settings.json` contains no duplicate group definitions.

Migration tests validate only durable contracts: configuration parses, aliases
exist and resolve without cycles, resolutions are non-empty and deduplicated,
the package remains last, and protected read/write boundaries remain intact.
Concrete tool availability is still validated against the live registry at
runtime.

Pi-lens uses two safety tiers:

- `@lens`: read-only AST, LSP, diagnostics, module reports, and targeted reads.
- `@lens-write`: `@lens` plus mutating `ast_grep_replace`.

Assign `@lens` to planners, reviewers, and scouts. Reserve `@lens-write` for
write-capable implementation agents.

File mutation uses two nested capability groups:

- `@files-write`: `edit` and `write`.
- `@implement`: `@files-write` plus `safe_bash`.

Raw `bash`, Hypa tools, and plan-specific tools remain explicit because their
semantics and permissions differ.

## Usage

### Role and agent frontmatter

Use the comma-separated syntax supported by the current role and agent files:

```yaml
---
name: my-agent
tools: '@inspect, @lens-write, @implement'
---
```

`@inspect` resolves to `read, grep, find, ls`. Quote role values that begin
with `@`; unquoted `@` is reserved in YAML. The extension receives active names
after the consumer has parsed its own configuration, so use that consumer's
supported list syntax.

### Subagent override arrays

```json
{
    "subagents": {
        "agentOverrides": {
            "worker": {
                "tools": [
                    "@inspect",
                    "@lens-write",
                    "@implement",
                    "contact_supervisor"
                ]
            }
        }
    }
}
```

## Runtime Behaviour

- Each group registers a non-executable placeholder for active-tool APIs used
  after the registry exists.
- When the package is configured and extensions are enabled, the wrapper
  removes aliased CLI tool options and transports the original list in
  `PI_TOOL_GROUPS_REQUESTED_TOOLS`.
- The extension consumes and deletes the private variable at startup; the
  wrapper also clears inherited stale bridge state for later Pi launches.
- Startup resolves the deferred list against the complete registry and
  intersects it with restrictions made by earlier `session_start` handlers.
- A pi-subagents child may receive a private `tool-groups.policy/1`
  `extensionBindings` entry with concrete `allowedTools`. After alias
  expansion, startup and `tool_call` enforcement intersect active tools with
  that list. Malformed policy data fails closed.
- Calling a placeholder directly throws. It has no prompt guidance.
- Expansion preserves first-occurrence order and removes duplicates.
- Diagnostics are deduplicated by code, group, and member. New diagnostics use
  a UI notification when available and `console.warn` otherwise.
- Expansion is a no-op when the active set contains no `@` alias and no role policy is active.
- Role policies are resolved again before every model turn, removing tools registered asynchronously after `session_start`.
- `tool_call` enforces the same resolved policy, so stale history cannot execute a hidden tool.

Diagnostic codes:

- `cycle`: a recursive group reference was found.
- `missing-group`: an alias references an undefined group.
- `unknown-tool`: an exact member is not registered.
- `unmatched-pattern`: a `*` or `?` member matched no tool.

## Reloading Configuration

After changing settings or `tool-groups.json`, run `/reload`. Configuration is
read when Pi recreates the extension factory. A normal `session_start` expands
the already-loaded configuration but does not read files again.

## Scope

This extension changes active-tool lists and enforces an active `pi-roles` tool allowlist. It does not:

- rewrite arbitrary JSON, YAML, or permission-policy keys;
- change tool behaviour, parameters, or permission checks;
- persist expanded lists back to settings;
- interpret arbitrary strings in other extensions as tool lists.

Permission policies continue to target concrete tool names.

## Package Order

`./extensions/tool-groups` must be the last entry in global `packages`. Pi runs
lifecycle handlers in extension load order, so the resolver must observe
earlier handlers that change active tools.

```json
{
    "packages": [
        "npm:pi-subagents",
        "npm:@gotgenes/pi-permission-system",
        "./extensions/tool-groups"
    ]
}
```

The Pi wrapper pins the package before each real Pi launch and after successful
package mutations. Package-finalizer repairs drift from direct binary use for
the next reload. If the current process still has stale order, startup warns:

```text
[tool-groups] Package order drift detected: tool-groups package is not loaded
last. Run /reload to ensure tool-group configuration is applied correctly.
```

## `--no-extensions`

With `--no-extensions`, or when the package is not configured, the wrapper does
not defer aliased CLI lists. Alias placeholders are unknown, so Pi ignores
those allowlist entries and does not activate their concrete members.

Calling the real Pi binary directly also bypasses wrapper-side CLI deferral.
Post-start aliases still work when the extension is loaded, but alias-only
initial CLI allowlists require the wrapper.

## Implementation Paths

- `bin/pi` and `agent/bin/pi-wrapper-lib.ts`: aliased CLI deferral.
- `agent/extensions/tool-groups/index.ts`: runtime extension.
- `agent/extensions/_shared/tool-groups/`: config, resolver, types, and package
  order helpers.
- `agent/extensions/_shared/config-loader.ts`: settings and legacy cascade.
