# pi-subagents companion addons

This Pi package augments upstream `pi-subagents`; it does not replace discovery, child execution, MCP handling, recovery, or notifications. It generates ordinary tool overrides and provides request-local fallback advice. Only the parent can choose to retry. Overview and wait guard remain independently disabled.

Daily Pi uses official `pi-subagents@0.73.1` with `pi-mcp-adapter@3.0.0`, installed and verified after operator approval on 2026-09-28. Package imports resolve through `~/.pi/agent/npm/node_modules/`, independently of the contribution repository and its worktrees. See [ADR-028](../../../docs/adr/ADR-028-generated-subagent-tool-overrides.md).

## Generated tool overrides

Keep `tools: '@inspect, @lens'` in agent Markdown. At parent session startup and `/reload`, the addon expands groups through the shared tool-groups resolver and writes concrete `subagents.agentOverrides.<name>.tools` values. It does not rewrite Markdown or use the unpublished `pi-subagents/tool-selection` hook.

Configure the existing `config.json`:

```json
{
    "toolGroupOverrides": {
        "enabled": true,
        "userAgentDirs": ["agents", "~/.agents"],
        "projectAgentDirs": [".pi/agents", ".agents"],
        "agentTools": {
            "worker": ["@inspect", "@implement", "contact_supervisor"],
            "scout": [
                "@inspect",
                "@lens",
                "write_report",
                "contact_supervisor"
            ],
            "brainstorm-scout": [
                "@inspect",
                "@lens",
                "write_report",
                "contact_supervisor"
            ],
            "delegate": [
                "@inspect",
                "@lens-write",
                "@implement",
                "contact_supervisor"
            ]
        }
    }
}
```

These four mappings preserve existing explicit permissions; `agentTools` takes precedence over an agent's frontmatter. Do not substitute `@report-write` for `write_report`: it also grants `edit_report`.

### Sources and precedence

User directories are relative to Pi's agent directory unless absolute or home-relative. Project directories must stay relative to the session root. Only directly contained Markdown is scanned; `.chain.md` is excluded. Additional package directories must be declared explicitly. Missing optional directories are allowed; malformed sources, unreadable files, escaping symlinks, and ambiguous identities fail closed.

Global settings depend only on global sources/groups. A trusted project receives its own snapshot in `.pi/settings.json`, using project declarations over global declarations and the existing shared group-config precedence. Settings-based group definitions still take precedence over the legacy group files. An untrusted project contributes no declarations or groups and receives no writes. Open Pi at the supported project root; the addon does not initialize unrelated roots or follow an ancestor's configuration silently.

Nested groups, exact extension-tool names, and literal MCP selectors are supported. Wildcards, provider-dependent `tools`, non-native runners, `agentScanDirs`, `agentExcludeDirs`, non-`nearest` project-root resolution, and `PI_SUBAGENT_EXTRA_AGENT_DIRS` are rejected rather than partially emulated. Exact child-only tool names are not filtered through the parent's registry. Upstream still owns availability checks, `excludeTools`, capability ceilings, and MCP authorization.

Brainstorm and SDD publish their existing definitions on the session event bus before startup. This allows compilation before their Markdown becomes visible. Their acquisition/release lifecycle is unchanged; the addon does not activate workflow agents.

### Ownership and failure handling

The addon owns only generated `tools` fields and `piSubagentsAddons.generatedToolOverrides` metadata. Models, thinking, budgets, manual overrides, unknown fields, and fallback configuration remain untouched. A removed source removes only an unchanged owned output after a complete successful scan.

Existing unowned `tools` values require explicit, exact-value adoption, even when equal to the proposed output. Initial migration uses `syncGeneratedToolSettings` with reviewed `adopt.global` / `adopt.project` maps; ordinary startup never adopts them. A manual edit to owned output blocks synchronization instead of being overwritten. Change the declaration or resolve the ownership conflict explicitly, then reload.

Writes use Pi-compatible `proper-lockfile` locks, fresh reads, adjacent temporary files, and atomic rename per file. Global/project changes are prepared before publication, but are **not a multi-file transaction**. Partial publication is reported and keeps launches blocked; retry is idempotent. A noncooperative writer still leaves a residual race between the final comparison and rename.

Register the addon explicitly in global `extensions` before upstream package startup. The real loader deduplicates its auto-discovered entrypoint. A public `allowedAgents: []` ceiling is installed before synchronization and removed only after success. Configuration or write failures retain that ceiling and display a repair/reload diagnostic; a thrown lifecycle exception alone would not enforce refusal. `PI_SUBAGENT_CHILD=1` skips synchronization. Do not explicitly load this addon inside a foreground child.

### Snapshot and recovery limits

There is no watcher or per-delegation compilation. Reload after changing groups or agent files, and open/reload each relevant project root. Other sessions are not synchronized instantly. Already launched children keep their stored contract; changing a group does not retrofit permissions on public resume.

MCP child execution uses upstream's async path. Parent Pi and this addon run under Bun; the official npm async runner uses Node. Qualification checks the actual executable and package roots, not an assumed runtime inherited from the parent.

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

Malformed addon configuration produces a visible startup diagnostic and retains the launch-denial ceiling. Agent names cannot be checked against a static roster: Pi also registers built-in and runtime agents. A misspelled but well-formed name produces no advice; confirm names with `subagent` action `list`. Fallback lists from `agent/settings.json` and `agent/agents/{pi-expert,factual-researcher,videographer}.md` now live here because upstream agent parsing rejects `fallbackModels` there. The customized fork's automatic fallback is absent. Keep this configuration when switching from the local PR branch to its published release; never enable both fallback mechanisms. Migrating model strings does not prove their availability.

## Install and recovery

Recheck the live official registry, coordinate active sessions, and back up settings, managed-package state, and links before daily cutover. Use only the daily Pi CLI with Socket Firewall, disabled lifecycle scripts, and the approved release-age policy. Install the exact qualified packages and remove only the inventoried old source through `pi remove`; do not start normal sessions while two subagents sources coexist. Never install directly into Pi's managed `agent/npm` tree or edit its manifest.

Adapter 3.0.0 and subagents 0.73.1 use `mcp-adapter.json`; the previous adapter uses `mcp.json`. Migrate the global and project files byte-for-byte under separate operator approval, preserving authentication without printing it and avoiding duplicate active sources. Adapter 3.1.0 was rejected for this pairing: its stdio metadata hash includes defaults that subagents 0.73.1 omits. HTTP success alone does not qualify stdio. Version 3.0.0 lacks 3.1.0's malformed-config overwrite protection, BOM handling, pending-approval/reload fix, shared worktree approvals, stdio identity changes, and Jev lexical fallback restriction to `allowedServers`.

After cutover, run from `~/.pi/agent`:

```sh
PI_SUBAGENTS_OFFICIAL_SMOKE=1 bun test --isolate extensions/pi-subagents-addons/official-package.smoke.test.ts
bun run check:pi-runtime
```

The smoke reads installed settings without modifying them, verifies the single pinned source and npm root, then reuses the public CLI lifecycle test with temporary HOME/agentDir. `PI_TEST_INSTALLED_AGENT_DIR` selects the isolated installation during qualification only; leave it unset when verifying daily cutover. `PI_TEST_CLI` can name the real host launcher when the shell has a private HOME.

Do not move contribution checkouts until no daily runtime or active session depends on them. Offline deterministic qualification does not prove real OAuth or every daily server.

For rollback, first coordinate sessions. Disabling `toolGroupOverrides.enabled` only stops regeneration: persisted overrides remain. Remove only still-matching owned fields through the persistence module with a reviewed empty compilation; restore the four preexisting selections only from a verified backup, preserving later edits. Ownership conflicts require an explicit decision. Restore the matching previous addon and package source through Pi CLI, plus only the MCP filename/config changes made by this migration. Never replace a whole settings file with a stale backup. Keep fallback advice; restoring the older customized automatic-fallback fork is not part of this rollback.

Backups are retained under `~/projects/pi-integrations/.backups/pi-subagents/`. No backup deletion is part of cutover or recovery.
