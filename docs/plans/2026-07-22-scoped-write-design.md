# Scoped Write: Intentional, Audited Non-Implementation Writes

**Date:** 2026-07-22

**Status:** Implemented for scoped plans and common reports

**Targets:** a future shared Pi extension for scoped write tools, plus opt-in role and extension configuration

## Context

Several roles must create durable artefacts without receiving general code-modification authority. Examples include plans, research notes, QA reports, browser-validation evidence, and extension-owned run artefacts.

Pi's native `write` and `edit` tools express filesystem mutation, not intent. They cannot programmatically distinguish a harmless report from an implementation change. Content classification would be unreliable: Markdown can include executable instructions, while JSON, YAML, scripts, tests, and source code can all alter runtime behavior.

The existing `write_plan` and `edit_plan` helpers already demonstrate the appropriate direction: restrict a tool to a validated filesystem scope rather than trusting a prompt to avoid implementation.

## Goals

- Let a non-implementation role write only artefacts explicitly authorised by its tool.
- Make write authority enforceable by path, extension, operation, and size; never by LLM intent.
- Provide a common project-local artefact root: `<cwd>/.pi/artifacts/`.
- Allow an extension to retain an explicit specialised root where that is more coherent, such as `.sdd/artifacts/<run-id>/`.
- Audit every successful mutation with hashes and contextual metadata.
- Provide a targeted, confirmed purge facility for completed or obsolete runs.
- Reuse one internal policy and filesystem implementation while exposing tools whose names state their purpose.

## Non-goals

- Do not create a generic `write_without_implementation` tool.
- Do not infer whether content is code, configuration, documentation, or implementation.
- Do not grant native `write`, native `edit`, or a general write-capable shell to non-implementation roles.
- Do not make artefact retention automatic in the first version.
- Do not silently delete an entire artefact root or another extension's artefacts.

## Design principles

1. **Capability, not instruction.** A role receives an operation on a narrow resource class, never a broad mutation capability plus a prompt prohibition.
2. **Intent is visible.** The model invokes `write_plan`, `write_report`, or another domain-specific tool rather than an ambiguous filesystem tool.
3. **Default-deny.** A policy must explicitly allow the root, extension, operation, and size. Anything else fails before disk I/O.
4. **Project-local by default.** Common artefacts live under `<cwd>/.pi/artifacts/`, keeping evidence with the repository while remaining outside source directories.
5. **Traceable mutations.** A successful write is not considered complete unless its audit event is durably recorded.
6. **Extension ownership is explicit.** An extension may opt into another root only by declaring it in its policy; it is never inferred from a path supplied by the model.

## Architecture

```text
Role tool: write_report / edit_report / write_plan
                         |
                         v
                 scoped-write registry
                         |
        policy lookup and input validation
                         |
                         v
       path resolver + extension/size/operation guard
                         |
                         v
         atomic filesystem mutation within allowed root
                         |
                         v
       append-only audit event or reported write failure
```

The shared engine is an internal module, tentatively named `scoped-write`. It owns path resolution, policy enforcement, atomic writes, hashes, and audit recording. It does not decide which tools to register.

An extension or role-facing adapter registers an intentional tool and supplies a static policy. The model can select a permitted file relative to that policy's root, but cannot select the root itself.

## Policy contract

Each registered tool declares a policy equivalent to:

```ts
interface ScopedWritePolicy {
  readonly id: string;
  readonly root: string;
  readonly allowedExtensions: readonly string[];
  readonly operations: readonly ("create" | "edit")[];
  readonly maxBytes: number;
  readonly auditNamespace: string;
  readonly allowNestedDirectories: boolean;
}
```

The `root` is resolved by the extension, not supplied by the agent. For the shared default it is `<cwd>/.pi/artifacts/<namespace>/`. An extension-specific policy may explicitly use a root such as `<cwd>/.sdd/artifacts/`.

The engine rejects an empty path, absolute paths, path traversal, symlink escape, an undeclared extension, a disallowed operation, and content over `maxBytes`. Edits use exact, unique text replacement so an ambiguous replacement is rejected rather than guessed.

The first release permits only non-executable report and document formats selected by a policy, normally `.md` and `.json`. It does not grant JSON/YAML configuration writes merely because those formats are structurally similar; configuration support requires a separate intentional policy and design decision.

## Initial visible tools

| Tool                          | Default root                                    | Formats                                   | Intended users                        |
| ----------------------------- | ----------------------------------------------- | ----------------------------------------- | ------------------------------------- |
| `write_plan`, `edit_plan`     | configured plan directory                       | `.md`, `.mdx`                             | planning roles                        |
| `write_report`, `edit_report` | `<cwd>/.pi/artifacts/reports/<agent>/<run-id>/` | `.md`, `.json`                            | QA, browser, research, analysis roles |
| extension-owned adapters      | extension-declared root                         | extension-declared non-executable formats | opt-in extensions                     |

`write_plan` and `edit_plan` may retain their existing implementation initially, then migrate to the shared engine once behaviour is covered by compatibility tests. The new engine must not replace them by a weaker generic tool.

## Roles and shell boundaries

A non-implementation role receives only the dedicated scoped-write tool(s), read tools, and any explicitly justified non-mutating tools. It must not receive native `write`, native `edit`, or `safe_bash` unless the shell policy programmatically prevents all filesystem mutation.

Prompt instructions remain useful documentation but are not a safety boundary. The tool allowlist and scoped-write policy are the boundary.

For example, a QA or browser agent may write a report artefact through `write_report`; it cannot alter `src/`, tests, `package.json`, `.env`, migrations, or application configuration.

## Audit model

Every successful create, edit, or purge emits one append-only JSONL event. The common audit location is:

```text
<cwd>/.pi/artifacts/.audit/<run-id>.jsonl
```

An event has this minimum schema:

```json
{
  "version": 1,
  "timestamp": "2026-07-22T12:34:56.000Z",
  "runId": "run-123",
  "agent": "sdd-qa-tester",
  "role": "sdd-qa-tester",
  "tool": "write_report",
  "policy": "report-v1",
  "operation": "create",
  "path": ".pi/artifacts/qa/run-123/report.json",
  "bytesBefore": 0,
  "bytesAfter": 842,
  "sha256Before": null,
  "sha256After": "<sha256>"
}
```

The audit never stores report contents. Paths are project-relative. The report mutation is written atomically first, followed by the audit event. If recording the audit event fails, the tool returns an explicit partial-failure result identifying the written path and audit failure; it must never claim a fully auditable success.

Audit logs are append-only for agents. They are not a tamper-proof ledger against the local user, who retains filesystem control.

## Purge model

Purge is explicit, scoped to one validated run ID, and exposed separately from write/edit. A command or tool such as `artifacts_purge` must:

1. resolve the exact directories owned by that run under the common root and any extension roots registered for that run;
2. reject empty, globbed, absolute, or traversal-containing identifiers;
3. display the exact target paths and require confirmation when a UI is available;
4. remove only those targets;
5. append a `purge` audit event listing each removed project-relative path and its last known hash where available.

There is no implicit retention policy and no broad purge in the initial release. A global cleanup, if ever needed, is a separate explicitly designed capability.

## Error handling

| Condition                             | Required result                                   |
| ------------------------------------- | ------------------------------------------------- |
| policy/path/extension/size violation  | reject without any disk mutation                  |
| missing file for edit                 | reject with the project-relative target           |
| zero or multiple edit matches         | reject without writing                            |
| atomic report write fails             | reject; no success audit event                    |
| audit append fails after report write | explicit partial failure, including affected path |
| purge target ambiguity                | reject without deletion                           |
| user declines purge confirmation      | cancelled, no deletion                            |

## Git and visibility

The default recommendation is to ignore `.pi/artifacts/` in Git because it holds local execution evidence. An artefact intended for version control must be exported deliberately into a tracked documentation location by an authorised implementation role or a separately scoped publication tool.

## Testing strategy

- unit tests for each policy guard: traversal, absolute path, symlink escape, extension, operation, size, and nested-directory handling;
- tests for create and unique edit behaviour against disposable project fixtures;
- tests for atomic-write and audit event shape, including before/after hashes;
- failure-injection test proving that an audit append failure is surfaced as partial failure;
- purge tests covering valid run isolation, confirmation rejection, invalid identifiers, and purge audit events;
- extension integration tests proving a role with `write_report` cannot invoke native `write`/`edit` or write outside its declared root;
- compatibility tests preserving existing `write_plan` / `edit_plan` behaviour before migration.

## Rollout order

1. Build and test the shared policy, mutation, and audit engine.
2. Add `write_report` / `edit_report` for a single concrete consumer.
3. Add targeted purge for that same consumer.
4. Migrate or adapt `write_plan` / `edit_plan` only after compatibility coverage passes.
5. Add further extension-owned policies only when a real role needs them.

This order keeps the first capability small, observable, and reversible.

## Implementation status

The native `agent/extensions/pi-scoped-write` extension now owns the policy engine, atomic mutation, audit, run-root registry, `write_plan`, `edit_plan`, `write_report`, `edit_report`, and `artifacts_purge`. Its Plannotator-specific adapter is isolated from the generic engine. `pi-roles-addons` owns and imports no filesystem-mutation tool. Extension-owned roots register explicitly through the scoped-write extension, and no role allowlist was widened in this delivery.
