# pi-scoped-write

`pi-scoped-write` is a native Pi extension that provides narrow, auditable filesystem mutation capabilities for roles that must produce artefacts without receiving general implementation authority.

It owns `write_plan`, `edit_plan`, `write_report`, `edit_report`, and `artifacts_purge`. The Plannotator-specific adapter is isolated in `plan-tools.ts`; `pi-roles-addons` owns no filesystem-mutation tool.

Report attribution prefers the active public `pi-roles` role. In a `pi-subagents` child without an active role, it falls back to the declared `PI_SUBAGENT_CHILD_AGENT`; otherwise it uses the documented neutral identity.

Policies define a root, allowed extensions, permitted operations, size limits, and directory behaviour. The extension validates paths, prevents traversal and symlink escapes, writes atomically, and records JSONL audit events under `<cwd>/.pi/artifacts/.audit/`.

The initial adapters expose Markdown/JSON reports and migrate plan writes. General source, configuration, scripts, and test-file writes are deliberately out of scope.

Artefact roots can be registered explicitly for run-scoped purge. Purge refuses unsafe run IDs and must be confirmed by its Pi adapter.
