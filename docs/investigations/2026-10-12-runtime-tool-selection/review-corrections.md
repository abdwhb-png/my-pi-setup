# Runtime Tool Selection Review Corrections

## Scope

This follow-up addresses F1–F4 from [the independent review](review.md), updates the stale addon README introduction, and retains the approved discovery/provider boundary. Source changes are based on fork commit `51799a79183170cde54ee9860491af860b97177b` and harness commit `40f62f2eb2fe4570b053d462894089a39e940f14`.

## Corrections

F1. Native name resolution and blocking diagnostics share canonical, local and alias match precedence. Source priority applies within the selected match tier. Invalid package declarations with no computed runtime identity retain their original fail-closed handling. Public-preflight tests cover qualified/local and alias collisions, plus a failed canonical identity competing with a higher-source-priority healthy alias.

F2. The host captures batch cardinality before calling provider code, materializes result and selector arrays, validates sparse entries, and builds failure batches using the original cardinality. Sparse batches, sparse selectors and request mutation, including mutation before throwing, now produce agent diagnostics through discovery and public preflight.

F3. Overview projections retain native diagnostic text and qualified identities by definition file. Rejected declarations display an explicit unavailable state in print output and interactive details, rather than appearing as valid empty selections. Unavailable user declarations remain visible in the compact overview. Legitimate empty selections retain their existing tools display.

F4. The provider constructs one concrete membership index per batch. The existing shared resolver accepts that index as well as arrays and performs constant-time exact membership checks. Policy reads remain fresh, output ordering and diagnostics are preserved, and per-agent exact tools do not leak into other agents' selections. No compiled permission cache was added.

The README now describes runtime resolution and the managed Git fork. The project-owner fixture delegates to the real public native reader and declares its required `./agents` export. Its prior missing-export failure was reproduced on the original harness commit. The qualification fixture validates resumed run identities as nonempty strings instead of stringifying arbitrary values.

## Validation

The production behavior changes followed RED → GREEN with real module imports and public-boundary assertions. The provider optimization also began with passing batch-isolation characterization coverage. The source discovery, management, name-resolution and preflight suite passed 126 tests. The independent three-case review reproduction now passes.

The complete fork unit run completed 4,028 tests: 4,009 passed, 16 skipped and three failed. All three failures reproduce on the original fork commit: package-agent eject/disable precedence fixtures and the linked-worktree Git-root fixture affected by an existing ancestor project configuration. The two invalid-package regressions found during the first correction run were fixed and their existing assertions retained.

The harness's focused group, addon and overview suite passed 200 tests with five optional skips. Full harness and fork typechecks passed, as did the focused qualification tooling typecheck. Harness lint and import-boundary checks passed with existing warnings. The fork's changed-file lint contains the same 281 rule/message diagnostics as the original commit, without additional diagnostics. Formatting and whitespace checks passed for the task files.

On three alternating synthetic benchmark pairs with 200 selections and 5,000 configured group members, warm provider medians improved from 331–427 ms to 6–11 ms. These isolated measurements validate the large-policy optimization rather than real-session latency or provider availability.

The complete sequential fork integration suite passed 1,201 tests with seven skips and zero failures. The candidate build preserves literal version `0.77.0+fork.2` and its compiled public export shapes. Only the two root lockfile version fields changed, and all dependency nodes remain identical.

Both the built candidate and the actual installed Git clone passed the seven deterministic native paths: preflight, direct builtin delegation, foreground, async, workflow, configured nested delegation, and resume after group edits and provider deletion. The installed clone also passed all 22 host-selection regression tests. Live effective discovery returned 36 agents, zero diagnostics and zero unresolved aliases. The full harness typecheck passed again against the installed package.

These checks use deterministic providers and an isolated local MCP server. They do not prove real remote model availability or every personal MCP server. The independent review verdict remains a historical assessment of its frozen baseline, rather than a new independent approval of the corrective release.

## Delivery and Preservation

The fork functional correction is commit `b68db532`; literal version metadata is commit `b4657e7ed8e37959888a22dbcad3dfde48a07fba`. The source feature branch and annotated tag `v0.77.0+fork.2` were published atomically, and the remote peeled tag target was verified before installation. The previous tag remains unchanged.

The daily Pi CLI installed `git:github.com/abdwhb-png/pi-subagents@v0.77.0+fork.2` using the existing `sfw -- bun` package command. Exact official registry metadata for the base release and declared runtime dependencies was checked immediately before installation. The installed clone SHA, full manifest version, single configured source and bare-import link match the release. [Corrective Release Provenance](corrective-release.json) records the installed result.

The package declaration is the only changed settings field. Unrelated package entries, model/thinking/tool/budget settings, unknown fields and project settings are preserved. All 19 protected definition/prompt files remain byte-identical. Private pre-cutover backups are under `~/engineering/pi-integrations/.backups/pi-subagents/20261012T154255Z-tool-selection-fixes/`. No ownership migration was rerun.

`pi-fork verify` confirms the unchanged promoted core release `1.1.0-00c5e7e300ba-dirty-79f8bc0b6a58`. Existing Pi parent sessions should restart to load the corrective code. No active user session was stopped or restarted. Rollback uses the prior Git tag `v0.77.0+fork.1` and the matching prior harness commit. No stale whole-settings snapshot should be restored over later edits.
