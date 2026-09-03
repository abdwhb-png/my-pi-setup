# ADR-021: Use native pi-subagents lifecycle for Brainstorm delegation

## Status

Accepted

## Date

2026-08-07

## Context

[ADR-008](./ADR-008-domain-routed-asynchronous-brainstorm-verification.md) and [ADR-009](./ADR-009-scoped-brainstorm-verification-control.md) preserved Brainstorm ownership by launching foreground structured delegations and projecting them into Fleet through `pi-subagents/external-runs`.

That duplicated only part of pi-subagents lifecycle. Fleet entries were observational, not native runs, so normal progress, transcript, stop, completion, and wake behavior did not consistently reach users. Brainstorm could report that verification started or completed without exposing useful native execution state.

Brainstorm still needs closed agent routing, including `local-code` to `brainstorm-scout`, read-only child tool policy, structured output validation, persisted claim scope, and EV/RV auditing. Those are Brainstorm policy, not process lifecycle.

Tool-group aliases such as `@inspect` are selectors owned by the harness, not executable tool names understood by pi-subagents capability ceilings. Applying a concrete `allowedTools` ceiling before alias expansion removes those selectors and can leave a verifier with only the internal `structured_output` tool.

## Decision

Launch delegated research and verification through public in-process pi-subagents RPC `spawn`. Keep launches asynchronous.

- Research launches one configured agent with fresh context and a strict output schema.
- Verification launches one native workflow. Verifier nodes run through `runs.all`; the optional architect runs through `runs.run` only after verifier outputs are available.
- pi-subagents owns execution, Fleet visibility, progress, transcripts, stop controls, completion notification, and parent wake behavior.
- Brainstorm listens to `subagent:async-complete` only to validate exact run/workflow-key ownership and commit EV/RV audit records.
- `/brainstorm stop` requests native run cancellation through RPC `stop`. Extension shutdown does not cancel package-owned async work.
- Restoring the same branch reattaches Brainstorm's completion listener to persisted run ID and expected workflow keys. Invalid branch ownership or missing ledger references remains quarantined.
- The pi-subagents capability ceiling restricts canonical verifier agent names and keeps provider extensions loadable. It does not carry tool-group aliases.
- Each verification leaf receives a private `tool-groups.policy/1` extension binding with the exact concrete read-only tools plus `structured_output`.
- The child tool-groups extension resolves the agent's aliases, intersects the result with that binding, and enforces the same set at `tool_call`. Malformed policy data fails closed.

Place transport in `agent/extensions/_shared/subagents/rpc-client.ts`. Client validates request/reply correlation, timeout, abort, disposal, and async completion envelopes. It contains no Brainstorm or SDD policy. Other extensions may adopt it independently; this change does not migrate `sdd-orchestrator`.

The model-facing Brainstorm tools remain the only creation surface. Direct model calls to generic `subagent` and `subagent_wait` remain blocked during Exploring because route and claim policy must stay deterministic. This restriction does not replace or hide native user-visible pi-subagents lifecycle.

## Alternatives Considered

### Keep foreground delegation plus external Fleet projection

Rejected. It reproduces display state but not native lifecycle controls or completion behavior.

### Reimplement Fleet, progress, transcript, and wake behavior in Brainstorm

Rejected. pi-subagents already owns those contracts. A second implementation would drift and split run authority.

### Expose generic subagent creation to the brainstorming model

Rejected. It would let the model bypass closed routing, selected claim scope, and read-only capability policy.

### Teach pi-subagents about harness tool-group aliases

Rejected. Capability ceilings intentionally operate on concrete executable names. Making pi-subagents depend on a harness-specific selector syntax would blur that security boundary and still require child-side expansion.

### Duplicate concrete tool lists in verifier agent files

Rejected. It would bypass shared tool groups and let agent declarations drift from `tool-groups.json`.

### Migrate SDD in the same change

Rejected. Shared transport is ready for reuse, but SDD migration needs separate compatibility and persistence analysis.

## Consequences

Users see Brainstorm child work through normal pi-subagents Fleet and completion surfaces. Run IDs are native async IDs, so native status, transcript, and stop controls target real work.

Brainstorm code becomes smaller at the lifecycle boundary but still owns terminal audit transactions. Reload recovery depends on exact persisted run and workflow-key metadata; malformed or wrong-branch state remains fail-closed.

ADR-008's closed routing, structured validation, EV/RV records, architect scope, and final-choice ordering remain active. ADR-009's branch ownership and quarantine rules remain active. Their foreground delegation, lifecycle-artifact, display-only external-run, and Brainstorm-owned control mechanics are superseded by this ADR.
