---
description: Delegate to subagents.
role: atlas-orchestrator
---

Delegate work to subagents. $ARGUMENTS
Load `pi-subagents` as the main orchestration skill to orchestrate subagents.
Express every execution through `subagent({ workflowScript })` with stable `runs.run` / `runs.all` keys. Never send legacy top-level `chain`, `tasks`, or `parallel` payloads.

## Model attribution

When a subagent needs a specific model, follow the tier-based pattern.

### Tiers

| Tier       | Agent types                                         | Need                                 | Primary                  | Advice candidates                                    |
| ---------- | --------------------------------------------------- | ------------------------------------ | ------------------------ | ---------------------------------------------------- |
| **Low**    | quick-worker, delegate, scout                       | Small bounded tasks, code reading/writing | Fastest & cheapest model | paid pool → free pool                                |
| **Medium** | worker, researcher, sdd-orchestrator                | Autonomous implementation, analysis, research, planning | Capable reasoning model | paid pool → free pool                                |
| **High**   | reviewer, oracle                                    | Critical review, strategic decisions | Most capable model       | same-provider backup → paid pool (no free fallback)  |
| **Review** | the reviewer family (see below)                   | Independent pre-merge review lanes    | Per-lane reviewer model  | strong reasoner → strong fast reasoner               |

The review tier covers the general code reviewer plus the security, architecture, interface, performance, and style reviewers, and any plan or architecture advisor the operator defines. Resolve the actual agent names with `subagent({ action: "list", capabilities: true })`; do not assume they exist.

### Rules

1. Classify the subagent into a tier based on task complexity.
2. Primary = best model for the tier — priority: **availability > cost**.
3. Always prefix with the provider lock (`cpa/`) to survive `/model` changes.
4. Record the primary model in `MEMORY.md` and `settings.json` → `subagents.agentOverrides`.
5. Record the per-agent advice candidates in `extensions/pi-subagents-addons/config.json` → `fallbackAdvice.fallbackModels`. Models themselves stay in `settings.json`; only the candidates belong to the addon.

### When a child fails on its provider

`pi-subagents` no longer switches models inside a launch. Automatic switching, including the read-only rate-limit continuation, was removed upstream. The replacement is request-local advice: the `pi-subagents-addons` fallback-advice extension reads the failed child's transcript, and when the child failed on a provider before doing any useful work it appends the failed model plus its ordered candidates to the next parent turn.

- Advice is only produced for a provider failure before useful work. A child that already reasoned or called tools gets no advice, because replaying it would repeat partial effects.
- Advice is a recommendation, never a switch. Inspect the run with `subagent({ action: "status" })`, then decide with the user whether to relaunch and with which model.
- An agent missing from `fallbackModels` produces no advice at all. When adding a reviewer agent, add its candidate list in the same change.
- Never re-launch the same lane with different settings silently. Report the error and the change first.

### Rationale

- Free models unstable → candidates only, never primaries.
- Mixed providers = infrastructure resilience.
- Cost controlled per tier.
- High complexity = zero risk of unavailability → no free fallback.
