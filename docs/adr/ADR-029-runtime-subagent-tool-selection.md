# ADR-029: Resolve configured subagent tool groups at discovery

## Status

Accepted. Supersedes [ADR-028](ADR-028-generated-subagent-tool-overrides.md).

## Date

2026-10-12

## Context

The startup compiler independently scanned Markdown and generated concrete `agentOverrides.tools` arrays. That duplicated native agent identity, source precedence and scan policies. Group edits required reloading each parent and persisted arrays could outlive their source. The current fork can normalize the effective discovered configuration before existing launch contracts are built, keeping the change away from launcher and recovery code.

## Decision

D1. Add one optional synchronous host batch resolver selected only by global settings. Normalize both cached and uncached effective native discovery after precedence. Clone configurations, preserve provenance, keep raw source caches and `.all` declarations unchanged, and export the effective reader through the existing `./agents` API.

D2. Keep group configuration and expansion in the existing harness addon, importing the shared implementation. Load groups once per batch and re-read on the next delegation. Saved project trust and CLI veto remain authoritative. The public provider supports nested aliases, exact names and literal MCP selectors, and rejects wildcards or invalid groups.

D3. Use actionable native discovery diagnostics carrying accepted identities. Omit affected executable agents on failure, so fresh launches fail closed while persisted descriptors can recover previous concrete tools. Undefined and empty selections retain native meanings. Runtime-registered agents retain concrete selections and are outside this change.

D4. Remove startup settings generation and inactive workflow-definition publication. Preserve workflow visibility gates, capability ceilings, fallback advice and ordinary native tools. Convert the four former mappings into manual native alias overrides through a one-shot fingerprint-checked migration with private field journals.

D5. Publish the Git release as `v0.77.0+fork.1`, with literal manifest version `0.77.0+fork.1`. Keep dependency nodes and Pi core unchanged. The managed clone directory remains repository-based because the package manager does not include the ref in its persistent Git path.

## Consequences

The fork delta is localized to discovery, diagnostics, one host-loader module and an existing API export. Future upstream launch and recovery changes do not need a matching host patch. The loader caches only the callable. New delegations observe group edits immediately, while running and resumed children use persisted selections.

The host path is executable trusted global configuration. Missing or invalid global resolver settings can diagnose project-only effective agents, even though project-only model overrides still ignore user model policy. A provider change requires a parent reload/restart because the callable is cached. Group edits do not.

Migration is atomic per file, with explicit partial-publication evidence. Rollback compares journaled fields and retains unrelated subsequent edits. Existing parent sessions must reload or restart after package cutover. Deterministic SDK/MCP qualification does not prove real provider availability or every personal MCP server.
