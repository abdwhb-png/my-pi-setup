---
name: implement-and-review
description: Full implementation workflow — plan, implement, review, and fix. Runs the recommended pi-subagents loop.
---

## planner
phase: Planning
label: Create implementation plan
as: plan

Study the task and create a concrete implementation plan with file paths, task breakdown, test strategy, and QA steps.

## worker
phase: Implementation
label: Implement the plan

Implement the plan from {previous}. Follow each task in order. Only modify files listed in the plan. Validate that each change works before moving to the next task.

## reviewer
phase: Review
label: Code review

Review the implementation done in the previous step for correctness, test coverage, edge cases, unnecessary complexity, and adherence to the original plan.

Report specific issues with file:line references. Be concrete — not "it could be cleaner" but "src/auth.ts:42-48 duplicates the validation logic from src/utils.ts:15-22".

## worker
phase: Fix
label: Apply review fixes

Apply the fixes identified by the reviewer from {previous}. Address each issue specifically. Do not introduce new changes beyond the fix scope.
