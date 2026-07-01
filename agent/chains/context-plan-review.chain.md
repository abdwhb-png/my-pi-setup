---
name: context-plan-review
description: Build session context, scout codebase, create implementation plan, then review plan for executability. Iteratively refine until OKAY or REJECT.
---

## context-builder
phase: Context
label: Build session context
as: ctx
output: context.md

Build the current session context for {task}. Gather relevant code context, project structure, key files, and write handoff material: context.md with findings and meta-prompt.md with task-specific guidance.

## scout
phase: Recon
label: Codebase deep dive
reads: context.md
output: findings.md
as: findings

Analyze the codebase for {task} using the context from {outputs.ctx}. Identify relevant files, entry points, data flow, risks, and what needs to change.

## planner
phase: Planning
label: Implementation plan
reads: context.md+findings.md
progress: true

Use `writing-plans` skill to create a concrete implementation plan based on the scout's findings from {outputs.findings} and the context from {outputs.ctx}. Include file paths, task breakdown, and test strategy.

## plan-reviewer
phase: Review
label: Plan review
reads: context.md+findings.md
output: review.md
progress: true

Review the implementation plan from {previous} for executability.

Verify:
1. **References exist** — Do mentioned files actually exist? Do line numbers point to relevant code?
2. **Tasks are startable** — Can a developer begin each task with the given context?
3. **No impossible requirements** — No contradictions or blocked dependencies.
4. **QA scenarios are concrete** — Each task has a clear way to verify it worked.

Issue a verdict: **OKAY**, **ITERATE** (fixable gaps, max 3 issues), or **REJECT** (blocking problem needs user decision).

If ITERATE, list exactly what the planner must fix. The chain will loop back if needed.