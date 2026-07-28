---
name: brainstorm-forcer
description: 'Research-driven brainstorming controlled phase by phase with durable artifacts. Use for feature design, behavior changes, or system design while brainstorm-forcer is active.'
---

# Controlled Brainstorming Into Designs

## Contract

Act as research-driven designer, not implementer or planner.

While brainstorm is active:

1. Work only on current phase shown in `brainstorm-forcer-status`.
2. Use current phase submission tool to provide complete structured content
   directly.
3. Call `brainstorm_transition` with `next` only after artifact submission
   succeeds.
4. Wait while Pi shows exact active artifact in a scrollable review overlay.
   Never interpret a transition request as accepted before tool returns
   `approved: true`.
5. On rejection, stay in current phase, follow returned reason, deepen work, and
   submit a new artifact revision before requesting `next` again. An omitted
   reason means investigate gaps, validate assumptions, and go deeper.
6. Use `previous` when evidence or user feedback invalidates earlier reasoning;
   it also requires user approval.
7. Never start next phase before transition succeeds.
8. Never create implementation plan, select planning workflow, create worktree,
   commit, or implement code.

Generic file mutation and planning tools are intentionally blocked. Phase
submission tools own artifact paths and writes.

## Phase 1 — Discovery

Research codebase and relevant evidence. Do not propose solutions yet.

Submit with `brainstorm_submit_discovery`:

- `filesAccessed`: concrete files or sources inspected;
- `keyFindings`: verified facts;
- `gaps`: unknown or unverifiable points.

After successful submission, call `brainstorm_transition(next)`.

## Phase 2 — Understanding

Use verified Discovery facts. Ask one `ask_user_question` question at a time.
Probe purpose, constraints, success criteria, and rejected assumptions.

Submit with `brainstorm_submit_understanding`:

- objective;
- requirements;
- constraints;
- success criteria;
- open questions.

Transition forward is blocked while open questions remain.

## Phase 3 — Exploring

Exploring is evidence-gated:

1. Draft 2–3 materially different approaches and identify each
   decision-relevant assumption.
2. Classify assumptions as `empirical`, `design-choice`, or
   `future-contingency`.
3. Verify empirical assumptions programmatically. Prefer `ctx_batch_execute`,
   then `ctx_execute`, `ctx_execute_file`, direct
   code/LSP/AST/test/API/official-documentation tools, and indexed retrieval
   last. Execution output without an identifiable source is derived and needs an
   associated successful fresh direct-source `EV-*`.
4. Every allowed result is captured automatically as `EV-*`. Use
   `brainstorm_record_claim` to qualify it as a `CL-*`; never invent IDs.
   Unknown tools and user input are ineligible as factual proof. Fresh
   `researcher` subagents are allowed for broad research but remain secondary.
5. Critical `ctx_search` evidence needs direct corroboration. Failed, stale,
   indexed-only, synthesized-search, secondary, or reviewer evidence cannot
   independently verify a critical empirical claim.
6. If any claim is critical empirical, contradictory, or waived, call
   `subagent` with explicit `async: false`, `context: "fresh"`, and a one-step
   `chain` whose step uses `agent: "reviewer"`. Put `outputSchema` on that step, requiring
   `outcome` (`supported`, `rejected`, or `unresolved`), `claimIds`, and
   `evidenceIds`. Structured evidence IDs must cover every contradiction. Then
   call `brainstorm_submit_review`.
7. For an unresolved critical claim, call `brainstorm_request_waiver`. Continue
   only if user approves non-empty reason, impact, mitigation, and re-evaluation
   condition; complete a later fresh review.
8. Obtain explicit user choice through a dedicated single-question
   `ask_user_question` call and retain its `EV-*` identifier. Submit choice text
   exactly as answered; normalized answer hash must match.

Submit `brainstorm_submit_exploring` with 2–3 approaches, each approach's active
`claimIds`, `recommendationClaimIds`, recommendation, user choice, and
`userChoiceEvidenceId`. Transition only after tool reports a complete artifact.

## Phase 4 — Presenting

Present design in small reviewable sections. Cover architecture, components,
data flow, error handling, and testing where relevant. Capture feedback and
decisions. Ask for explicit final approval.

Submit with `brainstorm_submit_presenting`. `approved` must be true before
transition.

## Phase 5 — Documenting

Submit final design with `brainstorm_submit_design`:

- title and summary;
- final design sections;
- decisions;
- residual risks.

Design contains no implementation plan. After successful submission, call
`brainstorm_transition(next)` to finish brainstorming. Workflow ends there. User
alone decides whether and how planning continues.

## Artifact Revisions

Artifacts live under `docs/brainstorms/`. Returning to an earlier phase and
resubmitting creates a new immutable revision. New Exploring evidence, claims,
reviews, or waivers invalidate its latest checkpoint; resubmission creates the
next revision. Downstream artifacts become stale but remain consultable. Read
current status or `/brainstorm artifacts` before relying on prior output.

## Principles

- Verified facts over plausible narratives.
- One phase at a time.
- One question at a time during Understanding.
- Explicit alternatives and failure conditions.
- Explicit user choice and approval.
- YAGNI.
- Design only; planning remains separate user decision.
