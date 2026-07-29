# ADR-008: Domain-routed asynchronous brainstorm verification

## Status

Accepted

## Date

2026-07-29

## Context

[ADR-007](./ADR-007-evidence-gated-brainstorm-exploration.md) established
evidence-gated Exploring with append-only `EV-*`, `CL-*`, `RV-*`, `WV-*`, and
`OV-*` records. Its first execution design asked the LLM to construct a fresh
synchronous reviewer chain and submit the result through a second review tool.

That mechanism exposed orchestration policy to an unreliable caller. The LLM
could choose or misconfigure the reviewer chain, verification was synchronous,
and a manual review-submission step separated child output from ownership and
scope validation. It also did not provide durable pending-run recovery.

The installed pi-subagents version is verified as 0.37.2. It provides public
launch preflight, capability ceilings, an in-process RPC v1 surface for
`ping`/async `spawn`/`status`, an advertised async-completion event, FleetView,
and machine-readable lifecycle artifacts.

Exploring also needs a strict final order. A user choice made before the claims
or verification it is supposed to compare is not informed provenance. A blocked
Exploring submission must not create an incomplete revision or mutate the
artifact manifest.

This ADR amends ADR-007's verifier execution mechanism and records the final
Exploring ordering/write policy. It does not supersede, rewrite, or erase
ADR-007; ADR-007 remains the historical decision for evidence capture, claim
qualification, direct-evidence primacy, waivers, and append-only auditing.

## Decision

### One closed workflow tool

Replace manual reviewer-chain construction and review submission with one
model-facing tool:

```text
brainstorm_run_verification({ claimIds: ["CL-001", "CL-002"] })
```

The schema exposes only selected active claim IDs. It does not expose agent,
architect, context, chain, or async controls.

Use one workflow tool rather than one tool per agent. The extension must own the
route, grouping, capability ceiling, spawn contract, completion correlation,
and ledger audit as one deterministic transaction. Per-agent tools would expose
policy selection to the LLM and duplicate security and validation logic.

Every new claim supplies a closed `verificationDomain` and
`architectureImpact`. Routing is fixed:

| Domain        | Verifier               |
| ------------- | ---------------------- |
| `pi`          | `pi-expert`            |
| `local-code`  | `scout`                |
| `external`    | `factual-researcher`   |
| `performance` | `performance-reviewer` |

`expert-reviewer` and generic `reviewer` are intentionally excluded from new
brainstorming routes. `worker`, `oracle`, and arbitrary agent names are also
outside the allowlist. Direct generic `subagent` execution is blocked during
Exploring.

Claim verdicts map deterministically: `verified` to `supported`, `falsified` to
`rejected`, and `unresolved` to `unresolved`. Claims are grouped and the
verification chain is built only by the shared deterministic verification
module. Verifier evidence descriptors use the ledger's already-sanitized source
references.

### Read-only asynchronous execution

Register a session-scoped capability ceiling with an exact read-only tool-name
allowlist. Provider extensions remain loadable only so allowlisted
documentation, web, and inspection tools can resolve; mutation, arbitrary code
execution, and nested subagent execution remain unavailable.

Before spawning, derive the stable unique agent sequence from the selected
chain. Public preflight checks exactly those verifiers and adds `architect` only
when the selected chain contains that step. An unavailable unused agent cannot
block another domain.

Use pi-subagents RPC v1 with bounded timeouts and listener cleanup. `ping`
advertises the completion event name; existing listeners rebind if that name is
not the default. Spawn is top-level async with fresh context and clarification
disabled. The children are fresh, read-only verification workers whose results
remain secondary evidence.

The package's FleetView and status surfaces show the async run. Brainstorm
context, `/brainstorm status`, and its widget show the owned run as pending.
Persist the run ID, trusted package-returned async directory, owner session,
brainstorm run, selected claims, and exact expected agent/output/group/claim/
evidence scope.

On session reload, call RPC status but do not parse its human-readable text.
Then validate the package-owned lifecycle artifact beneath the canonical
pi-subagents temporary hierarchy. A queued or running artifact remains pending.
An owned terminal artifact passes through the same strict terminal parser as a
live completion event. Missing, malformed, escaped, or symlinked lifecycle
artifacts fail closed. Owned terminal processing is idempotent, so reload and a
later duplicate completion event cannot emit records twice.

### Structured result and ledger policy

Accept only exact structured output. Validate run/session ownership, terminal
success and exit status, fresh context, expected agent, named group output,
exact `CL-*`/`EV-*` sets, and agreement between result and named structured
output. Never parse prose for an outcome.

For a valid successful verifier output, automatically append:

- one secondary `EV-*` record for the structured verifier output;
- one successful `RV-*` audit record linked to the selected claims and primary
  evidence.

No separate review-submission tool and no new ledger prefix are introduced.
Direct fresh evidence remains authoritative; verifier output cannot independently
prove a critical empirical claim.

For an owned failed, malformed, or timed-out run, append failure `RV-*` audit
records without a successful verifier `EV-*`. These records preserve the
attempt but cannot satisfy the verification gate.

Restored legacy reviewer evidence and `RV-*` records with
`reviewerEvidenceId` remain eligible when they satisfy ADR-007's existing proof
policy. Do not rewrite those records. New code and records use verifier
terminology.

### Optional architect advisory

Add `architect` only when at least one selected claim has
`architectureImpact: true`. Its structured output must repeat the exact
architecture-impacting claim and evidence scope and use one status:

- `clear` — no architecture blocker;
- `watch` — retain bounded risks and summary without adding a blocker;
- `block` — keep the scoped architecture-impacting claims blocked.

Architect data is advisory and stored in the `RV-*` audit, including exact
claim/evidence scope, risks, and summary. It does not replace the routed
verifier or direct evidence. A block does not leak to ordinary claims that share
a verifier group. Architecture impact makes verification required even when the
claim is noncritical.

### Final choice and artifact order

The final user choice must retain the dedicated single-question provenance and
normalized answer-hash checks from ADR-007. Compare append-only ledger sequence
numbers, not timestamps or prose order.

Choice evidence must have a sequence greater than:

- every active claim it chooses between;
- the latest eligible successful required `RV-*` record for each active claim,
  including required post-waiver verification.

Pending, failed, malformed, timed-out, missing, or architect-blocked
verification cannot satisfy this order.

`brainstorm_submit_exploring` computes a bounded deterministic blocker list
before rendering or calling the artifact store. A blocked call creates no file,
revision, manifest mutation, or downstream staleness. When blockers are empty,
one call writes exactly one complete Exploring revision. Transition to
Presenting is allowed only from that complete revision.

## Alternatives Considered

### Keep the ADR-007 synchronous reviewer chain

Rejected because the LLM would continue to construct orchestration payloads and
manually bridge child output into the ledger. It also lacks durable async
ownership and reload recovery.

### Expose one verification tool per agent

Rejected because route choice and policy would move into the prompt surface,
security checks would be duplicated, and agent availability outside the
selected domain could affect behavior.

### Allow direct generic subagent execution

Rejected because arbitrary agents, tools, contexts, or nested fan-out would
bypass the deterministic route and read-only ceiling.

### Parse async status or completion prose

Rejected because prose is not a machine contract. Exact structured output and
package lifecycle artifacts provide deterministic ownership and scope checks.

### Write an incomplete Exploring revision with blockers

Rejected because a blocked attempt would mutate durable state, advance revision
numbers, and potentially stale valid downstream artifacts without producing an
artifact eligible for transition.

## Consequences

Verification is asynchronous and may add latency, but the parent remains
responsive and progress is visible through FleetView and brainstorm status.

Routing and capability policy are smaller and auditable because the LLM selects
claims, not execution machinery. Selected-only preflight avoids coupling
unrelated routes.

Pending state and reload reconciliation add lifecycle validation work. The
system deliberately fails closed when ownership, structure, scope, or package
artifacts cannot be proven.

The ledger preserves both successful and unsuccessful attempts without adding a
new record family. Legacy ADR-007 reviewer records remain readable, while all
new execution uses verifier terminology.

Final choice provenance now proves chronology as well as answer identity.
Blocked submissions leave no artifact trace; successful submissions produce a
single complete Exploring revision before Presenting.
