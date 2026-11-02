# Portable development tool discovery implementation plan

Goal: install the portable Pi setup on another Linux/WSL2 x86_64 host without reproducing producer-specific tool paths or requiring mise/dev-tools. The accepted interface and behavior are recorded in [the installation guide](../../portable-setup.md) and [sandbox configuration guide](../../../agent/extensions/sandbox/docs/configuration.md).

## Implementation sequence

1. Add logical tool requirements and a resolver owned by the sandbox, sharing executable metadata analysis and the existing installation schema. Follow RED/GREEN for discovery, refusal of broad roots and missing resources, then characterize link-redirection and optional mise-shim handling.
2. Integrate existing preview/apply/check with explicit rediscovery, local authority reuse, resource revalidation, atomic publication and backups. Preserve legacy explicit profiles and bindings.
3. Integrate resolution before installation activation, including dry runs; preserve local bindings and rollback on changed resources or failed provisioning. Bootstrap must load without installed Pi SDK packages.
4. Qualify real system/direct and mise layouts on Ubuntu and WSL2 in GitHub Actions, with actual sandbox language/tool execution and read-only installation checks. Preserve negative evidence and prepare a new candidate; publication and VPS installation are separate actions.

## Boundaries

Do not install host prerequisites, change project version-selection policy, mutate personal authority on this workstation, activate providers or modify dev-tools. Keep existing uncommitted user changes outside the task. Deterministic fixtures may execute fake external-tool metadata commands locally; real installation and sandbox qualification are CI-only. No new package dependency or engine protocol is required.
