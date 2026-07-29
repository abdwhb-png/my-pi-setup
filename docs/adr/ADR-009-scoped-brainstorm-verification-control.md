# ADR-009: Scoped brainstorm verification control

## Status

Accepted

## Date

2026-07-29

## Context

[ADR-008](./ADR-008-domain-routed-asynchronous-brainstorm-verification.md)
made `brainstorm_run_verification` the only model-facing creation surface for
an owned asynchronous verification run. It blocked direct generic `subagent`
execution during Exploring and correlated terminal completion through durable
ownership state.

A run can legitimately enter pi-subagents' `needs attention` lifecycle state.
The existing policy allowed `subagent_wait` to observe that state but blocked
the public `subagent` tool's `status`, `steer`, `resume`, `interrupt`, and
`stop` controls needed to resolve it. Verification then remained pending, and
the final `ask_user_question` call could occur before terminal verification was
audited.

The installed pi-subagents 0.37.2 public `subagent` tool schema supports these
lifecycle actions. Its RPC v1 surface separately provides `ping`, `spawn`, and
`status` for owned launch and reconciliation. The public tool also exposes
broad target aliases, transcript/fleet fields, and execution payloads that
brainstorm-forcer must not accept. Control results are lifecycle state, not
decision evidence; capturing them as `EV-*` would pollute the Exploring ledger.

## Decision

### Keep one creation surface

`brainstorm_run_verification` remains the only way to create a verification
run. Generic `subagent` spawn and execution remain blocked in every phase,
including Exploring. Brainstorm-forcer does not modify, fork, or patch
pi-subagents.

### Permit only owned pending lifecycle control

During Exploring, allow a `subagent` tool call only when durable
`pendingVerification` exists and the call targets exactly
`pendingVerification.runId` through the `id` field.

The action-specific allowlist is:

| Action      | Exact accepted fields                        |
| ----------- | -------------------------------------------- |
| `status`    | `action`, `id`                               |
| `steer`     | `action`, `id`, non-empty `message`, `index` |
| `resume`    | `action`, `id`, non-empty `message`, `index` |
| `interrupt` | `action`, `id`                               |
| `stop`      | `action`, `id`                               |

`index` is optional for `steer` and `resume`. When supplied, it must be an
integer greater than or equal to zero and less than the persisted number of
expected verification steps. It is rejected for every other action.

Reject the call with a precise reason when:

- no owned verification is pending;
- the action is missing, unknown, or outside the five-action allowlist;
- `id` does not equal the owned pending run ID;
- the alternate `runId` alias or `dir` is supplied;
- `index` is unsupported, non-integral, negative, or out of scope;
- a required `message` is absent or blank;
- any spawn or execution field is supplied, including `agent`, `task`,
  `tasks`, `chain`, `parallel`, or `async`;
- any other field is not in the selected action's exact allowlist.

The hook evaluates the public `tool_call` event's `input`; it does not infer
intent from prose or a package-internal type.

### Bound needs-attention recovery

`needs_attention` is a nonterminal, latched activity signal. A
`subagent_wait.timeoutMs` value is an upper bound, not a minimum sleep: once
attention is latched, another wait may return immediately. The model may use at
most one owned wait and one owned steer per pending verification run.

The extension captures only the public typed steer result. When it reports an
exact owned `pending` request with routed targets, branch-local recovery state
is persisted. From that point, only exact owned `status` remains available to
the model. Repeated wait/steer, resume, interrupt, stop, and replacement launch
are blocked. Status prose is never parsed to infer steering delivery. The same
owned run remains pending until exact terminal processing, branch quarantine,
or explicit manual intervention.

This prevents the autonomous loop `attention → steer → immediate wait → stop →
relaunch`. It does not infer model/provider failure, substitute another agent,
or change ADR-008's deterministic routing.

### Gate the final question on terminal processing

Block `ask_user_question` only while owned verification is pending. The block
reason identifies the pending run and requires terminal processing to record
the applicable `RV-*` audit. Once terminal processing clears
`pendingVerification`, `ask_user_question` is allowed again under the normal
Exploring policy.

### Use canonical parent-session ownership

Pi exposes a parent session UUID and parent session-file path as distinct public
identities. Persist both. The UUID remains the capability/preflight identity;
the absolute session-file path is the asynchronous ownership identity used by
pi-subagents 0.37.2.

RPC ping must match both active values before spawn. Live completion correlation
requires exact run ID plus exact owner session file. The trusted lifecycle-v3
`status.json` artifact is canonical for terminal state, step exit codes, and
structured outputs; live child results are not required to fabricate an
`exitCode`. An exact owned `stopped` artifact is audited as `failed` with the
package reason, not as malformed. Legacy UUID-only pending snapshots are
quarantined rather than guessed or migrated.

### Restore verification ownership per active branch

Treat `pendingVerification` and its ledger as branch-local state. On both
`session_start` and Pi's public `session_tree` event, rebuild state from
`sessionManager.getBranch()` before reconciling any pending run.
Reconciliation rechecks the exact pending/context identity after each RPC
await and immediately before save, audit, or terminal processing. A branch
change abandons the stale reconciliation without mutation.

A restored pending run is eligible for reconciliation only when every claim
and evidence ID referenced by its top-level scope and expected steps exists in
the active branch's complete ledger history. This check deliberately uses all
historical claim records, not only active claims, so a pending claim remains
auditable after a later claim supersedes it.

If any reference is absent, quarantine the pending run: clear it, append the
cleared state to the active branch, and show a bounded warning. Do not query
pi-subagents and do not create an `RV-*` audit against unknown IDs. A late
completion for the cleared branch is unrelated and is ignored. Navigating back
to a branch that still contains the pending run and all referenced records
restores normal reconciliation.

The asynchronous completion callback owns a final non-throwing error boundary.
It captures the pending run dispatched with the completion and clears state
only while that exact pending object still belongs to the active branch, so a
later navigation cannot lose the newly selected branch's pending run. An audit
failure clears and persists its owned pending state and emits a bounded
warning; notification or persistence failures are also contained instead of
allowing a detached promise rejection to reach Pi's EventBus.

Only ping, status, and status-artifact errors belong to reconciliation's
failure-audit boundary. Terminal processing runs after that boundary: once
completion EV/RV records and cleared pending state are committed, a later UI
error cannot reinterpret the same run as a failed verification.

### Expose semantic gate status

Every model/UI status surface derives one non-persisted snapshot from the
ledger's existing eligibility rules. It distinguishes historical versus active
claims, review audits by status, missing successful reviews, pending ownership,
question-tool availability, final-choice eligibility, and the next action.
Raw `RV=N`, `open critical claims: none`, or `none pending` are never presented
as proof that required review succeeded.

Cancelled `ask_user_question` calls remain append-only technical-success
records when Pi reports a successful tool transport, but are labelled
`semantic=cancelled` and final-choice-ineligible. Generic question availability
remains pending-only because Exploring also uses questions for clarification and
waivers; final-choice eligibility remains enforced by the ledger chronology.

### Keep lifecycle state out of the evidence ledger

Before evidence capture, exclude all permitted `subagent` control results and
all `subagent_wait` results. Neither becomes an `EV-*` record. Structured
terminal verifier output remains the only verification lifecycle output that
can create verifier `EV-*` and `RV-*` records through ADR-008's ownership and
scope validation.

The integrated recovery order is:

1. owned verification reports nonterminal `needs_attention`;
2. the parent performs at most one wait, inspects exact status, and may issue
   one exact owned steer;
3. after a pending steer, autonomous wait/stop/relaunch is blocked while the
   same run awaits terminal completion or manual intervention;
4. terminal completion is ownership-validated against the parent session file
   and trusted lifecycle artifact;
5. verifier `EV-*` and successful or failure `RV-*` records are appended;
6. semantic status names any still-missing successful review;
7. the final dedicated `ask_user_question` result is captured with provenance;
8. `brainstorm_submit_exploring` succeeds and the workflow may enter
   Presenting.

## Alternatives Considered

### Globally allowlist subagent lifecycle actions

Rejected because phase-independent access would permit controlling unrelated
runs and weaken brainstorm-forcer's ownership boundary.

### Add one brainstorm tool per lifecycle action

Rejected because five wrapper tools would duplicate schema, ownership, error,
and maintenance logic without improving the public `subagent` tool contract.

### Patch or fork pi-subagents

Rejected because the pi-subagents 0.37.2 public `subagent` tool already exposes
the required actions. The defect is brainstorm-forcer's local policy, not the
package.

### Treat lifecycle output as evidence

Rejected because status, wait, steering, resume, interruption, and stop output
describe orchestration progress. They do not establish a claim and would make
ledger chronology and provenance misleading.

### Allow the final question while verification is pending

Rejected because the user would choose before the evidence and audit needed to
compare approaches exist.

### Audit an orphaned run against the newly active branch

Rejected because identical claim IDs are not sufficient ownership evidence
across branches. Auditing absent claim or evidence records would either crash
the strict ledger boundary or fabricate history that the active branch never
contained.

## Consequences

An owned verification run can recover from `needs attention` without exposing
generic spawn, another run, directory targeting, transcript/fleet inspection,
or execution payloads.

The policy intentionally accepts less than the full public subagent schema.
Future lifecycle fields or actions remain blocked until this ADR and the
action-specific tests are deliberately updated.

Final-choice provenance is ordered after terminal verification processing, and
the ledger contains claim evidence rather than orchestration chatter.

The extension now depends on persisted expected-step count to validate child
indexes. A malformed or missing ownership state fails closed, preserving
ADR-008's conservative recovery model.

Tree navigation can no longer leak pending ownership from an abandoned branch.
Quarantine preserves ledger strictness and branch history; it does not make
unknown claims permissive or add a synthetic review family.
