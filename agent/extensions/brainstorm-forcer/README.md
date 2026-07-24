# brainstorm-forcer

Pi extension that runs brainstorming as a controlled, artifact-backed state machine.

## Workflow

`/brainstorm <topic>` starts immediately in Discovery. While active:

- current status is injected through Pi's `context` hook before every LLM call;
- only adjacent LLM transitions are accepted;
- every phase requires a structured Markdown artifact;
- generic mutation, shell, and planning tools remain blocked;
- completion stops after final design and never starts planning or implementation.

## Commands

- `/brainstorm <topic>` or `/brainstorm start <topic>` — start immediately
- `/brainstorm arm <topic>` — arm without starting an LLM turn
- `/brainstorm status` — show current phase, gate, and restrictions
- `/brainstorm artifacts` — list durable active/stale revisions
- `/brainstorm next` / `/brainstorm previous` — adjacent user transition
- `/brainstorm next --force` / `/brainstorm phase <name|number>` — explicit user overrides
- `/brainstorm stop` — stop workflow

`force` and phase jumps are user commands only. LLM tool cannot skip phases.

## Phase tools

1. Discovery → `brainstorm_submit_discovery`
2. Understanding → `brainstorm_submit_understanding`
3. Exploring → `brainstorm_submit_exploring`
4. Presenting → `brainstorm_submit_presenting`
5. Documenting → `brainstorm_submit_design`

After submitting current phase, LLM calls `brainstorm_transition` with `next`, `previous`, or `status`.

Transition gates:

- every phase needs active artifact revision;
- Understanding needs zero open questions;
- Exploring requires 2–3 approaches and explicit user choice;
- Presenting requires explicit final approval;
- Documenting `next` completes brainstorm without starting planning.

## Artifacts

Each run writes under:

```text
docs/brainstorms/YYYY-MM-DD-<topic>/
```

Files are immutable revisions:

```text
01-discovery-r001.md
02-understanding-r001.md
03-exploring-r001.md
04-presenting-r001.md
05-design-r001.md
manifest.json
```

Resubmitting an earlier phase creates a new revision and marks current/downstream revisions stale. History is preserved. Same-day duplicate topics receive a run-specific suffix.

Writes reuse `pi-scoped-write`: project confinement, traversal/symlink rejection, atomic writes, size limits, hashes, and audit trail. LLM never supplies artifact paths.

## Context status

Exactly one transient `brainstorm-forcer-status` message is present per LLM call. It includes topic, phase, expected submit tool, transition gate, artifact root, active revisions, stale revisions, and design-only restriction. Full artifact content stays on disk and can be read when needed.

## Bundled skill

`skills/brainstorm-forcer/SKILL.md` is registered through `resources_discover`.

## Tests

From `~/.pi/agent`:

```bash
bun test extensions/brainstorm-forcer/index.test.ts extensions/brainstorm-forcer/artifacts.test.ts --isolate
```
