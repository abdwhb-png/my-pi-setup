# ADR-007: Evidence-gated brainstorm exploration

## Status

Accepted

## Date

2026-07-28

## Context

`brainstorm-forcer` currently asks the Exploring phase to compare two or three
approaches using trade-offs, critical uncertainties, failure conditions, a
recommendation, and a user choice. The phase can complete without proving that
its decision-critical assumptions were investigated.

This allows Exploring artifacts to mix three different concepts:

- empirical claims that can be checked against code, runtime data, APIs, or
  official documentation;
- design choices that require an explicit trade-off or user preference rather
  than factual verification;
- future contingencies that cannot yet be resolved.

A global count of research tool calls cannot prove that a specific claim was
verified. Subagent output is also not primary evidence unless it cites actual
code, commands, API responses, measurements, or authoritative sources.

Pi already provides direct inspection tools, Context Mode tools such as
`ctx_batch_execute`, `ctx_execute`, `ctx_execute_file`, and indexed-source
retrieval, plus subagents for broader research and contradictory review.
Exploring should use those capabilities programmatically before recommending an
approach.

## Decision

Make Exploring an evidence-gated phase built around immutable evidence records
and explicitly qualified claims.

### Programmatic-first verification

For every decision-relevant approach, identify its assumptions and classify
each as:

- `empirical` — verifiable against observable evidence;
- `design-choice` — an explicit architectural or user trade-off;
- `future-contingency` — genuinely unresolved until a future condition occurs.

Verify empirical assumptions with the narrowest suitable source. Prefer:

1. `ctx_batch_execute` for several related checks;
2. `ctx_execute` for deterministic measurements, parsing, and comparisons;
3. `ctx_execute_file` for facts derived from a specific local file;
4. direct code, LSP, AST, test, API, and official-documentation tools;
5. indexed retrieval only when its source is authoritative and not stale.

Context Mode is a verification mechanism only when the underlying input and
operation are identifiable. A derived answer without source provenance is not
sufficient evidence.

### Automatic evidence capture

During Exploring, every allowed non-mutating `tool_result` is recorded as an
immutable evidence record with an `EV-*` identifier. Each record contains only
bounded, redacted metadata:

- brainstorm run and phase;
- tool name and success/error state;
- timestamp;
- safe source references such as paths, URLs, or Context Mode source labels;
- hashes for the relevant input and output;
- a reference to native session or Context Mode content when available.

Raw tool parameters and full output are not copied blindly into the artifact or
per-turn status. Failed tool results remain auditable but cannot support a
`verified` verdict. Evidence from a stale indexed source cannot satisfy a
critical empirical claim.

### Explicit claim qualification

The LLM uses a dedicated Exploring claim tool to create immutable `CL-*`
records. A claim contains:

- the assertion;
- classification and criticality;
- verdict: `verified`, `falsified`, or `unresolved`;
- one or more referenced `EV-*` records when empirical;
- impact and mitigation;
- an optional user waiver reference.

The tool validates that referenced evidence exists in the same brainstorm run
and is eligible for the requested verdict. The explicit claim tool interprets
evidence; it does not create evidence and cannot invent `EV-*` identifiers.

### Reviewer policy

A fresh reviewer subagent is required only when at least one of these conditions
is present:

- a decision-critical empirical claim;
- contradictory evidence;
- a requested waiver for an unresolved critical claim.

Reviewer output is captured as evidence but is not primary proof by itself. Its
conclusions must point to direct measurements, code, API responses, tests, or
authoritative documentation.

### Exploring completion gate

The normal Exploring completion path cannot advance until:

- every critical empirical claim is `verified` or `falsified`;
- every unresolved critical claim has an explicit user-approved waiver;
- every required conditional review has completed;
- the recommendation cites closed claims;
- the user choice is explicit.

A waiver records reason, impact, mitigation, and a condition for
re-evaluation. Only the user can approve it; the LLM cannot generate and
self-approve one.

The final Exploring artifact contains the assumption register, evidence index,
verified and falsified findings, design choices, residual unknowns and waivers,
approach comparison, evidence-backed recommendation, and user choice. New
evidence or corrected claims create a new immutable Exploring revision and use
the existing downstream stale-artifact behavior.

### Implementation clarifications

The implementation uses append-only session records: `EV-*` evidence, `CL-*`
claims, `RV-*` explicit reviews, `WV-*` user-approved waivers, and `OV-*`
confirmed user overrides. A corrected claim supersedes an older claim without
mutating it. Waivers remain separate records keyed by claim so claim history also
stays immutable.

A conditional review completes only after a successful synchronous `subagent`
call with `agent: "reviewer"` and `context: "fresh"`, followed by an explicit
review tool that links reviewer evidence, active claims, and cited direct
evidence. Reviewer output remains secondary evidence.

The current Context Mode Pi bridge returns empty structured details for
`ctx_search`, so the extension cannot prove freshness from metadata alone.
Indexed evidence may inform a critical claim but cannot close it without at least
one successful direct corroborating record.

User-only force commands remain an emergency escape hatch. Leaving or skipping
Exploring through `next --force`, deprecated `force-next`, or a forward phase
jump requires a non-empty reason and explicit confirmation, then creates an
immutable `OV-*` record with the bypassed blockers. This is a deliberate,
auditable exception to the normal completion gate. The LLM transition tool has
no force path.

## Alternatives Considered

### Prompt-only factual verification

Strengthen the Exploring prompt to tell the LLM to verify assumptions.

Rejected because compliance remains narrative and no programmatic link exists
between a claim and actual evidence.

### Minimum research-tool call count

Require a fixed number of research, Context Mode, or subagent calls.

Rejected because unrelated or redundant calls can satisfy the count without
verifying any decision-critical claim.

### Automatic evidence capture without explicit claims

Capture `EV-*` records and let the final Exploring artifact cite them directly.

Rejected because raw observations still need explicit classification, verdict,
criticality, and impact. Separating immutable observations from LLM
interpretation makes the workflow auditable and correctable.

### Explicit evidence recording without automatic capture

Require the LLM to create evidence records after each research action.

Rejected because the LLM could omit, distort, or fabricate the observed result.
The explicit tool may qualify captured evidence but cannot replace automatic
capture.

### Mandatory reviewer for every exploration

Always require a reviewer subagent.

Rejected because it adds cost and latency to low-risk decisions. Conditional
review targets cases where contradiction, criticality, or waiver justifies it.

## Consequences

Exploring becomes slower and may consume more tool calls, but recommendations
become auditable, reproducible, and contestable.

The extension must distinguish evidence acquisition from interpretation,
validate evidence and claim references, preserve the ledger across session
reloads, and keep injected status compact.

Evidence persistence must redact secrets, bound stored excerpts, retain source
provenance, and detect stale indexed sources where supported.

Absence of evidence is never treated as evidence of absence. Technical failure
to verify leaves a claim unresolved and therefore blocked unless the user grants
a documented waiver.

Design choices remain lightweight: they require explicit trade-offs and user
preference, not artificial empirical proof. Only claims that can materially
change the recommendation should enter the evidence gate, avoiding unnecessary
bureaucracy for small brainstorms.
