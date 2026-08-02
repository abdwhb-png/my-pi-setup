# ADR-011: SDD live run observability

## Status

Accepted

## Date

2026-08-02

## Context

After a user approves an SDD manifest, `sdd_prepare` awaits the complete
workflow. The TUI currently falls back to Pi's generic `working...` indicator
during that wait. The user cannot see which manifest task is active, which
subagent or review stage is running, whether tasks are executing in parallel,
or what recent activity explains a long-running delegation.

The missing visibility is not caused by missing runtime data:

- the durable SDD snapshot already records run and task states, planned
  delegations, active request IDs, terminal responses, and review results;
- the public `pi-subagents/delegation` protocol already streams the started
  request, agent model, current tool and compact arguments, recent tools,
  recent output, duration, tool count, and tokens;
- `DelegationClient.run()` already accepts `onStarted` and `onUpdate` hooks;
- the assessment phase already presents streamed progress, but the approved
  workflow does not forward equivalent hooks through `SddWorkflow`;
- Pi executes registered extension commands immediately while the agent is
  streaming, so an inspection command can open during an active
  `sdd_prepare` call.

The existing `pi-subagents-addons` live view owns generic async and fleet
presentation. It does not reliably know the SDD manifest task, workflow stage,
or review attempt associated with a foreground delegation. SDD-specific
observability must preserve those domain relationships without parsing request
IDs or importing `pi-subagents` internals.

## Decision

### Let `sdd-orchestrator` own SDD activity presentation

`sdd-orchestrator` will own a typed activity model and its TUI presentation.
The workflow will publish task transitions and delegation lifecycle events to
an SDD activity sink. Every foreground delegation path, including workers,
corrections, reviewers, and final integration review, will forward the public
`onStarted` and `onUpdate` callbacks already supported by
`DelegationClient.run()`.

The generic subagent addon remains responsible for its current async and fleet
views. SDD may reuse shared rendering, truncation, duration, token, and
redaction helpers, but it will not depend on the addon's private store or infer
SDD ownership from generic fleet entries.

### Maintain one presentation model with durable and live layers

An `SddActivityStore` will index activity by `runId`, `taskId`, and
`requestId`. It will merge two deliberately separate sources:

- **Durable state** comes from the approved manifest and `SddStore` snapshot:
  run state, ordered tasks, profiles, workflow stages, active requests,
  terminal responses, and review outcomes.
- **Live state** comes from bounded public delegation updates: agent, model,
  current tool, compact arguments, recent tools, recent textual output,
  duration, tool count, and tokens.

Durable state remains authoritative. A malformed, delayed, duplicated, or
missing live update must never change workflow state or make the UI claim that
a task succeeded, failed, or stalled. Identical live updates are deduplicated.

Live details remain memory-only. They are not appended to the session or SDD
store because tool arguments and output can contain sensitive content. After a
reload, the UI reconstructs durable state and explicitly reports that previous
live activity is unavailable until another update arrives.

### Show a stable compact widget during active runs

A widget below the editor will appear when an approved workflow starts. It is
limited to five lines and prioritizes stable operational context:

```text
SDD ● running · 2/6 tasks · 3m18s
▸ T2 Implement auth · worker
▸ T3 Update docs · worker
✓ 1 verified · ◌ 3 pending
/sdd-live · +1 active not shown
```

The compact widget shows run state, active task, and subagent or workflow
stage. It intentionally excludes current tools and recent output so rapid
updates do not make the primary TUI noisy or visually unstable. Parallel tasks
receive separate lines, with bounded overflow summarized in the footer.

Cancellation remains `cancelling` until active delegations terminate. When the
run reaches `completed`, `failed`, `needs_input`, or `cancelled`, the widget
briefly displays that terminal state and then disappears because the final
`sdd_prepare` result becomes part of the main transcript.

### Provide responsive details through `/sdd-live`

Register one command:

- `/sdd-live` opens the active run for the current session;
- `/sdd-live <runId>` opens a specific active or completed run;
- if more than one run is active and no ID is supplied, the user selects one.

The command opens immediately during streaming. Opening or closing it never
interrupts, steers, cancels, or otherwise mutates the workflow.

The detail overlay will use the shared `framed-box` composition primitives:

- **Tasks** lists manifest tasks in order with state, profile, and active
  subagent or stage.
- **Activity** shows the selected task's current stage, agent, model, duration,
  tokens, current tool, compact arguments, recent tools, recent output, and
  exact terminal status.

Wide and medium layouts show Tasks and Activity side by side. Compact layouts
show one panel at a time. The active panel uses the same `▸` marker, accent,
and bold treatment as manifest review. `Tab` or horizontal navigation switches
panels; arrows select tasks; Page Up/Down and Home/End scroll activity; `Esc`
or `q` closes the overlay. Selection and scroll positions survive terminal
resize, and every state mutation requests a render.

### Bound and redact all live content before display

Each delegation retains at most:

- eight completed tool entries;
- one separate current tool;
- five recent output lines;
- 240 characters per argument or output line before width-aware rendering.

All arguments and output pass through deterministic control-character removal,
secret redaction, and ANSI-aware truncation before entering the presentation
store. The existing pure telemetry redactor should move behind a shared module
and remain available to its current consumer; SDD must not duplicate secret
patterns in another implementation.

Upstream progress bounds remain useful transport protection but are not treated
as secret redaction. The public adapter's tool sanitization currently
normalizes shapes and strings; it does not establish a confidentiality
boundary.

### Degrade without hiding durable progress

If live delegation updates are unavailable or invalid, the widget and overlay
continue to render the durable run and task states. The detail view reports
`no recent activity` instead of guessing that an agent is stuck. A terminal
delegation error retains its exact protocol status, such as `timed_out`,
`acceptance_failed`, `turn_budget_exhausted`, or `tool_budget_exhausted`.

For non-TUI modes, the widget and overlay are omitted. Existing `sdd_status`
and `sdd_result` structured results remain the observable interface.

## Alternatives Considered

### Extend `pi-subagents-addons` to infer SDD activity

Rejected. The generic addon cannot reliably associate a foreground delegation
with a manifest task, workflow stage, or review attempt. Parsing structured
request IDs would create an undocumented coupling. Adding an SDD-specific
protocol to the generic addon would move domain ownership without reducing the
amount of required integration.

### Poll `SddStore` and generic fleet status

Rejected. Polling can reconstruct durable task state but cannot guarantee the
current tool, recent output, or correct task association for foreground SDD
delegations. It also introduces latency and redundant work despite the existing
event stream.

### Replace `working...` with only the latest tool name

Rejected. A single mutable label does not show the active manifest task,
workflow stage, parallel delegations, completed progress, or terminal reason.
It would improve motion without providing adequate observability.

### Persist the complete activity stream

Rejected. Full arguments and subagent output increase sensitive-data exposure,
storage growth, migration burden, and reload complexity. The durable workflow
snapshot already contains the state needed for recovery and audit.

### Keep a full-screen progress view open for the entire run

Rejected. It consumes too much TUI space and forces monitoring on users who
only need a concise indication. A stable widget plus an on-demand overlay
provides progressive disclosure.

## Consequences

### Positive

- Users can identify the active task and subagent without leaving the main TUI.
- Detailed tools and recent output are available on demand during the run.
- Parallel execution becomes visible without making the compact widget noisy.
- Durable workflow correctness remains independent of transient presentation
  events.
- The design uses public delegation APIs and shared responsive box primitives.
- Failure of the live feed degrades to known durable state rather than false
  status.

### Negative

- `SddWorkflow` gains a presentation-neutral observer boundary across every
  delegation path.
- Live activity is intentionally unavailable after reload until a new update
  arrives.
- Extracting shared redaction requires a compatibility-preserving refactor for
  the existing telemetry consumer.
- The TUI adds another bounded widget and overlay whose lifecycle must coexist
  with other extensions.

### Risks and mitigation

An update can arrive after a request has completed or after a run has been
replaced. The store accepts updates only for the currently correlated
`runId`/`taskId`/`requestId` and ignores stale events.

Rapid progress events can cause excessive rendering. The store deduplicates
unchanged snapshots, keeps bounded collections, and requests a render only
when observable state changes.

Tool arguments or output may contain secrets. Content is redacted before it
enters the presentation store, never persisted, and truncated again for the
available width.

## Verification

Test coverage must prove:

1. exact correlation of runs, tasks, stages, attempts, and request IDs;
2. propagation of started, update, and terminal events through every workflow
   delegation path;
3. deterministic merge, deduplication, ordering, bounds, and stale-event
   rejection in the activity store;
4. secret and control-character redaction before storage or rendering;
5. compact widget behavior for sequential, parallel, overflowing, cancelling,
   and terminal runs;
6. responsive detail rendering in wide, medium, compact, and low-height
   terminals;
7. observable navigation and scroll behavior for legacy terminal sequences and
   Kitty CSI-u encodings;
8. selection and scroll preservation across resize and live updates;
9. immediate `/sdd-live` opening while `sdd_prepare` is still active;
10. safe behavior for missing live updates, reload, malformed updates, multiple
    active runs, and unknown run IDs;
11. unchanged non-TUI behavior for `sdd_status` and `sdd_result`;
12. integration against the public `pi-subagents/delegation` contract without
    imports from `pi-subagents/src/*`.

Final implementation verification will include focused Bun tests, the relevant
Pi runtime integration tests, typecheck, Oxlint, formatting, `git diff --check`,
and the complete agent test suite with unrelated baseline failures reported
separately.
