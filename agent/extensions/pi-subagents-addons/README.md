# pi-subagents companion addons

This Pi package supplies runtime tool-group resolution and request-local fallback advice to the `pi-subagents` fork. Native discovery, child execution, MCP handling, recovery and notifications retain their existing owners. Only the parent can choose to retry. Overview and wait guard remain independently disabled.

Daily Pi loads the qualified Git fork from the managed clone recorded in the installation section. Package imports resolve to that clone independently of the contribution repository and its worktrees. See [ADR-029](../../../docs/adr/ADR-029-runtime-subagent-tool-selection.md).

## Runtime tool selections

The fork resolves `@group` aliases after native agent discovery and settings precedence. Configure the global provider in `~/.pi/agent/settings.json`:

```json
{
  "subagents": {
    "toolSelectionResolver": "~/.pi/agent/extensions/pi-subagents-addons/tool-selection.ts",
    "agentOverrides": {
      "worker": { "tools": ["@inspect", "@implement", "contact_supervisor"] }
    }
  }
}
```

The provider is also exported as `pi-subagents-addons/tool-selection`. It imports the shared tool-group configuration and resolver. It reads global `config/tool-groups.json` and saved-trusted project `.pi/config/tool-groups.json` once per discovery batch. User scope excludes the project overlay. Session-only approval never authorizes extension configuration, and `--no-approve` remains a veto.

Native discovery owns builtin, user, project, package and active workflow agents, scan directories, identity and overrides. The addon does not scan agent declarations or write settings on startup, reload or delegation. The four former explicit mappings are manual alias overrides with native settings priority. Models, thinking, budgets and fallback advice keep their original owners.

New delegations see group edits immediately. Already running children and native resumes keep their stored concrete tools and MCP selection. Runtime-registered agents keep their existing concrete tool lists. Nested groups, exact tool names and literal `mcp:` selectors are supported. Wildcards and unresolved or cyclic aliases return explicit agent diagnostics and prevent a fresh launch. A missing or invalid provider omits affected executable agents but leaves raw declarations and persisted-run recovery available.

The overview obtains effective selections through `_shared/subagents` and the configured package's public `./agents` reader. It does not expand aliases or replace resolved tools with raw overrides.

## One-shot migration and rollback

`agent/tooling/subagents/tool-selection-migration.ts` exports `migrateToolSelection` and `rollbackToolSelection`. Preview explicit settings targets first. Applying requires a private journal path. The tool checks existing generated fingerprints under Pi-compatible locks, removes only unchanged owned tool fields and metadata, and installs reviewed manual alias mappings. Unknown fields and model settings survive. Unowned conflicting tools and edited owned fields stop all preparation before publication.

Publication is atomic per file, not a multi-file transaction. The private journal is saved before publication and supports partial failure recovery. Rollback restores only journaled fields whose postimages still match. Later unrelated model edits survive, while edits to migrated fields stop rollback. Keep journals and backups private because settings may contain credentials. There is no startup migration or settings writer.

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

The addon observes foreground `subagent` results and upstream `subagent:async-complete` events. Official completed results redact assistant messages. To distinguish a provider request failure from a task or tool failure, it reads only the child's exact parent-session-derived `run-<index>/session.jsonl` (at most 1 MiB, no symlink or path escape). It requires a recorded assistant `stopReason: "error"` and `errorMessage`, failed completion metadata, and no prior assistant content or tool activity. It does not use free-text `result.error` to classify failure. If the session is unavailable, moved by `sessionDir`, too large, malformed, already did useful work, or an async workflow projection lacks the child identity/path, **no advice appears**. External CLI/job runners, timeouts, stops, interrupts, context overflow, and budget failures also produce none.

Advice appears once in the parent's **outgoing provider request** through `_shared/provider-system-prompt.ts`. It does not add a Pi session message, change the model, retry work, patch a tool result, or emit another completion notification. It names the run and child and lists remaining candidates in configured order. Parent should inspect run/status before any explicit relaunch; suggestions do not guarantee parent follows that order. Provider-side request logs may still retain the request. An async completion delivered after its notification turn's provider request might not appear that turn; session reload loses pending advice rather than replaying stale state.

Malformed addon configuration produces a visible startup diagnostic. Tool-selection failures are reported by native agent discovery. Agent names cannot be checked against a static roster: Pi also registers built-in and runtime agents. A misspelled but well-formed name produces no advice; confirm names with `subagent` action `list`. Fallback lists from `agent/settings.json` and `agent/agents/{pi-expert,factual-researcher,videographer}.md` now live here because upstream agent parsing rejects `fallbackModels` there. The customized fork's automatic fallback is absent. Keep this configuration when switching from the local PR branch to its published release; never enable both fallback mechanisms. Migrating model strings does not prove their availability.

## Installation

Install the qualified Git release with the daily Pi CLI. A new ref for the same repository replaces the old declaration. Do not subsequently remove the old source, since both refs share the managed clone. Verify the installed clone SHA, full package version, public exports and bare-import link. Existing Pi parent sessions must reload or restart after cutover. This change does not promote Pi core or alter MCP configuration.

The pinned source is `git:github.com/abdwhb-png/pi-subagents@v0.77.0+fork.2`. Its managed directory remains `~/.pi/agent/git/github.com/abdwhb-png/pi-subagents`; the version is recorded in the source ref and manifest. Historical tags remain valid rollback targets.
