# Plan workflow and review

Pi owns the workflow; the standalone official `plannotator` CLI supplies the review UI. Neither a fork nor `@plannotator/pi-extension` is required. Verified CLI contract: 0.27.16 (`annotate --gate --json --require-approval`, `review --json`). Install the official CLI using its minimal installation option and keep it on PATH.

## Configuration

In global `~/.pi/agent/config/plans.json` or trusted project `.pi/config/plans.json`:

```json
{ "browserCommand": "/path/to/browser", "autoExecute": true }
```

Set `planApprovedRole` in `config/pi-roles.json`. `browserCommand` is optional and is passed only to the child as `PLANNOTATOR_BROWSER`. Trusted project configuration overrides global configuration per field. Untrusted project configuration is ignored. The managed plan directory is `<cwd>/.pi/planning/plans/`; `session_plan` versions use `<cwd>/.pi/planning/session-plans/`. The old `plans.planFileDir` setting must be migrated with the [extension storage migrator](../../../docs/extension-storage.md).

`autoExecute` is a boolean and defaults to `true`. Its effective value is saved with each approval. With `false`, approval ends the current planning run and leaves a role-switch request pending. The next user message applies `planApprovedRole` before the agent responds; no automatic continuation is sent, including after reload/resume. Older approval records without this field retain automatic continuation.

## Workflow

- `write_plan` / `edit_plan`: paths relative to `.pi/planning/plans/`.
- `submit_plan({ filePath })`: project-relative, home-relative or absolute Markdown path within the managed directory, including symlink targets. Visible and executable only with an effective `handoffGuard: plan-submission` role. Explicit CLI approval of an unchanged revision ends the planning run. An existing untracked file becomes a tracked revision when submitted. The extension owns the revision and transition guard through pi-roles' shared transition-policy interface.
- `pi-roles` switches on a fresh turn to `planApprovedRole` (default `pi-agent`, independent of `defaultRole`). Missing/invalid roles or denied transitions leave the current role unchanged and record a terminal failure, without fallback/retry loops. Legacy approvals/processed markers remain readable.
- `/review-file <local-path>` and `/review-code`: human-only commands. Feedback is displayed and copied into an empty editor, never sent automatically and never used as plan approval. Existing drafts remain untouched. Code diff selection is handled in Plannotator's UI.
- `/abandon-plan [plan-path]`: autocomplete lists pending revisions tracked in this session. Omit the path to target the active submission; otherwise supply a project-relative, home-relative or absolute path. After confirmation, cancel only that submission's review process, return a normal abandoned tool result, and tell the agent to pause without resubmitting or implementing. During an active run, the notice is queued as a follow-up before cancellation; while idle, it is saved in the agent's context without starting another turn. The file and current role remain. Once every tracked revision is approved or abandoned, a manual role switch is allowed. Editing or explicitly resubmitting an abandoned plan creates a new revision that requires review. Confirmation is revalidated before any change; approved and already abandoned revisions cannot be abandoned again.

One review can be open per session. Tool cancellation or session shutdown/reload aborts it. Old results cannot be delivered into a replacement session. There is no short timer on human review. Native history, annotations and preferences remain owned by Plannotator.

Tests use temporary agent directories and CLI process fixtures. Browser qualification uses temporary Plannotator data, not personal history. Use the standalone CLI with this adapter; `plan-workflow` owns Pi tool registration and approval handoff.
