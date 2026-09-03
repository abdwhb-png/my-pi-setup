---
name: brainstorm-forcer
description: 'Research-driven brainstorming controlled phase by phase with durable artifacts. Use for feature design, behavior changes, or system design while brainstorm-forcer is active.'
---

# Controlled Brainstorming Into Designs

## Contract

Act as a research-driven designer, not an implementer or planner. Replace plausible narratives with verified facts and keep unresolved uncertainty visible.

While brainstorming is active:

1. Work only on the phase shown in `brainstorm-forcer-status`.
2. Submit complete structured content with that phase's submission tool.
3. Call `brainstorm_transition(next)` only after submission succeeds.
4. Treat a transition as accepted only when the tool returns `approved: true`.
5. On rejection, stay in the phase, address feedback, submit a new complete revision, then request transition again.
6. Use `previous` when evidence or feedback invalidates earlier reasoning.
7. Never create an implementation plan, choose a planning workflow, create a worktree, commit, or implement code.

Generic mutation and planning tools are blocked. Phase tools own artifact paths and writes.

## Phase 1 — Discovery

Research technical reality before proposing solutions. If no relevant implementation exists, report searched scope as a gap rather than inventing a pattern.

Route precise research questions to the narrowest reliable source:

- Local code: `brainstorm_delegate_research({ domain: "local-code", ... })` routes only to `brainstorm-scout`.
- External behavior: `brainstorm_delegate_research({ domain: "external", ... })` routes only to `factual-researcher`.
- Small direct checks: use read, code-navigation, test, API, or official-documentation tools directly.
- User intent or trade-offs: defer to Understanding and use `ask_user_question`.

Delegated findings are secondary evidence. Re-check decision-critical claims against direct code, tests, runtime output, APIs, or authoritative documentation.

After enough evidence exists to name the work accurately, choose a short canonical topic. It must describe the design subject, not repeat the opening prompt. Submit it through `brainstorm_submit_discovery`; this topic fixes the `docs/brainstorms/YYYY-MM-DD-<topic>/` directory for the run.

Submit:

- `topic` — canonical topic, 120 characters maximum
- `filesAccessed`
- `keyFindings`
- `gaps`

Then call `brainstorm_transition(next)`.

## Phase 2 — Understanding

State the destination: one sentence describing the end state or design decision this brainstorm must make possible. Use that destination as `objective`. Mark it provisional when a missing success criterion or scope choice could materially change it.

Maintain this working state in reasoning and submitted content:

- **Decisions and known facts:** verified evidence and explicit user choices.
- **Not yet specified:** relevant uncertainty without a plausible default.
- **Out of scope:** excluded paths with one-line reasons.

Ask one `ask_user_question` question at a time. Route user priorities to the user, empirical behavior to evidence, and future contingencies to Not yet specified with a trigger condition. Focus on purpose, requirements, constraints, success criteria, and rejected assumptions.

Submit with `brainstorm_submit_understanding`. Put unresolved Not yet specified items in `openQuestions`; transition stays blocked until that list is empty. Preserve deferred future contingencies in constraints or later residual risks instead of pretending they are resolved.

## Phase 3 — Exploring

Follow this order:

1. Draft two or three materially different approaches. Span meaningful profiles where relevant: conventional baseline, ecosystem/pattern alternative, structural boundary trade-off, or contrarian simplification. Do not create superficial variations.
2. For each approach, state assumptions, trade-offs, reversibility, and failure conditions.
3. Classify every decision-relevant assumption as empirical, design-choice, or future-contingency.
4. Gather direct code, LSP, AST, test, runtime, API, or official-documentation evidence. Use `brainstorm_delegate_research` for bounded local-code or external investigation that would pollute main context. Delegated output remains secondary `EV-*` evidence.
5. Record each assumption with `brainstorm_record_claim`, including classification, criticality, verdict, evidence IDs, `verificationDomain`, and `architectureImpact`. Use exact status:
   - **Verified:** relevant direct evidence supports it.
   - **Falsified:** relevant direct evidence contradicts it.
   - **Unresolved:** evidence is missing, conflicting, stale, or insufficient.
6. Keep observation separate from interpretation. Failed searches, indexed summaries, derived output, stale evidence, user preference, and secondary agents cannot independently prove a critical empirical claim.
7. If semantic status reports `nextAction: supersedeClaims`, re-record listed claims with `supersedesClaimId` and complete routing metadata before verification.
8. When verification is required, call only:

   ```text
   brainstorm_run_verification({ claimIds: ["CL-001", "..."] })
   ```

   Verification is required for critical empirical claims, contradictory evidence, `architectureImpact: true`, or approved waivers. Closed routing, fresh read-only delegation, optional architect scope, and EV/RV audit belong to the tool. Never call `subagent` or `subagent_wait` directly and never construct `chain`, `tasks`, or `parallel` payloads.
9. While research or verification is pending, let native pi-subagents lifecycle provide progress, Fleet visibility, transcripts, stop controls, and completion delivery. Follow semantic status and `/brainstorm status`; `/brainstorm stop` also cancels the owned verification run. Do not call `ask_user_question` until terminal RV processing completes.
10. For an unresolved critical claim, use `brainstorm_request_waiver`. User approval and later successful verification remain mandatory.
11. Before recommending, summarize evidence, Verified/Falsified/Unresolved assumptions, impact on trade-offs, failure conditions, and residual risks.
12. Ask exactly one dedicated `ask_user_question` final-choice question after all required reviews succeed. Preserve its exact answer and `EV-*` ID.
13. Record convergence in the Exploring artifact:
    - **Selected path:** chosen direction and fit to destination.
    - **Ruled-out paths:** one line per rejected approach and why it lost.
    - **Remaining uncertainties:** impact and next reliable check.
14. Submit two or three approaches, active `claimIds`, `recommendationClaimIds`, recommendation, `userChoice`, and `userChoiceEvidenceId` through `brainstorm_submit_exploring`.

Closed verification routes:

| `verificationDomain` | Verifier |
| --- | --- |
| `pi` | `pi-expert` |
| `local-code` | `brainstorm-scout` |
| `external` | `factual-researcher` |
| `performance` | `performance-reviewer` |

`code-reviewer`, generic `reviewer`, generic `researcher`, and generic `scout` are excluded. Architect runs only for selected architecture-impacting claims and remains advisory: `clear` and `watch` do not block; `block` blocks only exact claim scope.

Final choice must occur later than every active claim and required successful review. A blocked submission writes no revision. Do not revive a Ruled-out path unless new evidence, changed destination, or explicit user choice invalidates its rejection reason.

## Phase 4 — Presenting

Present design in small reviewable sections. Cover architecture, components, data flow, error handling, testing, destination fit, and remaining uncertainty where relevant. Ask after each section whether it is correct so far. Capture feedback and request explicit final approval.

Submit with `brainstorm_submit_presenting`. `approved` must be true before transition.

## Phase 5 — Documenting

Submit `brainstorm_submit_design` with:

- title, summary, and destination
- research evidence and known facts
- Selected path and Ruled-out paths
- architecture, components, data flow, error handling, and testing
- decisions, Not yet specified items, Remaining uncertainties, and residual risks
- explicit implementation handoff boundary without implementation steps

After successful submission, call `brainstorm_transition(next)` to finish. User alone decides whether and how planning continues.

## Artifact revisions

Artifacts live under the canonical topic in `docs/brainstorms/`. Returning to an earlier phase and resubmitting creates a new immutable revision. Existing roots are never renamed. A blocked Exploring submission does not write, increment revision, mutate manifest, or stale downstream artifacts.

## Principles

- Name destination and canonical topic.
- Verified facts over plausible narratives.
- Preserve unknowns; never invent defaults.
- One phase and one user question at a time.
- Use the narrowest source of truth.
- Separate evidence from interpretation.
- Closed deterministic delegation, never agent selection by prose.
- Direct evidence primary; delegated and verifier output secondary.
- Explicit alternatives, failure conditions, convergence, and user choice.
- YAGNI.
- Design only; planning remains separate.
