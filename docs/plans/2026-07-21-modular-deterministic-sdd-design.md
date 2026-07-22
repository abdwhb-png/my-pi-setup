<!-- markdownlint-disable MD013 -->

# Modular Deterministic SDD Orchestration

**Date:** 2026-07-21

**Status:** Implemented, review-corrected, and performance-hardened for `pi-subagents@0.35.1`

**Targets:** `agent/extensions/sdd-orchestrator/`, `agent/roles/planning-base.md`, `agent/roles/sdd-plan.md`, `agent/roles/plan.md`, `agent/roles/quick-planner.md`, `agent/agents/`

## Context

The current Subagent-Driven Development workflow provides strong quality guarantees but applies its most expensive structure whenever SDD is selected: a fresh implementer per task, an independent specification review, an independent code-quality review, correction loops, and a final review. This is appropriate for critical changes but unnecessarily expensive for routine tasks inside an otherwise important plan.

The current local `sdd-orchestrator` does not yet provide autonomous programmatic orchestration. Its extension parses a Markdown plan and writes queue/progress/result files, while a separate `sdd-orchestrator` LLM agent must be launched manually to poll and consume the queue. A queue item created on 2026-06-28 remains queued, demonstrating that submission does not guarantee execution.

The current planning contract is also inconsistent. The `plan` role describes generic numbered steps, `writing-plans` emits `### Task N` sections, and `sdd-orchestrator` extracts tasks with a Markdown-heading regular expression. Execution therefore depends on how an LLM happened to format the plan.

The desired system must preserve SDD's quality principles while making orchestration proportional, explicit, deterministic, resumable, and user-approved.

## Goals

- Keep TDD and concrete verification mandatory for every implementation profile.
- Select orchestration per task under one user-selected global profile.
- Use an LLM to analyze complexity, not to choose or mutate the execution workflow.
- Compile human-readable plans into validated, machine-readable execution manifests.
- Show the recommended strategy and exceptions before a single approval.
- Execute an approved manifest autonomously without a polling LLM agent.
- Put hard, programmatic ceilings on agent launches and correction loops.
- Resume safely after interruption or Pi restart.
- Continue using the installed `pi-subagents` package through its public interfaces.
- Do not fork `pi-subagents` for the first implementation.

## Non-goals

- Replacing `pi-subagents` as the subagent execution engine.
- Replacing `plan-reviewer` or merging complexity assessment into it.
- Making `quick-planner` run expensive analysis by default.
- Giving an LLM authority to select profiles, dependencies, parallelism, retries, or review loops during execution.
- Requiring user confirmation between ordinary task transitions.
- Building the future `pi-subagents-addons` package as part of this work.

## Core decision

Use a hybrid decision model:

1. The planning workflow produces a stable implementation plan.
2. A dedicated read-only LLM analyzes each task into structured, evidence-backed signals.
3. A deterministic TypeScript rules engine converts those signals into profile recommendations.
4. The user approves or edits one execution manifest.
5. A programmatic state machine executes only the approved manifest.

The LLM is an analyzer. The extension is the decision engine. The user remains the final authority.

## Performance controls

- `orchestration-assessor` uses medium reasoning and runs once per validated plan/assessor contract digest. Successful schema-valid results are cached durably; concurrent identical preparation calls share one launch. Failed or corrupt results are never reused.
- `pi-subagents` keeps its public API unchanged. Its intercom bridge is configured as `fork-only`, so fresh SDD children cannot trigger foreground detachment while ordinary forked workers retain supervisor coordination.
- Light tasks use the strict fresh `quick-worker` with medium reasoning and a 16+4 turn ceiling. It never promotes itself or contacts a supervisor.
- Standard and Critical tasks use the fresh autonomous `sdd-worker` with high reasoning and the normal generous writer budget.
- Both SDD writers return an exact `BLOCKED:` contract when an unapproved decision is required. The workflow maps it to `needs_input` and exposes the worker output through `sdd_status`.

## Planning-role separation

Planning workflows are selected explicitly by the user and never route to one another. `planning-base` supplies only shared discovery, ambiguity resolution, evidence, decomposition, and verification rigor. Its children replace the tool list and own their complete persistence, review, approval, and handoff semantics.

- `plan` is exclusively the durable-file and Plannotator workflow. It preserves browser annotations, repeated submission of the same file, and the configured automatic implementation-role handoff. It contains no SDD or quick-planning routing.
- `sdd-plan` is exclusively the deterministic SDD workflow described below. It owns compiler syntax, plan review, assessment, manifest approval, orchestration observation, cancellation, and recovery.
- `quick-planner` is exclusively the lower-latency `session_plan` workflow. It contains no SDD or Plannotator routing and performs no automatic independent review or assessment.

The `sdd-plan` role follows this workflow:

1. Discover the relevant code and project constraints.
2. Resolve product and technical ambiguities with the user.
3. Write the human-readable implementation plan.
4. Run `plan-reviewer` to validate references, task executability, blockers, and QA scenarios.
5. After the plan is stable, run one `orchestration-assessor` job. Only a schema-invalid response may trigger one bounded format-repair retry; it does not authorize a second independent assessment.
6. Compile the plan, assessment, and deterministic rules into an execution manifest.
7. Present the manifest in one review surface.
8. Let the user accept it, change the global profile, override individual tasks, disable parallelism, or return to planning.
9. Freeze the approved manifest and execute it autonomously.

When a Direct task reaches `awaiting_direct_agent`, `sdd-plan` does not switch roles automatically. It stops at the durable boundary and asks the user to switch manually to an implementation role. That role implements the approved task and submits exact evidence with `sdd_direct_complete` before deterministic execution resumes.

## Separation of plan review and orchestration assessment

`plan-reviewer` remains unchanged in purpose. It answers whether a capable developer can execute the plan without getting stuck. Its approval bias, narrow blocker checks, and `OKAY`/`ITERATE`/`REJECT` verdicts are valuable precisely because it does not judge architecture quality or orchestration intensity.

A new read-only `orchestration-assessor` analyzes complexity and risk. It uses a separately configurable capable model and returns schema-validated structured output. It must:

- identify observable signals per task;
- cite the plan or code evidence supporting each signal;
- report uncertainty explicitly;
- recommend a minimum profile only as advisory metadata;
- never edit files, plans, manifests, or code;
- never launch implementation agents;
- never decide dependencies, parallelism, or the final workflow.

Its output includes at least:

- estimated file scope;
- module and contract boundaries crossed;
- task dependencies;
- architecture novelty;
- regression risk;
- data, migration, authorization, security, financial, concurrency, and infrastructure sensitivity;
- requirements clarity;
- testability and existing test coverage;
- unresolved uncertainty;
- confidence in the assessment.

Invalid or incomplete structured output fails assessment visibly. It is never silently interpreted as a low-risk result.

## Global profiles and per-task overrides

Every manifest has one global profile. Each task receives a recommended effective profile derived from the global default and its assessed signals. The review UI shows every deviation from the global profile and its reason.

### Direct

- Implementation stays in the main agent session.
- TDD and project verification remain mandatory.
- No implementation or review subagent is launched.
- No orchestrated correction loop exists.
- The task enters `awaiting_direct_agent`; the main agent completes it through an explicit `sdd_direct_complete` evidence handoff.

Suitable for tightly scoped, unambiguous changes with no sensitive or cross-module impact.

### Light

- One medium-reasoning `quick-worker` implements the task.
- The worker follows TDD, runs required validation, and self-reviews.
- The worker returns `BLOCKED:` instead of widening scope or promoting itself.
- No independent reviewer is launched.
- No orchestrated correction loop exists.

Suitable for isolated work in one coherent module with clear behavior and tests.

### Standard

- One high-reasoning autonomous `sdd-worker` implements the task.
- One independent reviewer combines specification-compliance and code-quality review.
- At most one correction loop is allowed.
- A correction launches a fresh worker with the approved task, the previous worker's report and artifacts, and the review findings.
- The combined reviewer runs again after correction before the task can become verified.

Suitable for cross-module changes, public behavior changes, new contracts, integrations, meaningful uncertainty, or weak surrounding test coverage.

### Critical

- One high-reasoning autonomous `sdd-worker` implements the task.
- Specification and code-quality reviews are performed separately.
- At most two correction loops are allowed across the entire task, not two independent budgets per reviewer.
- Each correction launches a fresh worker with the complete bounded correction context; no child session continuation is assumed.
- The review stage that rejected the implementation runs again after correction.
- A final integration review runs only when the manifest-level rules require it.

Suitable for migrations, data transformation, authentication, authorization, secrets, financial logic, concurrency, resource lifecycle, shared infrastructure, difficult rollback, Pi core behavior, inter-extension protocols, or unresolved architectural uncertainty.

## Deterministic classification rules

Classification uses categorical rules, not an opaque aggregate score.

- One critical signal establishes `Critical` as the recommended minimum.
- Standard signals establish `Standard` according to explicit combinations recorded in configuration and tests.
- Low assessor confidence raises the recommendation by one level and never lowers it.
- A task may be recommended below the global profile only when its low-risk conditions are positively established; missing evidence is not evidence of simplicity.
- The rules engine records every rule that affected the result.
- Rule versions are stored in the manifest so a resumed run does not change behavior after configuration updates.

The user may override any recommendation. An untouched review starts with each task's recommended deviation from the global profile already selected, so a one-click approval cannot silently replace the recommendation with the global default. Lowering a `Critical` recommendation below `Standard` requires a separate confirmation and a justification stored in the manifest. This is a warning and audit mechanism, not an absolute prohibition.

## Execution manifest

Markdown remains the human review artifact. It is not the runtime protocol. A compiler produces a validated JSON manifest with a versioned schema.

The manifest includes:

- manifest and rule-set versions;
- source plan path and content digest;
- assessment digest and model metadata;
- global profile;
- per-task stable IDs, descriptions, effective profiles, reasons, dependencies, file scopes, parallelism eligibility, acceptance requirements, and budgets;
- user overrides and justifications;
- approval identity and timestamp;
- run and child IDs once execution begins;
- current manifest and task states;
- append-only transition references.

Declared task files use one project-relative lexical identity. The compiler normalizes separators and `.`/`..` segments, rejects absolute paths and paths escaping the project root, and removes duplicate aliases before dependency and parallelism checks. This policy is lexical: symbolic-link resolution remains a project/runtime concern and is not used to authorize paths outside the project.

Execution is rejected if the plan digest no longer matches the approved source. The user must regenerate or explicitly reapprove the manifest after plan changes.

## Programmatic orchestrator

The extension becomes the sole workflow controller. The existing background `sdd-orchestrator` LLM agent and manual queue-polling requirement are removed from the execution path.

The installed and verified `pi-subagents@0.35.1` package exports the public `pi-subagents/delegation` contract. The orchestrator uses its versioned `prompt-template:subagent:*` event transport:

- `prompt-template:subagent:request` starts one configured foreground agent;
- `prompt-template:subagent:started`, `update`, and `response` provide correlated lifecycle events;
- `prompt-template:subagent:cancel` cancels the correlated request;
- requests can select the agent, model, cwd, context, timeout, turn and tool budgets, acceptance policy, output behavior, and artifact capture;
- responses distinguish completion, failure, timeout, cancellation, interruption, budget exhaustion, acceptance failure, invalid requests, and unavailable context.

This public API is single-agent and foreground-only. It has no `resume`, `steer`, `append-step`, child-session input, or `outputSchema` request field. The detached RPC still exposes only `ping`, `status`, `spawn`, `interrupt`, and `stop`. Consequently:

- every implementation, review, and correction is a separately correlated delegation;
- corrections never depend on continuing a prior child session;
- assessor and reviewer final outputs are parsed as JSON and validated locally against versioned TypeBox schemas;
- invalid structured output follows a bounded validation-retry policy and is never interpreted as approval; reviewer format retries consume the approved reviewer-attempt and launch ceilings rather than expanding them;
- the extension never imports `pi-subagents` internals, calls its LLM-facing tool, parses terminal rendering, or spawns another Pi executable.

The delegation contract requires an active extension context. The engine persists the intended transition and request ID before emitting the request, then persists progress and the terminal response before advancing.

## State machine

Manifest states:

```text
draft
  -> assessed
  -> awaiting_approval
  -> approved
  -> running
       -> needs_input
       -> failed
       -> cancelled
       -> completed
```

Task states:

```text
pending -> awaiting_direct_agent -> verified
   |
   +-> implementing -> reviewing -> fixing -> reviewing -> verified
               |              |          |
               +--------------+----------+-> needs_input | failed | cancelled
```

Allowed transitions are encoded and tested explicitly. Every transition is persisted before the next external action. Repeated commands use idempotency keys so retries cannot launch duplicate workers or reviewers.

Within one extension runtime, execution is single-flight per run ID: concurrent approval, startup-resume, or explicit run calls join the same promise. They do not reconcile or launch a second copy of an already active run. Persisted revision and approval digests remain the cross-restart idempotency boundary.

## Delegations and conditional execution

`pi-subagents` executes each approved stage after a profile has been selected; it does not select the profile. The public foreground delegation API is deliberately single-agent, so the extension state machine owns conditional sequencing instead of trying to encode dynamic decisions in a static package chain.

- Direct tasks are executed by the main agent through the persisted `awaiting_direct_agent` handshake.
- Light tasks launch one worker.
- Standard tasks launch a worker, then a combined reviewer, then conditionally a fresh correction worker and one re-review.
- Critical tasks launch a worker, a specification reviewer, and a quality reviewer. A rejecting stage may launch a fresh correction worker and then re-run that stage, subject to one shared correction budget.

Conditional corrections are decided from schema-validated reviewer results and remaining numeric budgets, never from open-ended controller prose. Static `pi-subagents` chains remain available elsewhere but are not the runtime protocol for this state machine.

## Parallelism policy

- Independent read-only tasks may run concurrently.
- Writer tasks may run concurrently only when isolation or independence is demonstrated.
- Worktree-isolated writer tasks may run concurrently when their declared contracts do not conflict.
- Tasks modifying shared files or contracts run sequentially.
- Declared dependencies always take precedence over parallelism.
- The initial default permits at most two concurrent writers; configuration may lower or raise this value.
- The rules engine records why every task is or is not parallelizable.

Parallelism is planned and approved in the manifest. The executing LLM cannot introduce new fan-out.

## Review and correction budgets

Budgets are global programmatic limits, not prompt suggestions.

- Direct: zero child launches.
- Light: one worker launch.
- Standard: one initial worker, at most one fresh correction worker, and at most two combined-review attempts; maximum four child launches.
- Critical: one initial worker, at most two fresh correction workers, and only the rejecting review stage is repeated; maximum seven child launches before an optional manifest-level integration review.

A final plan-level integration reviewer runs only when at least one task is Critical, multiple tasks modify a shared contract, cross-module integration is present, or the approved manifest requests it.

Exhausting a budget fails or pauses the task according to the recorded policy. The orchestrator never silently expands the budget.

## User interaction

The manifest review surface shows:

- the recommended global profile;
- each task and effective profile;
- every upward or downward deviation;
- evidence and rules behind each recommendation;
- dependency and parallelism structure;
- estimated qualitative duration;
- maximum possible worker, reviewer, and correction launches;
- Critical downgrade warnings.

The user approves once before execution. The system pauses later only for a genuine missing decision, a material scope change, a stale plan digest, an exhausted budget requiring expansion, or an unrecoverable failure.

Interactive Pi uses one native manifest-review overlay with deterministic controls for the global profile, per-task overrides, parallelism, optional final integration review, Critical downgrade justification, and final approval. The launch preview immediately includes a user-requested integration review; rule-required integration reviews cannot be disabled. The overlay returns a typed decision object; prose is not used as the approval protocol. RPC, print, and other non-interactive modes use the equivalent structured `sdd_approve` tool contract, including the optional `finalIntegrationReview` boolean. Ordinary Plannotator plan approval remains available for non-SDD planning, but an SDD manifest writes its own `sdd:manifest-approved` entry so `plan-auto-switch` cannot confuse the two workflows.

## Failure and recovery behavior

- Spawn failure never falls back silently to direct implementation.
- A blocked worker moves only its task to `needs_input`; completed independent work remains valid.
- A timeout permits at most one policy-authorized relaunch or model fallback. It cannot create an unbounded retry cascade.
- Reviewer rejection consumes the task's shared correction budget.
- Invalid reviewer output fails the review step visibly and follows a separately bounded retry policy.
- A Pi restart reconstructs state from the manifest and append-only transition log.
- A foreground delegation that had no persisted terminal response at restart is treated as externally uncertain. It is moved to `needs_input` and is never relaunched automatically, preventing duplicate writers. The user may inspect the recorded request, working tree, and artifacts, then explicitly retry or attest completion.
- Recovery attestation uses the optional typed `sdd_direct_complete.recovery` object only at that uncertain `needs_input` boundary: `{ action: "attest", confirmation: true, authorizedBy, requestId, stage }`. The request and stage must exactly match the persisted delegation. One atomic reducer event stores a canonical SHA-256 binding over the authorization, request, stage, and full evidence; synthesizes and applies the accepted terminal response and any reviewer pass; clears the stale active request; and resumes at the profile's next required stage. Only a profile-terminal stage may verify the task. Identical retries are idempotent; missing or mismatched attestations remain `needs_input`.
- Completed terminal responses that were persisted before restart continue normally from the next legal transition.
- Startup decides continuation from the current post-reconciliation snapshot. It resumes only durable pending or applied resumable stages with no active uncertain request or cancellation, and never resumes Direct waits or `needs_input` automatically.
- Reconciliation never marks a task complete from prose alone; required structured evidence and acceptance status must exist.
- The Pi tool `AbortSignal` is propagated through assessment, approval execution, Direct continuation, workers, and reviewers. Aborting a running tool first persists the cancellation and correlated request IDs, then emits `prompt-template:subagent:cancel`; the terminal response is reconciled afterward.
- Unknown future lifecycle fields or events are ignored for forward compatibility.

## Observability

Every run exposes through `sdd_status` and `sdd_result`:

- current manifest and task states;
- selected profiles and rule explanations;
- active correlated `pi-subagents` request IDs and, when the public terminal response provides one, the child run ID;
- elapsed time and qualitative estimate drift;
- launches and correction budget consumed/remaining;
- reviewer verdicts and acceptance evidence;
- blocked decisions and recovery actions.

Observability reads the manifest and public lifecycle artifacts. It does not scrape rendered terminal output.

The structured observation contains the approved manifest, durable snapshot,
selected profile/rule/signal details, active request/stage records, elapsed time,
qualitative estimate and drift, launch/correction budget accounting, reviewer
verdicts, acceptance evidence, blocked decisions, and recovery actions.

## Testing strategy

Implementation must follow repository TDD rules.

### Pure unit tests

- signal validation and normalization;
- every classification rule and rule combination;
- confidence-based escalation;
- global-profile deviations;
- Critical downgrade confirmation requirements;
- plan digest and manifest schema validation;
- budget calculation;
- dependency graph and parallelism decisions;
- all legal and illegal state transitions;
- idempotency behavior.

### Extension and RPC tests

- delegation request/start/update/response correlation and timeouts;
- cancellation, malformed responses, duplicate responses, and late responses;
- confirmation that only the public `pi-subagents/delegation` export is consumed;
- task progression for all four profiles;
- correction-budget exhaustion;
- fresh correction-worker context contains the prior report, artifacts, and exact review findings;
- restart reconciliation moves an unterminated foreground delegation to `needs_input` without duplicate launch;
- no duplicate child launch after retry or restart.

Use plain `bun:test` with real module imports for pure logic. Use the Pi test harness only where lifecycle events, tool wrapping, UI interaction, or real session behavior are essential.

At least one boundary test loads `registerSddExtension` through the Pi test harness and executes a real registered SDD tool. External model delegation remains faked, but tool registration, TypeBox parameter validation, extension lifecycle, and Pi result collection are exercised by the actual runtime.

### End-to-end scenarios

- one representative run for Direct, Light, Standard, and Critical;
- mixed-profile plan with dependencies and safe parallel work;
- Critical downgrade with recorded justification;
- blocked worker followed by user resolution and an explicit fresh retry;
- Pi restart during implementation and during review, both failing safe without automatic relaunch;
- reproduction of the previously slow workflow with assertions on maximum child launches and correction loops;
- verification that `planning-base` remains workflow-neutral, `plan` remains Plannotator-only, `sdd-plan` owns the complete deterministic contract, and `quick-planner` contains no SDD or Plannotator routing.

Required final gates are the focused tests, the full project test suite, typecheck, `bun run lint`, and unwanted-artifact inspection. Build or dev commands remain out of scope unless separately approved.

## Migration

1. Keep the existing tools available while introducing versioned manifests behind an explicit experimental command.
2. Add assessment and manifest review without changing current execution.
3. Add programmatic execution through the public `pi-subagents@0.35.1` foreground delegation contract.
4. Validate all profiles and restart recovery in opt-in mode.
5. Switch the `plan` handoff to manifest approval and programmatic execution.
6. Retire the manual queue-polling agent after confirming no active legacy run depends on it.

The existing queued legacy run must be inspected and handled explicitly during migration. It must not be silently executed or deleted.

## Alternatives rejected

### Let the planning LLM select the workflow

Rejected because the same plan can produce different execution structures across models or runs, and budgets remain unenforceable.

### Ask an assessor for a numeric complexity score

Rejected because a single score hides evidence and creates arbitrary thresholds. Structured categorical signals are more auditable.

### Use `plan-reviewer` for complexity assessment

Rejected because its existing responsibility and approval-biased decision framework intentionally exclude broader architecture and risk judgments.

### Use a static chain for all important plans

Rejected because it pays the maximum orchestration cost for every task and cannot express approved per-task profiles efficiently.

### Keep the LLM queue poller

Rejected because execution depends on remembering to launch it, consumes a capable model for mechanical coordination, and leaves deterministic state transitions unenforced.

## Accepted outcome

The resulting system is modular SDD with deterministic control:

- models inspect, implement, and review;
- schemas constrain their outputs;
- rules select and cap orchestration;
- `pi-subagents` executes children;
- fresh correction workers replace unavailable child-session continuation;
- the extension owns durable state and recovery;
- the user approves one transparent strategy before autonomous execution.
