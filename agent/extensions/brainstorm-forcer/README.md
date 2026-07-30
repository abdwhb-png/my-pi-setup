# brainstorm-forcer

Pi extension that runs brainstorming as a controlled, artifact-backed state
machine. It produces design artifacts only; planning and implementation remain
separate user decisions.

## Workflow

`/brainstorm <topic>` starts in Discovery. While active:

- one compact status message is injected before each LLM call;
- only adjacent LLM transitions are accepted;
- every phase requires a complete structured Markdown artifact;
- generic mutation, shell, planning, and generic `subagent` execution are
  blocked; Exploring permits only scoped lifecycle control of its exact owned
  pending verification run;
- Exploring recommendations are gated by append-only evidence, claims,
  verification audits, waivers, and final user-choice provenance;
- completion stops after the final design.

Phase submission tools:

1. Discovery — `brainstorm_submit_discovery`
2. Understanding — `brainstorm_submit_understanding`
3. Exploring — evidence tools, `brainstorm_record_claim`,
   `brainstorm_run_verification`, `brainstorm_request_waiver`, and
   `brainstorm_submit_exploring`
4. Presenting — `brainstorm_submit_presenting`
5. Documenting — `brainstorm_submit_design`

After a successful phase submission, call `brainstorm_transition` with `next`,
`previous`, or `status`. An LLM-requested transition opens the exact active
artifact for user approval. Rejection keeps the current phase active and
requires a revised complete artifact before another forward transition.

## Commands

- `/brainstorm <topic>` or `/brainstorm start <topic>` — start immediately
- `/brainstorm arm <topic>` — arm without starting an LLM turn
- `/brainstorm status` — show phase, gate, restrictions, ledger counts, and
  pending verification
- `/brainstorm artifacts` — list durable active and stale revisions
- `/brainstorm review` — open the active artifact in Pi
- `/brainstorm next` / `/brainstorm previous` — adjacent user transition
- `/brainstorm next --force` / `/brainstorm force-next` / forward
  `/brainstorm phase <name|number>` — explicit user override
- `/brainstorm stop` — stop the workflow

Leaving or skipping Exploring through a force command requires a non-empty user
reason and confirmation. Approval creates an immutable `OV-*` record containing
the bypassed blockers. `brainstorm_transition` cannot force or skip.

## Evidence-gated Exploring

Every allowed non-workflow `tool_result` during Exploring is captured as an
append-only `EV-*` session record. Stored metadata is bounded and redacted:
tool/status, timestamp, sanitized source references, canonical input/output
hashes, source kind/staleness, and a native tool-call reference. Raw parameters
and output remain in native session or Context Mode storage.

Ledger identifiers remain append-only:

- `EV-*` — observed tool result, including successful secondary verifier output;
- `CL-*` — qualified claim and evidence links;
- `RV-*` — verifier or legacy review audit;
- `WV-*` — user-approved waiver;
- `OV-*` — confirmed user force override.

`brainstorm_record_claim` requires both:

- `verificationDomain`: `pi`, `local-code`, `external`, or `performance`;
- `architectureImpact`: whether the selected claim needs the architect advisory.

Critical empirical claims still require successful fresh direct evidence from
the strict direct-tool allowlist. Failed, stale, indexed-only, derived-only, or
secondary evidence cannot independently prove them. Verifier output is
secondary evidence and never replaces direct evidence.

Verification is required for critical empirical claims, contradictory evidence,
architecture-impacting claims, and claims with an approved waiver. A waiver for
an unresolved critical claim does not remove the later verification
requirement.

## Dedicated asynchronous verification

Call the single model-facing workflow tool:

```text
brainstorm_run_verification({ claimIds: ["CL-001", "CL-002"] })
```

It accepts active claim IDs only. Agent, chain, architect, context, and
execution controls are deliberately not parameters. One workflow tool keeps
routing, capability policy, ownership correlation, and audit emission in
deterministic code; one tool per agent would expose those controls to the LLM
and let policy drift between routes.

The closed routing table is:

| Claim domain  | Verifier               |
| ------------- | ---------------------- |
| `pi`          | `pi-expert`            |
| `local-code`  | `scout`                |
| `external`    | `factual-researcher`   |
| `performance` | `performance-reviewer` |

`expert-reviewer` and the generic `reviewer` are intentionally excluded from
new brainstorming verification routes. Arbitrary agents, `worker`, and
`oracle` are also rejected.

Before each spawn, the extension derives the stable unique agent sequence from
the selected deterministic chain. Public preflight checks only those routed
agents, plus `architect` only when the chain contains it, under the active
read-only capability ceiling. Missing unused agents therefore cannot block an
unrelated route.

The extension uses pi-subagents 0.37.2 RPC v1 for `ping`, async `spawn`, and
`status`-based reload reconciliation. Children run with fresh context, a fixed
read-only tool-name allowlist, and no nested `subagent` capability. The
top-level async run appears in pi-subagents FleetView and status surfaces.
Brainstorm context, `/brainstorm status`, and the widget also show owned pending
verification. Scoped `status`, `steer`, `resume`, `interrupt`, and `stop`
controls use the public `subagent` tool described below, not the extension's RPC
client.

Pending ownership persists both public parent identities: the Pi session UUID
for capability/preflight and the absolute parent session-file path used by
pi-subagents for asynchronous ownership. RPC ping must match both before spawn.
On reload, the extension calls RPC status without parsing its prose, then
validates the package-owned lifecycle-v3 artifact under the pi-subagents
temporary hierarchy. Running work stays pending; an owned terminal artifact is
processed exactly once. Legacy UUID-only pending state is quarantined.
Unrelated or duplicate terminal events are ignored.

The live event is correlated by exact run ID and owner session file; trusted
`status.json` supplies canonical terminal state, per-step exit status, and
structured outputs. Real child results need no fabricated `exitCode`. An exact
owned stop is audited as failed with its package reason, not malformed.

Only exact structured output with matching run/session ownership, exit status,
agent, named output, claim IDs, and evidence IDs is accepted. Successful
structured verifier output automatically creates a secondary `EV-*` and an
`RV-*`; no prose is parsed and no separate review-submission tool exists.
Failed, malformed, or timed-out runs create failure `RV-*` audit records but
cannot close the gate.

### Scoped needs-attention control

`brainstorm_run_verification` remains the only run-creation surface. During
Exploring, `subagent` remains blocked except while
`pendingVerification.runId` owns a run. That temporary exception permits only:

| Action      | Exact accepted fields                        |
| ----------- | -------------------------------------------- |
| `status`    | `action`, `id`                               |
| `steer`     | `action`, `id`, non-empty `message`, `index` |
| `resume`    | `action`, `id`, non-empty `message`, `index` |
| `interrupt` | `action`, `id`                               |
| `stop`      | `action`, `id`                               |

`id` must equal the pending owned run ID. `index` is optional for `steer` and
`resume`; when present it must be a non-negative integer inside the persisted
expected-step range. Unknown actions, extra fields, `runId`, `dir`, alternate
run targets, fleet/transcript views, and execution fields such as `agent`,
`task`, `tasks`, `chain`, `parallel`, or `async` are rejected. No control can
run without pending owned verification.

`needs_attention` is nonterminal and latched. `subagent_wait.timeoutMs` is an
upper bound, so another wait may return immediately once attention is active.
The model gets at most one owned wait and one owned steer. A typed pending/routed
steer result is persisted branch-locally; afterward only exact owned `status`
is available. Repeat wait/steer, resume, interrupt, stop, and autonomous
replacement launch are blocked until exact terminal completion, quarantine, or
explicit manual intervention. Status prose is never parsed, and attention never
proves model/provider failure or selects a fallback agent.

Results from permitted `subagent` controls and `subagent_wait` are orchestration
state and are excluded before `EV-*` capture.

`ask_user_question` is blocked only while owned verification is pending.
Terminal processing must first record the applicable `RV-*` audit and clear the
pending run; the final-choice question is then allowed again.

### Architect advisory

The `architect` step is added only when at least one selected claim has
`architectureImpact: true`. Its persisted and validated scope is exactly those
architecture-impacting claim and evidence IDs:

- `CLEAR` (`clear`) — no architecture blocker;
- `WATCH` (`watch`) — audit the risks without adding an architecture blocker;
- `BLOCK` (`block`) — keep only the scoped architecture-impacting claims
  blocked.

The architect is advisory. It does not verify ordinary claims, replace routed
verifiers, or turn secondary output into direct evidence. A noncritical
architecture-impacting claim still requires successful verification. Every
strict `outputSchema` step sets `acceptance: false`, so pi-subagents does not
append a competing prose acceptance contract. The architect task receives exact
evidence source references and must finish through `structured_output`.

If every routed verifier step completed with a trusted, exactly correlated
structured output but only the architect step failed, terminal processing keeps
the verifier success: it appends the verifier `EV-*` and successful `RV-*`,
records bounded `advisoryFailure` metadata on that audit, creates no architect
evidence, clears pending state, and warns the user. An advisory execution
failure therefore cannot force the same verifier work to run again. A valid
architect `block` remains blocking for its exact architecture claim scope.

Legacy restored evidence with reviewer terminology and review records with
`reviewerEvidenceId` remain eligible when they satisfy the existing proof
policy. Restoration does not mutate those records; all new execution and audit
paths use verifier terminology.

## Semantic Exploring status

`/brainstorm status`, injected context, transition status details, and the
widget derive one semantic snapshot from ledger eligibility. It reports active
versus historical claims, review totals by audit status, missing successful
reviews, pending ownership, final-choice eligibility, and the next action.
A restored active claim without routing metadata is listed under
`routingMetadataRequiredClaimIds`; status selects `supersedeClaims` before
verification and names the exact claims to replace with `supersedesClaimId`,
`verificationDomain`, and `architectureImpact`. Metadata is never inferred or
migrated automatically. Malformed/failed/timeout RV records remain visible but
never look successful.
A cancelled question is recorded append-only as transport success when Pi says
the call succeeded, while its semantic label remains cancelled and
final-choice-ineligible.

Preflight confirms agent discovery and launch-contract feasibility. Without a
host model-registry snapshot it is not a provider-health check, and a user-stop
with zero child turns is not evidence that the effective model is broken.

## Final Exploring order

The normal sequence is:

1. capture direct evidence as `EV-*`;
2. record every active `CL-*`;
3. if verification needs attention, perform at most one wait, inspect status,
   and optionally issue one exact owned steer;
4. after pending steer, do not wait, stop, or relaunch autonomously; await the
   same run or request explicit manual intervention;
5. process terminal completion into verifier `EV-*` and `RV-*` records;
6. confirm semantic status shows no missing successful reviews;
7. ask one dedicated `ask_user_question` question for the final choice;
8. call `brainstorm_submit_exploring`;
9. transition to Presenting.

The choice evidence sequence must be later than every active claim and every
required successful review, including a post-waiver review. Existing
single-question provenance and normalized answer-hash checks also apply. A
choice made before pending, failed, missing, or later verification is blocked.

`brainstorm_submit_exploring` computes a bounded deterministic blocker list
before rendering or writing. A blocked call creates no file, artifact revision,
manifest mutation, or downstream staleness. Once blockers are empty, one call
writes exactly one complete Exploring revision; only that complete revision can
advance to Presenting.

## Artifacts and persistence

Each run writes under `docs/brainstorms/YYYY-MM-DD-<topic>/`:

```text
01-discovery-r001.md
02-understanding-r001.md
03-exploring-r001.md
04-presenting-r001.md
05-design-r001.md
manifest.json
```

The Exploring artifact is rendered from the ledger and includes the assumption
register, evidence index, findings, design choices, unknowns/waivers,
approaches, recommendation, verification audits, overrides, and final
user-choice provenance.

Writes reuse `pi-scoped-write` for project confinement, traversal/symlink
rejection, atomic writes, size limits, hashes, and audit trail. The LLM never
supplies artifact paths. Session restoration validates record variants, IDs,
sequences, relations, and current proof policy; broken or malformed restored
state remains a gate blocker.

## Bundled skill

`skills/brainstorm-forcer/SKILL.md` is registered through
`resources_discover`.

## Tests

From `~/.pi/agent`:

```bash
bun test --isolate extensions/brainstorm-forcer
```
