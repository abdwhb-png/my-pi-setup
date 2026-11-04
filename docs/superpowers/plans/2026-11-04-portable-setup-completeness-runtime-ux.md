# Portable Setup Completeness and Runtime UX

## Goal and constraints

Deliver versioned runtime resources completely, preserve machine-local connection configuration, select notifications from available session capabilities, and retain footer statuses when one message overflows. Work directly on the harness `develop` branch. Isolate the minimal footer correction on its existing integration branch, preserving the dirty development checkout. Do not modify pi-core, activate packages, push, publish, install host dependencies, or update the VPS in this implementation.

## Implementation checklist

- [x] Extend the existing distribution policy with explicit code, preference, local and development dispositions. Reject unclassified versioned resources before packing and early in CI. Include versioned roles recursively.
- [x] Keep mcp.json, mcp-adapter.json and models.json local. Preserve existing modified, deleted and symlinked files through update and rollback, accept legacy archives without restoring their connection files, and expose the transfer in previews.
- [x] Automatically choose an available native desktop transport, compatible terminal OSC 9, terminal bell or no transport. Preserve existing notification controls, add read-only `/notify status`, sanitize terminal payloads, and retain visible unexpected failures with bounded fallback.
- [x] Correct oversized status packing in pi-fancy-footer with a regression for the 173-character leading status at 145 columns and subsequent short statuses. Preserve styling, width limits and visibility.
- [x] Extend installed CI qualification for the committed role catalog, connection-file preservation and composed above-editor footer. Update affected documentation and run focused tests, types and established quality gates.
- [x] Produce scoped, reviewable local commits. Record CI and physical notification boundaries; retain separate authorization for external delivery and activation.

## Validation

Follow RED → GREEN → REFACTOR through real production modules and isolated fixtures. Cover unknown resources, recursive inclusion, legacy migration and rollback, notification capability/failure matrices, ANSI/Unicode footer overflow and existing behavior. Run actual installation and sandbox checks in GitHub Actions after push authorization. CI checks notification selection and bytes, not whether the operating system displays a toast.


## Implementation evidence

- Distribution capture includes versioned roles recursively. The same policy audits committed resources before runtime collection and in an early CI job; exclusions use explicit dispositions rather than inferred prose labels.
- Legacy managed connection files transfer to local ownership before integrity checks. The migration tests cover all three files unchanged, edited, deleted and symlinked through update and rollback, and fresh legacy archives skip their copies. Portable preferences retain credential admission checks.
- Notifications select native, OSC 9, BEL or none from capabilities. Tests cover desktop availability on Linux, macOS, Windows and WSL, supported terminal signatures, uncertain multiplexers, control-character payloads, failure deduplication, fallback and read-only status. Existing lifecycle and disabled-session checks pass.
- Footer integration commit: `14c979fad9a93aa58c7c38fed736fc03a04a429e` on `git-install/pi-1.1.0`. Its 173-character/145-column regression failed before the correction. All 206 owner tests pass, along with strict compilation of the changed files, Oxlint and offline tenzir-ship changelog validation using the existing Python 3.12 interpreter. The dirty development checkout remained byte-identical.
- The setup/notification/shell qualification suite passed 123 tests and skipped the two installed CI-only contracts. The affected post-refactor suite passed 79 tests; the final explicit policy characterization also passes. Agent and CI script typechecks pass, including a separate agent typecheck resolving the committed footer integration instead of the dirty development checkout. Repository lint passes with existing warnings; changed workflow YAML parses and `git diff --check` passes.
- CI now checks the committed role inventory and installed role completion, local connection migration through real provisioning, and above-editor long statuses composed with the compressor widget contract. The compressor contribution fixture exercises the real bridge without starting its backend service. Actual installed tests and sandbox qualification were not run locally.

## Delivery boundary

The footer and setup changes are local commits. The pinned footer commit must be pushed before the setup commits so CI can fetch it. No workflow was dispatched, package activated, provider called, VPS changed, main promotion performed or release published. Installed-profile and physical notification behavior remain unverified until their respective CI and terminal/desktop checks run. Notification backend acceptance cannot guarantee that desktop or terminal settings display or sound an alert.

The personal installed footer package still uses its previous source selection. Before packaging a release that should contain the footer correction, install the reviewed, pushed integration commit through the daily Pi package manager under separate activation authority, then inspect the captured package pin. Changing a CI fixture does not update the personal package snapshot. Keep the existing release source and qualification workflow; do not substitute unqualified local builds.
