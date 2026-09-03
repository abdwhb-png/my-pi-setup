# ADR-020: Controlled brainstorm topic and research delegation

## Status

Accepted

## Date

2026-09-02

## Context

Brainstorm Forcer initially derived artifact directories from the full `/brainstorm` prompt. Long conversational prompts produced unstable, unreadable roots before Discovery had established the real design subject.

Discovery and Exploring also exposed generic read-only tools but blocked direct `subagent` calls. In practice, the main model performed large local and external investigations itself, consuming main-session context. The existing `brainstorm-code-scout` handled only local verification, while its name and role overlapped the requested local research capability.

The upstream `brainstorming` skill now preserves destination, known facts, unspecified items, scope exclusions, assumption status, failure conditions, and convergence decisions. Brainstorm Forcer needs those improvements without weakening its five forced phases, artifact gates, direct-evidence policy, or design-only boundary.

## Decision

### Canonical topic at Discovery submission

Treat `/brainstorm <prompt>` as the initial request, not the durable artifact topic. Require `brainstorm_submit_discovery` to provide a bounded canonical `topic` after minimum discovery evidence. Do not create the artifact store during context injection. First Discovery submission fixes:

```text
docs/brainstorms/YYYY-MM-DD-<canonical-topic>/
```

The topic is immutable after first successful submission. Existing artifact roots are never renamed. Explicit manual phase overrides that bypass Discovery retain compatibility by fixing the opening prompt on first artifact write.

### One local Brainstorm agent

Replace `brainstorm-code-scout` with one `brainstorm-scout`. It performs both bounded local-code research and local-code verification. Keep `factual-researcher` for external research and verification. Do not add generic `researcher`, generic `scout`, or a second code-scout route.

Manage `brainstorm-scout` through the same refcounted `createWorkflowAgentGate` pattern used by SDD. Its definition exists while at least one Brainstorm run owns the gate and is removed on stop, reload release, or shutdown.

This gate uses the shared agent directory because pi-subagents static discovery crosses extension API instances. Therefore the definition may be visible to another process while a run holds the lease, and abrupt process termination can leave a stale file. This matches the SDD lifecycle guarantee; it is not strict per-session isolation.

### Dedicated research tool

Add one model-facing tool:

```text
brainstorm_delegate_research({ domain, question, sources })
```

Allow it only in Discovery and Exploring. Route deterministically:

| Domain       | Agent                |
| ------------ | -------------------- |
| `local-code` | `brainstorm-scout`   |
| `external`   | `factual-researcher` |

Run each request with fresh context through the public `pi-subagents/delegation` event boundary. Require strict bounded structured output containing a summary, source-backed findings, and gaps. Preflight only the selected agent under the active read-only capability ceiling.

In Exploring, record the returned result as secondary `EV-*` evidence. Delegation reduces main-context load but never replaces direct evidence for critical empirical claims. Generic `subagent` and `subagent_wait` remain blocked.

### Skill synchronization

Port compatible upstream guidance into the bundled skill:

- name the destination;
- preserve Decisions and known facts, Not yet specified, and Out of scope;
- route uncertainty to the right source of truth;
- classify assumptions as Verified, Falsified, or Unresolved;
- compare failure conditions and reversibility;
- record Selected path, Ruled-out paths, and Remaining uncertainties.

Retain Brainstorm Forcer constraints: exactly five controlled phases, two or three approaches, immutable artifacts, explicit transitions, closed verification routes, no commit, no implementation plan, and no implementation.

## Consequences

Artifact roots become concise and stable under normal flow. Discovery must now name the topic explicitly before writing its first artifact.

Local and external investigations can leave raw work in fresh child contexts while the main model receives only bounded structured findings. This adds child latency and depends on routed agent availability, but preflight fails clearly and does not fall back to generic agents.

One local agent definition removes duplicated roles and configuration. Verification behavior remains closed and direct evidence remains authoritative.
