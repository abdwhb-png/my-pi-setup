# ADR-028: Generate subagent tool overrides before upstream startup

## Status

Accepted. The operator separately approved the daily package/MCP cutover, completed and verified on 2026-09-28.

## Date

2026-09-28

## Context

Agent Markdown uses shared `@group` tool selections. The active-tool expansion in [ADR-004](ADR-004-global-tool-groups.md) runs too late for SDK children whose initial registry already excludes concrete tools. It cannot restore definitions omitted by initial filtering.

The unpublished `pi-subagents/tool-selection` hook solved that timing locally but requires changes across upstream launch and recovery paths. Upstream PR #2489 was closed for scope reasons. The official 0.73.1 package already applies ordinary `subagents.agentOverrides.tools` before constructing child contracts, including Markdown agents. A trusted project's overrides take precedence over global settings. These existing interfaces can express the required selection without a new upstream hook or replacement runner.

Pi owns tool-group declarations; upstream owns final discovery, launch contracts, restrictions, MCP, execution, and recovery. The integration must preserve existing permissions, model choices, manual settings, and workflow-agent visibility.

## Decision

Extend the existing `pi-subagents-addons` owner, not the generic tool-groups extension. Keep declarative agent frontmatter unchanged and compile concrete overrides at parent startup and `/reload`.

- `tool-group-overrides.ts` reads only declared flat Markdown directories, parses frontmatter through Pi's public API, and reuses the shared group resolver. It returns separate global and trusted-project snapshots without writing files. Explicit `agentTools` mappings retain four existing permission sets that frontmatter alone does not express.
- `generated-tool-settings.ts` owns persistence: exact-value adoption, ownership fingerprints, conflict detection, deletion cleanup, Pi-compatible `proper-lockfile` locks, fresh reads, and atomic replacement per settings file. It never owns models, budgets, thinking, or unrelated configuration.
- The addon entrypoint installs a public `allowedAgents: []` ceiling before synchronization, releasing it only on success. Pi catches lifecycle exceptions, so an exception or UI error alone would not prevent launches. Explicit global extension loading places this handler before upstream startup; canonical-path deduplication avoids double registration. Child processes marked `PI_SUBAGENT_CHILD=1` do not synchronize settings.
- Brainstorm and SDD publish their existing definitions through the session event bus during registration. The addon compiles these definitions without activating agents or creating new Markdown. Existing acquisition/release behavior still owns visibility. No imports of sibling extension internals are added.

Global output depends only on global data. Trusted-project output uses the existing shared settings/legacy precedence and goes only into that project's `.pi/settings.json`. An omitted project tool selection can use upstream's `"inherit"` to neutralize a lower generated selection. Explicit name mappings remain higher priority than frontmatter.

Version 1 supports nested aliases and exact tool/MCP selectors. It rejects wildcards, ambiguous identities, unsafe roots/symlinks, provider-dependent tool selection, unsupported runners, and alternate discovery policies instead of approximating upstream's scanner. A new source directory must be declared explicitly. No watchers, per-launch compilation, or initialization of unrelated worktrees are introduced.

## Alternatives considered

### Extend the existing active-tool resolver alone

Preserves one runtime integration, but its activation boundary follows SDK registry filtering. Useful for the consumers covered by ADR-004; insufficient for an alias-only initial child allowlist. The shared resolver implementation is still reused.

### Retain the unpublished upstream hook

Technically viable in the local fork, but couples this Pi feature to upstream launch and persisted recovery internals. Rejected for daily integration after upstream declined the contribution. Historical commits remain preserved; no claim that a hook is technically impossible.

### Replace configured agents with runtime-registered agents

Public registration exists, but it does not transparently preserve configured and built-in identities, override precedence, discovery, and recovery. Rejected because it changes more than tool selection.

### Generate ordinary overrides in the existing addon — chosen

Uses the upstream input already consumed before filtering and keeps upstream execution unmodified. The cost is bounded declaration discovery, persisted ownership, and explicit reload semantics. These costs remain local to Pi rather than creating an additional runner or universal discovery framework.

## Consequences

Markdown and group definitions remain the declarative source. Exact MCP and child-only extension selectors survive compilation; upstream continues to enforce availability, exclusions, and ceilings. Existing unowned `tools` fields are never silently adopted, including equal values. Manual edits to generated output stop synchronization until explicitly resolved.

Publication is atomic per file, not across global/project settings. A later publication failure is reported, keeps the parent blocked, and allows an idempotent retry. Locks coordinate cooperating writers only; the final comparison cannot eliminate every race with a noncooperative editor.

Snapshots change at startup/reload. Other active sessions are not instantly synchronized. A resumed child retains its persisted concrete launch contract even if groups have changed. Disabling generation does not remove persisted overrides; rollback requires ownership-checked cleanup and restoration of only the reviewed fields.

The isolated pairing is official `pi-subagents@0.73.1` with `pi-mcp-adapter@3.0.0`. Adapter 3.1.0 changes stdio cache hashing incompatibly with this subagents version; HTTP compatibility does not qualify that transport. Adapter 3.0.0's missing 3.1.0 fixes and the `mcp.json` to `mcp-adapter.json` migration are explicit daily-cutover trade-offs, not hidden patches. Parent Pi/addon remain under Bun; the official npm async runner's Node execution is explicitly approved.

This decision supplements ADR-004 for pre-registry SDK selection and preserves [ADR-027](ADR-027-official-pi-subagents-parent-fallback-advice.md)'s request-local, advice-only fallback. It replaces the unpublished tool-selection bridge, not fallback behavior or upstream child lifecycle.

## Verification and rollout boundary

Focused tests cover compilation, scoped precedence, workflow publication, ownership, concurrent writers, partial publication, and launch denial. The promoted public CLI proves actual native/extension tool execution, rejected tools, detached local MCP execution, public interruption/reload/resume, and retained historical permissions; its final run has 94 assertions. SDK and official MCP transport checks also pass. No private entrypoint or child-session factory replacement is used for qualification.

Targeted diagnostics, formatting, lint, and ownership-boundary checks pass without errors. The worktree-wide TypeScript check remains failed with 22 errors outside the changed files, including incomplete dependency provisioning and an already documented adapter mismatch. This is recorded as a validation limitation, not a successful global check or permission to repair other extensions. The operator authorized proceeding on this basis.

Daily adoption was separately authorized and completed with fresh verified backups, exact adoption of four existing selections, one pinned subagents source, and byte-preserving global/project MCP renames. The daily smoke passed 94 runtime assertions plus seven package-provenance assertions; MCP contracts passed 16 tests/110 assertions plus the parent check, and runtime coherence passed. Personal OAuth and remote servers were not exercised. Open sessions must restart before resuming work; contribution checkouts cannot move while active sessions retain their old modules. No commit, push, upstream patch, or backup deletion follows from this ADR.

See the [addon README](../../agent/extensions/pi-subagents-addons/README.md) for configuration, supported scope, and rollback.
