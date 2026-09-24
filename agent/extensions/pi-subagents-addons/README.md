# pi-subagents companion addons

This Pi package augments upstream `pi-subagents`; it does not replace child execution. Daily Pi currently loads the compiled, upstream-only [PR #2471](https://github.com/nicobailon/pi-subagents/pull/2471) branch from `~/projects/pi-integrations/pi-subagents-upstream-peer-fix/dist-pkg`, pending merge and publication. The old customized fork is not loaded. Fallback advice is enabled in `config.json`; the upstream package owns child launches, results, and native notifications. Only the parent can choose to retry. Overview and wait guard remain independently disabled.

## Fallback advice

`fallbackAdvice.fallbackModels` maps agent names to ordered **suggestions**, not automatic fallback selection. Keep primary models in Pi's agent declarations and `agent/settings.json`. Example:

```json
{
    "fallbackAdvice": {
        "enabled": true,
        "fallbackModels": {
            "worker": ["provider/second", "provider/third"]
        }
    }
}
```

With the local PR build (and later its published release), the addon observes foreground `subagent` results and upstream `subagent:async-complete` events. Official completed results redact assistant messages. To distinguish a provider request failure from a task or tool failure, it reads only the child's exact parent-session-derived `run-<index>/session.jsonl` (at most 1 MiB, no symlink or path escape). It requires a recorded assistant `stopReason: "error"` and `errorMessage`, failed completion metadata, and no prior assistant content or tool activity. It does not use free-text `result.error` to classify failure. If the session is unavailable, moved by `sessionDir`, too large, malformed, already did useful work, or an async workflow projection lacks the child identity/path, **no advice appears**. External CLI/job runners, timeouts, stops, interrupts, context overflow, and budget failures also produce none.

Advice appears once in the parent's **outgoing provider request** through `_shared/provider-system-prompt.ts`. It does not add a Pi session message, change the model, retry work, patch a tool result, or emit another completion notification. It names the run and child and lists remaining candidates in configured order. Parent should inspect run/status before any explicit relaunch; suggestions do not guarantee parent follows that order. Provider-side request logs may still retain the request. An async completion delivered after its notification turn's provider request might not appear that turn; session reload loses pending advice rather than replaying stale state.

An enabled malformed config fails extension loading visibly. Agent names cannot be checked against a static roster: Pi also registers built-in and runtime agents. A misspelled but well-formed name produces no advice; confirm names with `subagent` action `list`. Fallback lists from `agent/settings.json` and `agent/agents/{pi-expert,factual-researcher,videographer}.md` now live here because upstream agent parsing rejects `fallbackModels` there. The customized fork's automatic fallback is absent. Keep this configuration when switching from the local PR branch to its published release; never enable both fallback mechanisms. Migrating model strings does not prove their availability.

## Install and recovery

Daily Pi resolves `agent/node_modules/pi-subagents` to `~/projects/pi-integrations/pi-subagents-upstream-peer-fix/dist-pkg`. `pi list` must show only that source for `pi-subagents`. After PR #2471 merges, check the **live official registry and release** for the first version containing the fix, then use the daily Pi CLI: `pi install npm:pi-subagents@<verified-version>` and `pi remove <local-PR-source-from-pi-list>`. Keep existing advice config and verify the new package root and tool activation. Never run Bun/npm against Pi's managed `agent/npm` tree or edit its manifest.

For recovery to the old fork, disable fallback advice, install that fork and remove the PR branch or published source through Pi CLI, then restore only saved fallback fields from the private migration backup while preserving newer settings and Pi-managed package sources. Backup remains under `agent/cache/migration-backups/` pending user-controlled cleanup. If a stale symlink blocks finalization, report it; do not change sandbox implementation.
