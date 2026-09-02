# brainstorm-forcer

Pi extension that runs brainstorming as a controlled, artifact-backed state machine. It produces design artifacts only; planning and implementation remain separate user decisions.

## Workflow

`/brainstorm <prompt>` starts in Discovery. Discovery derives a concise canonical `topic` after minimum research; first submission fixes `docs/brainstorms/YYYY-MM-DD-<topic>/`. Opening prompt no longer names normal artifact roots. Existing roots are never renamed.

Every phase requires a complete structured artifact and only adjacent LLM transitions are accepted. Generic mutation, shell, planning, `subagent`, and `subagent_wait` calls are blocked. Exploring recommendations are gated by append-only evidence, claims, verification audits, waivers, and final user-choice provenance.

Phase tools:

1. Discovery — `brainstorm_delegate_research`, `brainstorm_submit_discovery`
2. Understanding — `brainstorm_submit_understanding`
3. Exploring — `brainstorm_delegate_research`, `brainstorm_record_claim`, `brainstorm_run_verification`, `brainstorm_request_waiver`, `brainstorm_submit_exploring`
4. Presenting — `brainstorm_submit_presenting`
5. Documenting — `brainstorm_submit_design`

Commands include `/brainstorm status`, `/brainstorm artifacts`, `/brainstorm review`, adjacent transitions, explicit force transitions, and `/brainstorm stop`. Stopping cancels every active structured delegation attempt by its exact `{requestId, ownerRunId, nodeId}` tuple before clearing state.

## Controlled research delegation

`brainstorm_delegate_research({ domain, question, sources })` is available only in Discovery and Exploring. It exposes two closed routes:

| Research domain | Agent                |
| --------------- | -------------------- |
| `local-code`    | `brainstorm-scout`   |
| `external`      | `factual-researcher` |

Both run with fresh context and strict bounded structured output, keeping raw investigation outside the main context. Generic `researcher`, generic `scout`, and direct `subagent` calls remain blocked. Delegated findings are secondary evidence; direct code, tests, runtime output, API responses, or authoritative docs must still support critical empirical claims.

`brainstorm-scout` is the only Brainstorm-specific local agent. One refcounted workflow gate creates its shared definition while Brainstorm is active and removes it when the last active run releases. Like the SDD gate, the shared file can be visible to another process during that lease and an abrupt process kill can leave a stale file.

## Evidence-gated Exploring

Allowed non-workflow and delegated-research tool results become bounded, redacted `EV-*` records. Claims are `CL-*`, verification audits are `RV-*`, waivers are `WV-*`, and explicit force overrides are `OV-*`.

`brainstorm_record_claim` requires a closed verification domain and an `architectureImpact` decision. Critical claims still require fresh direct evidence; secondary verifier output never replaces it.

The closed verifier routes are:

| Domain        | Agent                  |
| ------------- | ---------------------- |
| `pi`          | `pi-expert`            |
| `local-code`  | `brainstorm-scout`     |
| `external`    | `factual-researcher`   |
| `performance` | `performance-reviewer` |

`architect` is added only for the exact architecture-impacting claim scope. Its `clear`, `watch`, and `block` result is advisory and does not replace verifier evidence.

## pi-subagents 0.50 integration

`brainstorm_run_verification({ claimIds })` builds a deterministic node plan and uses the public `pi-subagents/delegation` boundary. Verifier leaves start in parallel with fresh context and strict structured-result schemas. The architect leaf starts only after verifier results are available, with those results embedded explicitly in its task.

The coordinator owns lifecycle, cancellation, and audit processing. It publishes a display-only current-session entry through `pi-subagents/external-runs`, so native FleetView can show progress without gaining control of the run. Direct `subagent` and `subagent_wait` management remains blocked; use `/brainstorm status` or `/brainstorm stop`.

Pending metadata stores the parent session identity, selected claims, and expected nodes. Foreground leaves cannot survive an extension-context reload, so a restored pending run is audited as interrupted and cleared. There is no RPC status polling, terminal scraping, lifecycle-v3 artifact dependency, or legacy top-level `chain`, `tasks`, or `parallel` payload.

Only an exact correlated structured response is accepted. Successful verifier results create secondary `EV-*` plus successful `RV-*`; failed, malformed, interrupted, or timed-out work creates failure audits and cannot close the gate. If verifier nodes succeeded and only the architect failed, verifier evidence remains credited with bounded advisory-failure metadata.

## Final Exploring order

1. Capture direct evidence.
2. Record every active claim with routing metadata.
3. Run required structured verification.
4. Wait for terminal EV/RV processing; inspect or cancel only through Brainstorm commands.
5. Ask one dedicated final-choice question.
6. Submit two or three claim-linked approaches.
7. Transition to Presenting.

Artifacts live under `docs/brainstorms/` as immutable revisions. A blocked submission writes nothing. Completion stops after the final design; the user decides whether planning continues.
