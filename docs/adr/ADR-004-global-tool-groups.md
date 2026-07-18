# ADR-004: Resolve Global Tool Groups with Synthetic Placeholders

## Status

Accepted

## Date

2026-07-18

## Context

Pi tool allowlists are repeated across role frontmatter, subagent agent files,
`subagents.agentOverrides`, presets, and extensions that call
`pi.setActiveTools()`. Common sets such as `read, grep, find, ls` are copied in
many places and drift when tools are added or renamed.

Pi exposes no public middleware that rewrites arbitrary tool names before every
consumer. Unknown names passed to `setActiveTools()` are ignored, so a plain
alias would disappear before a later extension could resolve it. Arbitrary
configuration rewriting is also unsafe because a string in another extension's
config may not represent an active-tool list.

The solution must:

- work for tool-activation lists without consumer adoption;
- use `agent/extensions/_shared/config-loader.ts`;
- support nested aliases and simple wildcards;
- avoid Pi core patches and runtime monkeypatches;
- preserve permission enforcement on the concrete tool calls;
- remain reliable when new Pi packages are installed.

## Decision

### 1. Reserve `@name` for tool-group aliases

Global groups are configured in `~/.pi/agent/tool-groups.json`, with an
optional project file at `<cwd>/.pi/tool-groups.json`. The loader retains
`toolGroups.groups` settings support as a compatibility override. Members may
be exact tool names, nested `@group` references, or `*`/`?` wildcard patterns.

The resolver expands depth-first, preserves first occurrence order, removes
duplicates, validates exact names against registered tools, and reports cycles,
missing groups, unknown tools, and unmatched patterns.

### 2. Register aliases as synthetic tools during extension loading

The extension factory synchronously registers one non-executable placeholder
for each configured alias. Placeholders let roles, presets, commands, and other
extensions pass aliases through Pi's normal active-tool API after the registry
exists. They define no prompt guidance and throw if one reaches execution.

A placeholder alone cannot solve an initial CLI allowlist. Current Pi filters
the registry itself by `--tools`, so concrete group members are absent when the
allowlist contains only an alias.

### 3. Defer aliased CLI filtering in the Pi wrapper

When the package is configured, extensions are enabled, and `--tools` or `-t`
contains an alias, the wrapper removes those options before spawning real Pi
and carries the original list in the private
`PI_TOOL_GROUPS_REQUESTED_TOOLS` environment variable. Pi therefore builds the
complete registry before applying the requested list.

At `session_start`, tool-groups resolves that list against the complete
registry. It intersects the result with the tools still active after earlier
startup handlers, so the bridge cannot undo an earlier restriction. The
extension consumes and deletes the private variable at startup. The wrapper
clears inherited bridge state on launches that do not defer a list. It never
defers when `--no-extensions` is present or the package is unavailable.

### 4. Expand at three public lifecycle boundaries

Expansion runs on:

1. `session_start` — applies a wrapper-deferred list and startup aliases;
2. `input` — follows commands or presets that changed active tools;
3. `before_agent_start` — handles earlier handlers at the final boundary.

Results are applied through public `pi.setActiveTools()` with concrete names.
Permission-system runtime gates continue to authorize concrete tool calls.

### 5. Load the package last and maintain that invariant centrally

The local package source is `./extensions/tool-groups` and remains the final
entry in global `packages`. Pi executes lifecycle handlers in extension load
order, so loading last lets the resolver observe earlier toolset changes.

The Pi wrapper pins the entry before every real Pi launch and after successful
package mutation commands. Package-finalizer also repairs drift for direct
binary launches and asks for `/reload` when the current process was already
discovered with stale order. The extension warns if drift remains; it does not
mutate settings itself.

### 6. Limit scope to active-tool lists

The extension does not rewrite arbitrary JSON/YAML, permission policy keys, or
tool arguments. New consumers that call Pi's active-tool API need no adapter.
Configuration with unrelated semantics remains owned by its extension.

## Alternatives Considered

### Per-consumer adapters

- Pros: Uses only explicit application code.
- Cons: Every current and future consumer must import and call the resolver;
  duplication returns.
- Rejected: Violates the global, no-adoption requirement.

### Patch `@earendil-works/pi-coding-agent`

- Pros: A truly central core resolver.
- Cons: Maintains a downstream core patch and release coupling for a harness
  feature that can be implemented with public extension APIs.
- Rejected.

### Runtime monkeypatch of core tool methods

- Pros: Could intercept every `setActiveTools()` call immediately.
- Cons: Depends on non-public module identity and initialization order; fragile
  across Pi upgrades.
- Rejected.

### Recursive arbitrary-config rewriting

- Pros: Replaces matching strings in any config file.
- Cons: Cannot infer whether a string denotes a tool, changes extension-specific
  semantics, and creates security/debugging risks.
- Rejected.

## Consequences

### Positive

- Repeated tool lists become short references such as `@inspect` and `@web`.
- Roles, subagents, CLI allowlists, presets, and extensions use the same runtime
  resolution without importing the implementation.
- Nested composition and wildcards are available without a dependency.
- Misconfiguration is visible and invalid members never become active tools.
- Current migrations are protected by tests that compare resolved concrete
  tool sets against the pre-migration sets.

### Negative

- `@` is reserved for aliases within active-tool lists.
- The package-order invariant and aliased CLI bridge require wrapper maintenance.
- An aliased CLI launch briefly starts with the full registry during extension
  startup, before tool-groups applies the intersected allowlist. No model turn
  occurs in that interval.
- The final `before_agent_start` safety path may rebuild tool schemas after that
  turn's chained system prompt already exists; normal startup/input paths expand
  earlier.
- Changing group configuration requires `/reload` because configuration is read
  when the extension factory is recreated.

### Limitations

- `--no-extensions` disables the resolver and prevents CLI deferral. An absent
  package also prevents deferral. Pi ignores unknown alias entries, so their
  concrete tools are not activated.
- Invoking the real Pi binary directly bypasses wrapper-side CLI deferral.
  Post-start aliases still work if the extension is loaded, but alias-only
  `--tools` lists require the wrapper.
- SDK callers that pass alias-only initial `tools` allowlists need an equivalent
  pre-registry bridge; the extension cannot restore definitions Pi omitted.
- Wildcards support only `*` and `?`; there are no character classes,
  alternation, or negation.
- Permission-policy keys are not group aliases. Permission rules continue to
  target concrete tools.

## Verification

- Pure resolver tests cover exact, nested, wildcard, cycle, missing, unknown,
  ordering, and deduplication behavior.
- Config tests cover settings precedence, legacy fallback, scope merge, and
  malformed entries.
- SDK tests cover real extension loading, deferred startup expansion,
  restriction intersection, and `noExtensions` behavior.
- Wrapper tests cover long/short CLI forms, no-extension safety, argument
  deferral, environment transport, and stale environment removal.
- Migration tests read the dedicated global config and real frontmatter files,
  assert settings contain no duplicate definitions, and verify concrete-set
  equivalence.
- Package-order tests cover string/object entries, equivalent paths,
  idempotency, wrapper integration, and file-backed settings.
