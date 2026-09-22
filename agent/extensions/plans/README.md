# Plans and review

Pi owns the workflow; the standalone official `plannotator` CLI supplies the review UI. Neither a fork nor `@plannotator/pi-extension` is required. Verified CLI contract: 0.27.16 (`annotate --gate --json --require-approval`, `review --json`). Install the official CLI using its minimal installation option and keep it on PATH.

## Configuration

In global `~/.pi/agent/settings.json` or trusted project `.pi/settings.json`:

```json
{
  "plans": { "planFileDir": "pi-plans", "browserCommand": "/path/to/browser" },
  "pi-roles": { "planApprovedRole": "pi-agent" }
}
```

`browserCommand` is optional; omission preserves Plannotator's normal browser behavior. It is passed only to the child as `PLANNOTATOR_BROWSER`. Home-relative plan paths are supported. Only `planFileDir` and `browserCommand` are read from legacy `plannotator.json`; new `plans` fields take precedence per field. Other fork settings, including `autoExecute`, are ignored. Untrusted project plan configuration is ignored.

## Workflow

- `write_plan` / `edit_plan`: paths relative to `plans.planFileDir`.
- `plan_submit({ filePath })`: project-relative or absolute Markdown path within the configured directory, including symlink targets. Visible and executable only with an effective `handoffGuard: plan-submission` role. Only explicit CLI approval of an unchanged file ends planning. Pi's existing revision guard remains authoritative.
- `pi-roles` switches on a fresh turn to `planApprovedRole` (default `pi-agent`, independent of `defaultRole`). Missing/invalid roles or denied transitions leave the current role unchanged and record a terminal failure, without fallback/retry loops. Legacy approvals/processed markers remain readable.
- `/review-file <local-path>` and `/review-code`: human-only commands. Feedback is displayed and copied into an empty editor, never sent automatically and never used as plan approval. Existing drafts remain untouched. Code diff selection is handled in Plannotator's UI.

One review can be open per session. Tool cancellation or session shutdown/reload aborts it. Old results cannot be delivered into a replacement session. There is no short timer on human review. Native history, annotations and preferences remain owned by Plannotator.

Tests use temporary agent directories and CLI process fixtures. Browser qualification uses temporary Plannotator data, not personal history. Do not reinstall the official Pi extension alongside this adapter: both register `plan_submit`.
