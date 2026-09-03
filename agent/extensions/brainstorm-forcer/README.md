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

Commands include `/brainstorm status`, `/brainstorm artifacts`, `/brainstorm review`, adjacent transitions, explicit force transitions, and `/brainstorm stop`. Stopping requests cancellation of the active native verification run by its pi-subagents async run ID before clearing Brainstorm state.

## Controlled research delegation

`brainstorm_delegate_research({ domain, question, sources })` is available only in Discovery and Exploring. It exposes two closed routes:

| Research domain | Agent                |
| --------------- | -------------------- |
| `local-code`    | `brainstorm-scout`   |
| `external`      | `factual-researcher` |

Both run asynchronously through native pi-subagents RPC with fresh context and strict bounded structured output, keeping raw investigation outside the main context. pi-subagents provides normal Fleet visibility, status, transcript, stop, and completion wake behavior. Generic `researcher`, generic `scout`, and direct `subagent` calls remain blocked. Delegated findings are secondary evidence; direct code, tests, runtime output, API responses, or authoritative docs must still support critical empirical claims.

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

## Native pi-subagents integration

`brainstorm_run_verification({ claimIds })` builds one native async workflow through the public pi-subagents event-bus RPC. Verifier leaves start in parallel with fresh context and strict structured-result schemas. The architect leaf starts only after verifier results are available, with those results embedded explicitly in its task.

The pi-subagents capability ceiling restricts verifier agent identities without treating local `@group` aliases as executable tool names. Every child receives a private `tool-groups.policy/1` extension binding containing the exact concrete read-only tools. The child tool-groups extension resolves aliases first, then filters active tools and tool calls through that policy; `structured_output` remains available for the required schema.

pi-subagents owns execution lifecycle, Fleet visibility, progress, transcripts, stop controls, and completion wake behavior. Brainstorm owns claim routing, child tool policy, persisted pending metadata, and terminal EV/RV audit processing. Direct model calls to `subagent` and `subagent_wait` remain blocked; users retain normal pi-subagents controls plus `/brainstorm status` and `/brainstorm stop`.

Pending metadata stores parent session identity, selected claims, and expected workflow keys. A restored active branch reattaches its completion listener to the native async run instead of declaring live work interrupted. No display-only `external-runs` projection or foreground delegation protocol remains.

Only an exact async run ID and expected workflow-key set is accepted. Successful verifier results create secondary `EV-*` plus successful `RV-*`; failed, malformed, or timed-out work creates failure audits and cannot close the gate. If verifier nodes succeeded and only the architect failed, verifier evidence remains credited with bounded advisory-failure metadata.

Reusable RPC transport lives at `agent/extensions/_shared/subagents/rpc-client.ts`. It contains no Brainstorm or SDD policy; other extensions can adopt it independently without importing Brainstorm internals.

## Final Exploring order

1. Capture direct evidence.
2. Record every active claim with routing metadata.
3. Run required structured verification.
4. Wait for terminal EV/RV processing; inspect or cancel only through Brainstorm commands.
5. Ask one dedicated final-choice question.
6. Submit two or three claim-linked approaches.
7. Transition to Presenting.

Artifacts live under `docs/brainstorms/` as immutable revisions. A blocked submission writes nothing. Completion stops after the final design; the user decides whether planning continues.
