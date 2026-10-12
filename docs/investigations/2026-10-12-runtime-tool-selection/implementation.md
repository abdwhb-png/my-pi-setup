# Runtime tool selection

## Approved decisions

D1. Resolve configured Markdown and builtin agent selections after native discovery and override precedence. Keep runtime-registered agents on concrete tool lists. Do not change launchers, the runtime registry, serialization or resume.

D2. Let the harness own group configuration and alias expansion. The fork reads a global `subagents.toolSelectionResolver` file path and calls its synchronous batch `resolveTools` export. Project settings cannot choose executable resolver code. User/project model scope remains native. Invalid global resolver settings produce agent diagnostics even for project-only discovery.

D3. Publish package version `0.77.0+fork.1` under annotated Git tag `v0.77.0+fork.1`. Preserve historical tags. Install the Git source through the daily Pi CLI, which replaces the old ref for the same repository.

D4. Re-read groups once per discovery batch. New delegations see edits immediately. Running children and resumes retain persisted concrete tools, including MCP selectors. Resolver failures omit affected executable configurations and preserve native diagnostics, raw declaration views and descriptor-based recovery.

D5. Replace the addon startup compiler and writer with a one-shot ownership migration. Retain the four explicit mappings as manual alias overrides under native priority. Preserve models, thinking, budgets, unknown fields, personal definitions and active-session data. Do not promote Pi core.

## Ownership and fork surface

The fork adds `src/agents/host-tool-selection.ts`, two normalization calls in `src/agents/agents.ts`, accepted diagnostic names, and exports the effective reader and resolver types through the existing `./agents` API. Normalization clones configurations and preserves frontmatter metadata. Source caches and `.all` declarations retain raw selections. Empty lists and inheritance do not require a resolver.

The provider is `agent/extensions/pi-subagents-addons/tool-selection.ts`, with a declared package export. It imports the real shared tool-group configuration and resolver. Jiti disables filesystem and module caches for provider TypeScript. The published Pi SDK is a native module to avoid retranspiling the SDK graph. Only the loaded callable is cached by canonical provider path. No group configuration, effective permissions or session policy is cached.

The harness common subagents boundary resolves the configured package's public effective reader. The overview consumes those tools. Brainstorm and SDD no longer publish inactive definitions for startup compilation. Their acquisition/release visibility gates remain intact. The obsolete compiler and runtime settings writer are removed.

## Migration and release sequence

R1. Qualify source and candidate package with temporary fixtures, deterministic providers and the real Pi SDK/runtime boundary. Preserve daily state during qualification.

R2. Inventory affected global/project settings and verify ownership fingerprints. Preview field changes. Save a private journal before atomic per-file publication. Conflicts stop preparation. A partial publication is reported with its published targets.

R3. Commit functional fork changes separately from literal version metadata. Update only root package/lock version fields. Build and verify the full version. Publish the feature branch and immutable annotated release tag. Verify its remote target.

R4. Preserve active user work and coordinate daily cutover. Publish harness changes, apply the ownership migration and install the Git tag using the daily CLI. Verify one configured source, concrete clone SHA, manifest version, public exports, import link and installed-root runtime qualification. Existing parents need reload/restart.

R5. Roll back with the prior Git tag and the field journal. Restore only matching migration postimages. Preserve subsequent model or unrelated edits. Never restore a whole stale settings file.

## Validation record

The fork focused discovery/override suite passed 80 tests. The controlled RPC, nested-control and lifecycle suite passed 87 tests after host dependencies were moved off the status-reader cold import path. Source and package build typechecks passed. The new source files pass scoped lint. Existing `agents.ts` lint reports 281 diagnostics, identical in rule/message counts to the original checkout.

The complete first unit run reported 3,992 passes, 10 failures and 16 skips. One scoped-settings expectation was updated to the approved global resolver contract. The six timing failures pass in the 87-test isolated rerun. Three package-eject/disable and Git-root memory failures reproduce on the original checkout and remain outside this change.

The controlled complete integration run reported 1,200 passes, one startup-timeout failure and seven skips. The timeout case subsequently passed on both the original and candidate checkouts in isolation, at approximately three seconds. The first heavily concurrent integration run was stopped after its assertions finished because a test process retained handles. It is not a green release gate.

The full harness typecheck passes. The focused migration/fixture tooling typecheck passes. Import boundaries pass without allowlists or classifier changes. Focused addon, group, SDK, reader, visibility and migration tests pass. Overview print projection is checked through the real extension factory and command boundary, including a qualified agent name and resolved tools. Routine lint retains warnings for sequential lock acquisition and existing harness code.

The built `0.77.0+fork.1` package passed deterministic native qualification for preflight, direct builtin delegation, foreground, async, workflow, configured nested children and resume after group edits and provider deletion. Each child contract includes an explicitly loaded child-only tool and excludes `write`. Native MCP uses a real isolated local server. This proves the tested boundaries, not real OAuth/model availability or every personal MCP server.

Daily cutover provenance and protected-state verification are recorded after installation. No Pi core promotion is part of this work.
