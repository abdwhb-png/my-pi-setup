# brainstorm-forcer

Pi extension that runs brainstorming as a controlled, artifact-backed state machine.

## Workflow

`/brainstorm <topic>` starts immediately in Discovery. While active:

- one compact status message is injected before each LLM call;
- only adjacent LLM transitions are accepted;
- every phase requires a structured Markdown artifact;
- generic mutation, shell, and planning tools remain blocked;
- Exploring recommendations are gated by immutable evidence and claims;
- completion stops after final design and never starts planning or implementation.

## Commands

- `/brainstorm <topic>` or `/brainstorm start <topic>` — start immediately
- `/brainstorm arm <topic>` — arm without starting an LLM turn
- `/brainstorm status` — show current phase, gate, restrictions, and compact
  ledger counts
- `/brainstorm artifacts` — list durable active/stale revisions
- `/brainstorm review` — reopen the active artifact in a scrollable Pi overlay
- `/brainstorm next` / `/brainstorm previous` — adjacent user transition
- `/brainstorm next --force` / `/brainstorm force-next` / forward
  `/brainstorm phase <name|number>` — explicit user overrides
- `/brainstorm stop` — stop workflow

Leaving or skipping Exploring through a force command requires a non-empty user
reason and confirmation. Approval creates an immutable `OV-*` record containing
the bypassed blockers. LLM tool `brainstorm_transition` cannot force or skip.

## Phase tools

1. Discovery → `brainstorm_submit_discovery`
2. Understanding → `brainstorm_submit_understanding`
3. Exploring → evidence tools plus `brainstorm_submit_exploring`
4. Presenting → `brainstorm_submit_presenting`
5. Documenting → `brainstorm_submit_design`

Exploring tools:

- `brainstorm_record_claim` — qualify an assumption as `empirical`,
  `design-choice`, or `future-contingency`;
- `brainstorm_submit_review` — link successful fresh reviewer evidence to active
  claims and cited primary evidence;
- `brainstorm_request_waiver` — request blocking user approval for an unresolved
  critical claim;
- `brainstorm_submit_exploring` — render and submit the ledger-backed Exploring
  artifact.

After submitting the current phase, the LLM calls `brainstorm_transition` with
`next`, `previous`, or `status`.

LLM-requested `next` and `previous` transitions open a blocking Pi overlay
containing the exact active Markdown artifact, revision, and path. Approve,
Reject, or Reject with reason. Rejection keeps the phase active and requires a
revised artifact before another forward transition.

## Evidence-gated Exploring

Every allowed non-workflow `tool_result` during Exploring is captured
automatically as an append-only `EV-*` session record. Stored metadata is
bounded and redacted: tool/status, timestamp, safe source references, canonical
input/output hashes, source kind/staleness, and native tool-call reference. Raw
parameters, output, and reviewer transcript remain in native session/Context
Mode storage.

Ledger records:

- `EV-*` — observed tool result;
- `CL-*` — qualified claim and evidence links;
- `RV-*` — explicit fresh reviewer linkage;
- `WV-*` — user-approved waiver with reason, impact, mitigation, and
  re-evaluation condition;
- `OV-*` — confirmed user force override.

Critical empirical claims need successful direct evidence. `ctx_search` evidence
has no structured staleness metadata in the current Context Mode bridge, so it
cannot close a critical claim without direct corroboration. Failed, stale,
synthesized-search, indexed-only, or reviewer evidence cannot independently
verify a critical empirical claim.

Conditional review is required for a critical empirical claim, contradictory
evidence, or a waiver. Allowed reviewer call is a synchronous single `subagent`
execution with `agent: "reviewer"` and `context: "fresh"`; its result must then
be linked with `brainstorm_submit_review`.

Exploring completion requires:

- every approach references active `CL-*` assumptions;
- critical unresolved claims have user-approved waivers;
- required fresh reviews postdate the claims and waivers they cover;
- empirical recommendation claims are closed;
- the user choice is explicit.

New evidence, claim, review, or waiver invalidates the latest Exploring
checkpoint. Resubmission creates the next immutable Exploring revision and marks
prior/downstream revisions stale through the existing artifact store.

## Artifacts

Each run writes under `docs/brainstorms/YYYY-MM-DD-<topic>/`:

```text
01-discovery-r001.md
02-understanding-r001.md
03-exploring-r001.md
04-presenting-r001.md
05-design-r001.md
manifest.json
```

Exploring artifact is generated from ledger and contains Assumption Register,
Evidence Index, verified/falsified findings, design choices, residual
unknowns/waivers, approach comparison, evidence-backed recommendation, review
records, overrides, and user choice.

Writes reuse `pi-scoped-write`: project confinement, traversal/symlink
rejection, atomic writes, size limits, hashes, and audit trail. LLM never
supplies artifact paths.

## Persistence and status

Workflow snapshots and append-only ledger records use Pi session entries and
restore from active branch on reload. Old runs remain in session history but are
filtered by `runId`.

Exactly one transient `brainstorm-forcer-status` message is present per LLM
call. It includes phase, gate, artifact revisions, `EV/CL/RV/WV/OV` counts, and
open critical claim IDs—never raw evidence.

## Bundled skill

`skills/brainstorm-forcer/SKILL.md` is registered through `resources_discover`.

## Tests

From `~/.pi/agent`:

```bash
bun test \
  extensions/brainstorm-forcer/index.test.ts \
  extensions/brainstorm-forcer/artifacts.test.ts \
  extensions/brainstorm-forcer/review.test.ts \
  extensions/brainstorm-forcer/exploration-ledger.test.ts \
  --isolate
```
