# Extension configuration and artifacts

Owned extensions use `agent/extensions/_shared/extension-paths.ts` for storage paths. `getAgentDir()` supplies the global root, including `PI_CODING_AGENT_DIR`. Project paths use the current Pi `cwd`, with no Git-root or ancestor search.

| Area | Global | Project |
| --- | --- | --- |
| Configuration | `<agentDir>/config/<owner>.json` | `<cwd>/.pi/config/<owner>.json` |
| Generated artifacts | `<agentDir>/artifacts/` | `<cwd>/.pi/artifacts/` |
| `write_plan`, `edit_plan`, `submit_plan` | — | `<cwd>/.pi/planning/plans/` |
| `session_plan` archive | — | `<cwd>/.pi/planning/session-plans/` |

`loadExtensionConfig` owns configuration locations and the list of legacy sources. Extensions retain their normalization and merge policies. Owned project configuration requires a saved `true` decision in Pi's project trust store. Pass `ctx.isProjectTrusted()` when available as an additional veto. The loader also honors `--no-approve`/`-na` before extension contexts exist by using Pi's exported argument parser. Pi does not discover `.pi/config` as a trust resource, so automatic runtime admission, session-only trust, and `--approve` are insufficient. The existing Pi overrides extension reports ignored project configuration at session start. Use Pi's built-in `/trust` command to review the current project, save the decision, and restart Pi. Restart is also required after saving trust through the initial startup prompt, because factories such as provider and tool-group registration have already run. A startup notice reports this deferred activation. This keeps the trust boundary intact without changing pi-core. Global-only owners ignore project files. The two bash settings sections share `bash-execution.json` as `safeBash` and `bashRewrites`. The other files contain the extension's settings directly, without the former settings.json namespace.

The path resolver does not create directories or persist data. Callers retain their existing writers, locks, scoped-write policies, database connections, and authority validation. Plans and telemetry no longer accept storage-directory overrides. Configurations containing old managed paths must be migrated.

Pi core settings, credentials, model definitions, resource directories, and external package configuration retain their prescribed locations. The generated `subagents.agentOverrides` data and `piSubagentsAddons.generatedToolOverrides` ledger remain together in settings.json. Generated workflow agent definitions remain in `agents/`. No pi-core changes are required.

## Migration

Run from this repository. Supply every project cwd whose files should be migrated. The default command only reads and prints the proposed operations. It never prints configuration values.

```sh
bun agent/bin/migrate-extension-layout.ts --agent-dir ~/.pi/agent --project ~/projects/example
```

Stop all Pi processes using the selected global or project directories, then apply:

```sh
bun agent/bin/migrate-extension-layout.ts --agent-dir ~/.pi/agent --project ~/projects/example --apply --pi-stopped
```

Use repeated `--project` flags for multiple projects. The migration retains the former global plan root and the projects that overrode it in private metadata, so later migrations preserve those source choices. An absolute or home-relative global plan root has one recorded owning project. A later attempt to assign it to another project is rejected before references are rewritten. Relative global plan roots remain separate for each selected cwd. The migrator rejects conflicting destinations, symlinks, active cron locks, unfinished sandbox migrations, ambiguous configuration sources, unsupported session databases, and SQLite stores with uncheckpointed writes. Sandbox recovery markers are checked again before apply, resume, and rollback. When old settings and standalone files coexist for one owner, consolidate their intended configuration before retrying. Keep existing backups until the new layout has been verified.

Project settings cannot authorize moving custom telemetry or plan directories, even inside their own project. Inspect each configured source and pass `--artifact-source /exact/source/directory` during both preflight and apply. Repeat the flag for each custom source. Selecting a parent directory does not authorize other source roots beneath it, and symlinks remain rejected. This selection authorizes moving that directory's files, including removing the originals after verification. Use a dedicated artifact directory rather than a project, source-code, or configuration root.

Global configuration and the process environment are operator-controlled migration inputs. Their configured source paths do not require `--artifact-source`. `PI_TOOL_RESULT_ARCHIVE_DIR` and global telemetry directories must be absolute or home-relative (`~/…`): relative paths historically depended on the Pi process's working directory, which the migrator cannot infer. Preflight rejects those settings without changing files. Identify the original source and update its setting to an explicit path before retrying. The extension's fixed legacy directories also migrate without this flag. Telemetry sources must be directories; their contents move together, including Save Tokens purge markers and exports.

Each apply records private backups and a journal in `<agentDir>/artifacts/extension-layout-migrations/`. Source files are removed only after destination writes have been verified. Repeating a completed migration is a no-op. Interrupted migrations require an explicit recovery command. Apply and resume also check source inventories, including previously absent directories, and refuse newly appeared artifacts. Recovery checks that files still match the original bytes or this migration's output and refuses to overwrite subsequent edits.

```sh
bun agent/bin/migrate-extension-layout.ts --resume /path/to/journal.json --pi-stopped
bun agent/bin/migrate-extension-layout.ts --rollback /path/to/journal.json --pi-stopped
```

The migration updates session-plan and brainstorm manifests, operational plan/brainstorm entries in Pi JSONL sessions, and Think-in-Code SQLite archive references. It also updates SDD queue references already in the canonical directory when projects migrate in separate runs. Session entry identities, revisions, approval hashes, continuation preferences, and historical conversation text are preserved. SQLite transformations occur on an in-memory database during preflight.

SDD's hashed manifests remain byte-identical. `<agentDir>/artifacts/plan-path-map.json` records exact relocated Markdown paths and content digests from ordinary plans, versioned session plans, and brainstorms. SDD resolves that mapping when checking or reading an approved source. Modified content still invalidates approval. External Plannotator history and arbitrary historical prose are not rewritten.

Generated artifacts, journals, and backups are ignored by Git and excluded from test discovery. Existing private configurations remain ignored. Previously tracked curated configuration and safe examples remain tracked under `agent/config/`.

`/sandbox recover` verifies transactions in either the legacy or canonical location. Recover an interrupted legacy transaction before stopping Pi and applying the layout migration. Conflicting markers in both locations require resolving that conflict before recovery.

The portable-path maintenance command also reads canonical owned configuration and mutable SDD queue/progress/results artifacts. It leaves hashed manifests and layout migration journals untouched. Each backup run has its own directory, and its manifest records the backup location for every file, including project configuration outside the agent directory.
