# Machine preferences, provider configuration and Slow Mode

## Changes

The setup operator records delivered JSON profile defaults in installation-state schema version 2. Updates and rollback reapply machine differences while accepting unrelated default changes. Arrays remain atomic; removed customized properties, incompatible types and conflicting package/resource declarations stop before activation. Managed code remains fingerprint-protected. A modified version-1 profile requires the verified installed release as its reference; the operator refuses an unverifiable reference. Reference downloads remain temporary. Authentication, MCP connections, machine authority and memory retain their existing local ownership.

CPA activation and settings now live under `providers.cpa`. Boolean provider declarations, root-level `cpa` and the unused `widgets` setting are rejected. The pure schema is shared by runtime loading and setup preflight. Rules that would silently discard invalid fields are also rejected. The example covers every effective configuration field and the supported standard model metadata. The local provider configuration was converted without printing its contents and passed the new schema.

Slow Mode now uses one content review for write/edit and a serial, cancellable review queue. Disabling the mode, aborting a turn or changing sessions rejects outstanding reviews. Staged files are unique per operation and cleaned on success, rejection or error. Externally edited multi-edit proposals use Pi's native edit validation instead of writing directly. Unsupported UI decisions do not approve a tool.

## Executed local validation

RED tests demonstrated the duplicate write confirmation, the old operator's refusal of any edited profile, the missing nested-provider format and its permissive invalid input handling, a partially discarded model rule, and unsupported UI decisions approving a shell command. Their focused GREEN runs passed after the changes.

The final affected suites passed 393 tests with four explicit integration skips (397 discovered tests). The skips are the installed footer/roles checks, fresh child CLI startup and the native CPA catalog contract; real installed-runtime qualification belongs in GitHub Actions. Tests use temporary profiles and deterministic model playbooks. The full packaging contract also passed alone in approximately four seconds after an earlier concurrent run hit its 20-second timeout.

The broader standard run completed with 5,981 passes, 120 skips and nine failures. One was the newly added partial-model-rule regression observed before its strict validation fix; its later focused run passed. Eight failures remain in unchanged surfaces: the portable-home meta check sees the CI fixture account path, the subagents success fixture references an absent installed entrypoint, four footer tests provide an incomplete API mock, the brainstorm verifier fixture lacks its tool-selection resolver, and the native runtime fixture fails its directory trust checks. Footer/brainstorm and runtime failures were reproduced in separate focused runs. These failures are retained evidence, not a green full-suite result; they were not suppressed or added to an allowlist.

Repository and portability TypeScript checks, lint and ownership checks are recorded separately from runtime qualification. Existing lint warnings are not treated as newly introduced errors.

## CI contracts

The existing portable qualification now runs the Slow Mode regressions and exercises a version-1 installation with edited Pi settings, footer preferences and a CPA endpoint. It verifies reference-based migration, advancing defaults, idempotency, preservation through real update/rollback, and rejection of an incompatible preference with a byte-identical installed tree. The existing Ubuntu and WSL2 system/mise lanes remain the runtime evidence owners. No private publication or paid generation is requested.

## Boundaries

This change does not modify or promote pi-core or Zerobox, publish a release, merge to main, update the VPS or recover its running session. An already orphaned review in an old process is not repaired by changing files on disk. Historical configuration formats are not silently converted, and incompatible rollback formats are refused. The updated bootstrap operator is required to manage schema-version-2 installation state, including after restoring an older installed operator.
