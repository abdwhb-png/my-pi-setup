---
name: implementation-review
description: Post-implementation review chain — scout the codebase for context, then verify plan executability and perform deep code review with severity-rated feedback.
---

## scout
phase: Recon
phaseGroup: 0
label: Codebase deep dive
output: findings.md
as: findings
progress: true

Analyze the codebase for: {task}. Run `git diff` to see what changed, explore the modified files, and understand the data flow.

Identify:
1. **Modified files** — What was changed, added, or deleted.
2. **Relevant context** — Key files, entry points, patterns, and risks.
3. **What needs review** — The scope of the implementation to check.

Write findings to {outputs.findings} so the reviewers have a concrete starting point.

## plan-reviewer
phase: Review
phaseGroup: 1
label: Verify plan executability
reads: findings.md
output: plan-review.md
as: planReview
progress: true

Review the implementation for: {task} against the plan for executability, using the scout findings from {outputs.findings}.

Verify:
1. **References exist** — Do files mentioned in the plan exist? Do they contain the expected code?
2. **Tasks are startable** — Could a developer follow this plan and complete each task?
3. **No blockers** — No contradictions in the plan or impossible requirements.
4. **QA scenarios are concrete** — Each task has a clear way to verify it worked.

Issue a verdict: **OKAY** (plan is sound, implementation follows it), **ITERATE** (fixable gaps, max 3 issues), or **REJECT** (blocking problem needs user decision).

If ITERATE, list exactly what must be fixed. The plan-reviewer checks the plan, not the code style — save code quality findings for the expert-reviewer step.

## expert-reviewer
phase: Review
phaseGroup: 1
label: Deep code review
reads: findings.md
output: code-review.md
as: codeReview
progress: true

Perform an expert code review of the implementation for: {task}, using the scout findings from {outputs.findings}.

Follow the two-stage process:

### Stage 1 — Spec Compliance
Does the implementation cover ALL requirements? Does it solve the RIGHT problem?
Anything missing? Anything extra?

### Root-cause guard
Reject fallback/workaround code that masks failures or avoids fixing the root cause.
Swallowed errors, silent defaults, broad alternate paths — flag them as HIGH or CRITICAL.
Narrow compatibility fallbacks are acceptable if documented, scoped, tested on both paths, and preserve failure evidence.

### Stage 2 — Code Quality
Check for:
- Security issues (hardcoded secrets, injection, XSS)
- Code quality (duplication, complexity, naming)
- Performance concerns (hotspots, N+1 queries, memory leaks)
- Best practices (error handling, logging, type safety)

Run `lsp_diagnostics` on modified files. Use `git diff` to see changes.

Rate each issue by severity: **CRITICAL**, **HIGH**, **MEDIUM**, **LOW**.
Each issue must include a specific file:line reference and a concrete fix suggestion.

Issue a verdict: **APPROVE** (no blockers), **REQUEST CHANGES** (issues worth fixing now), or **COMMENT** (optional improvements only).
