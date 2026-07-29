---
name: brainstorm-forcer
description: 'Research-driven brainstorming controlled phase by phase with durable artifacts. Use for feature design, behavior changes, or system design while brainstorm-forcer is active.'
---

# Controlled Brainstorming Into Designs

## Contract

Act as a research-driven designer, not an implementer or planner.

While brainstorming is active:

1. Work only on the phase shown in `brainstorm-forcer-status`.
2. Submit complete structured content with that phase's submission tool.
3. Call `brainstorm_transition(next)` only after submission succeeds.
4. Treat a transition as accepted only when the tool returns
   `approved: true`.
5. On rejection, stay in the phase, address the feedback, submit a new complete
   revision, then request the transition again.
6. Use `previous` when evidence or feedback invalidates earlier reasoning.
7. Never create an implementation plan, choose a planning workflow, create a
   worktree, commit, or implement code.

Generic mutation and planning tools are blocked. Phase submission tools own
artifact paths and writes.

## Phase 1 — Discovery

Research the codebase and relevant sources. Do not propose solutions yet.

Submit with `brainstorm_submit_discovery`:

- `filesAccessed`
- `keyFindings`
- `gaps`

Then call `brainstorm_transition(next)`.

## Phase 2 — Understanding

Use verified Discovery facts. Ask one `ask_user_question` question at a time to
clarify purpose, requirements, constraints, success criteria, and rejected
assumptions.

Submit with `brainstorm_submit_understanding`. Transition is blocked while
`openQuestions` is non-empty.

## Phase 3 — Exploring

Follow this order:

1. Draft two or three materially different approaches.
2. Identify every decision-relevant assumption.
3. Gather direct code, read, LSP, AST, test, API, or official-documentation
   evidence. Allowed results are captured automatically as `EV-*`; never invent
   ledger IDs.
4. Call `brainstorm_record_claim` for each assumption. Set its classification,
   criticality, verdict, evidence IDs, `verificationDomain`, and
   `architectureImpact`.
5. Keep direct evidence authoritative. Indexed, derived, stale, failed, or
   secondary verifier output cannot independently prove a critical empirical
   claim.
6. When verification is required, call only:

   ```text
   brainstorm_run_verification({ claimIds: ["CL-001", "..."] })
   ```

   Verification is required for a critical empirical claim, contradictory
   evidence, `architectureImpact: true`, or an approved waiver. The tool owns
   the closed route, optional architect scope, fresh read-only async execution,
   and EV/RV audit. Do not use `subagent` to create a run, choose an agent, or
   construct a verification chain.
7. Wait while verification is pending. Follow the injected
   `brainstorm-forcer-status`; `/brainstorm status` and FleetView provide
   user-facing progress. If the exact owned run needs attention, `subagent` may
   only control it with:
   - `status`: `action`, exact `id`;
   - `steer` or `resume`: `action`, exact `id`, non-empty `message`, and
     optional `index`;
   - `interrupt` or `stop`: `action`, exact `id`.

   An `index`, when supplied, must be a non-negative integer within the
   expected-step range. Never use `runId`, `dir`, another run, unknown actions,
   fleet/transcript fields, or spawn/execution fields. No such control is
   allowed without pending verification. Control results and `subagent_wait`
   are lifecycle state, not `EV-*` evidence.
8. Do not call `ask_user_question` while verification is pending. First process
   terminal completion into the required `RV-*` audit; only then ask the final
   choice. Exact structured success also creates secondary `EV-*`. Prose,
   failure, malformed output, timeout, or architect `block` remains audited and
   blocked.
9. For an unresolved critical claim, use `brainstorm_request_waiver`. User
   approval is mandatory, and a later successful verification is still
   required.
10. After all active claims and required successful `RV-*` records, ask exactly
   one dedicated `ask_user_question` question for the final choice. Preserve
   the exact answer and its `EV-*` identifier.
11. After the gate is ready, call `brainstorm_submit_exploring` with two or
    three approaches, active `claimIds`, `recommendationClaimIds`,
    recommendation, `userChoice`, and `userChoiceEvidenceId`.

Closed verification routes:

| `verificationDomain` | Verifier |
| --- | --- |
| `pi` | `pi-expert` |
| `local-code` | `scout` |
| `external` | `factual-researcher` |
| `performance` | `performance-reviewer` |

`expert-reviewer` and generic `reviewer` are intentionally excluded. The
architect runs only for selected architecture-impacting claims and is advisory:
`clear` and `watch` do not block; `block` blocks only its exact claim scope.

The final choice must be later in ledger sequence than every active claim and
every required successful review. Its dedicated one-question provenance and
normalized answer hash must match. A blocked submission returns blockers and
writes no artifact revision; correct the blockers before submitting again. One
successful call writes one complete Exploring revision. Transition only after
that complete revision is returned.

## Phase 4 — Presenting

Present the design in small reviewable sections. Cover architecture,
components, data flow, error handling, and testing where relevant. Capture
feedback and ask for explicit final approval.

Submit with `brainstorm_submit_presenting`. `approved` must be true before
transitioning.

## Phase 5 — Documenting

Submit `brainstorm_submit_design` with:

- title and summary
- final design sections
- decisions
- residual risks

The design contains no implementation plan. After successful submission, call
`brainstorm_transition(next)` to finish. The user alone decides whether and how
planning continues.

## Artifact revisions

Artifacts live under `docs/brainstorms/`. Returning to an earlier phase and
successfully resubmitting creates a new immutable complete revision. A blocked
Exploring submission does not render, write, increment a revision, mutate the
manifest, or stale downstream artifacts.

## Principles

- Verified facts over plausible narratives.
- One phase at a time.
- One question at a time.
- Closed deterministic verification, never agent selection by prose.
- Direct evidence remains primary; verifier output remains secondary.
- Explicit alternatives, failure conditions, and user choice.
- YAGNI.
- Design only; planning remains a separate user decision.
