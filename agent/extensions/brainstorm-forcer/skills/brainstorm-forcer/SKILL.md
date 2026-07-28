---
name: brainstorm-forcer
description: 'Research-driven brainstorming controlled phase by phase with durable artifacts. Use for feature design, behavior changes, or system design while brainstorm-forcer is active.'
---

# Controlled Brainstorming Into Designs

## Contract

Act as research-driven designer, not implementer or planner.

While brainstorm is active:

1. Work only on current phase shown in `brainstorm-forcer-status`.
2. Use current phase submission tool to provide complete structured content directly.
3. Call `brainstorm_transition` with `next` only after artifact submission succeeds.
4. Wait while Pi shows the exact active artifact in a scrollable review overlay. Never interpret a transition request as accepted before the tool returns `approved: true`.
5. On rejection, stay in current phase, follow the returned reason, deepen the work, and submit a new artifact revision before requesting `next` again. An omitted reason means investigate gaps, validate assumptions, and go deeper.
6. Use `previous` when evidence or user feedback invalidates earlier reasoning; it also requires user approval.
7. Never start next phase before transition succeeds.
8. Never create implementation plan, select planning workflow, create worktree, commit, or implement code.

Generic file mutation and planning tools are intentionally blocked. Phase submission tools own artifact paths and writes.

## Phase 1 — Discovery

Research codebase and relevant evidence. Do not propose solutions yet.

Submit with `brainstorm_submit_discovery`:

- `filesAccessed`: concrete files or sources inspected;
- `keyFindings`: verified facts;
- `gaps`: unknown or unverifiable points.

After successful submission, call `brainstorm_transition(next)`.

## Phase 2 — Understanding

Use verified Discovery facts. Ask one `ask_user_question` question at a time. Probe purpose, constraints, success criteria, and rejected assumptions.

Submit with `brainstorm_submit_understanding`:

- objective;
- requirements;
- constraints;
- success criteria;
- open questions.

Transition forward is blocked while open questions remain.

## Phase 3 — Exploring

Present 2–3 materially different approaches. For each include summary, trade-offs, critical uncertainties, and failure conditions. Give recommendation, then obtain explicit user choice.

Submit with `brainstorm_submit_exploring`. Transition only after `userChoice` is explicit.

## Phase 4 — Presenting

Present design in small reviewable sections. Cover architecture, components, data flow, error handling, and testing where relevant. Capture feedback and decisions. Ask for explicit final approval.

Submit with `brainstorm_submit_presenting`. `approved` must be true before transition.

## Phase 5 — Documenting

Submit final design with `brainstorm_submit_design`:

- title and summary;
- final design sections;
- decisions;
- residual risks.

Design contains no implementation plan. After successful submission, call `brainstorm_transition(next)` to finish brainstorming. Workflow ends there. User alone decides whether and how planning continues.

## Artifact Revisions

Artifacts live under `docs/brainstorms/`. Returning to earlier phase and resubmitting creates new immutable revision. Downstream artifacts become stale but remain consultable. Read current status or `/brainstorm artifacts` before relying on prior output.

## Principles

- Verified facts over plausible narratives.
- One phase at a time.
- One question at a time during Understanding.
- Explicit alternatives and failure conditions.
- Explicit user choice and approval.
- YAGNI.
- Design only; planning remains separate user decision.
