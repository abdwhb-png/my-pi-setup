---
description: Delegate to subagents.
role: atlas-orchestrator
---

Delegate work to subagents. $ARGUMENTS
Load `subagent-driven-development` as the main orchestration skill coupled with `pi-subagents` skill to orchestrate subagents.
Express every execution through `subagent({ workflowScript })` with stable `runs.run` / `runs.all` keys. Never send legacy top-level `chain`, `tasks`, or `parallel` payloads.

## Model attribution

When a subagent needs a specific model, follow the tier-based pattern.

### Tiers

| Tier       | Agent types                                         | Need                                 | Primary                  | Fallback chain                                      |
| ---------- | --------------------------------------------------- | ------------------------------------ | ------------------------ | --------------------------------------------------- |
| **Low**    | quick-worker, delegate, scout                       | Small bounded tasks, code reading/writing | Fastest & cheapest model | paid pool → free pool                               |
| **Medium** | worker, researcher, sdd-orchestrator                | Autonomous implementation, analysis, research, planning | Capable reasoning model | paid pool → free pool                               |
| **High**   | reviewer, oracle                                    | Critical review, strategic decisions | Most capable model       | same-provider backup → paid pool (no free fallback) |

### Rules

1. Classify the subagent into a tier based on task complexity.
2. Primary = best model for the tier — priority: **availability > cost**.
3. Fallback 1 = different provider for resilience (except High: same provider).
4. Fallback 2 = free pool as last resort (except High: no free fallback).
5. Always prefix with the provider lock (`cpa/`) to survive `/model` changes.
6. Record the decision in `MEMORY.md` and `settings.json` → `subagents.agentOverrides`.

### Rationale

- OpenCode Go always available (2 API keys round-robin, no free rate-limiting).
- Free models unstable → FB2 only.
- Mixed providers = infrastructure resilience.
- Cost controlled per tier.
- High complexity = zero risk of unavailability → no free fallback.
