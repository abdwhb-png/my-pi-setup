# A2 publication and daily activation

## Result

The corrected fork is published as `v0.77.0+fork.3` at `87d59f123b97cec24b9938eb53036f6d05b32e8a` and installed through the daily Pi CLI. The matching harness implementation includes the alias correction at `c7c15ce`. Both repositories retain the `feat/global-tool-providers` publication branch. Their primary local checkouts were advanced by fast-forward without incorporating the separate upstream-upgrade candidates.

The fresh daily-configuration smoke test passed foreground and asynchronous delegation. Both children executed `module_report` and `write_report` successfully, produced their scoped reports, and reached completed status. Four parent Lens calls also passed. The probe took 64.696 seconds and the CLI exited successfully. Artifact verification passed all 12 tests with no failures.

## Installed provenance

| Surface | Verified value |
| --- | --- |
| Configured source | `git:github.com/abdwhb-png/pi-subagents@v0.77.0+fork.3` |
| Resolved package root | `~/.pi/agent/git/github.com/abdwhb-png/pi-subagents` |
| Installed manifest | `pi-subagents`, version `0.77.0+fork.3` |
| Installed commit | `87d59f123b97cec24b9938eb53036f6d05b32e8a` |
| Runtime | Promoted Pi `1.1.0`, unchanged |
| Package dependency command | Existing `npmCommand: ["sfw", "--", "bun"]` |

GitHub tag and manifest metadata were verified before installation. The command was `~/.pi/bin/pi install 'git:github.com/abdwhb-png/pi-subagents@v0.77.0+fork.3'`. Pi replaced the existing source pin instead of adding a duplicate. Its persistent Git installation path does not include the ref, so the version is pinned in the configured source rather than the directory name. No package-manager or Pi-core patch was introduced for a versioned path.

The release changes only root version metadata, not the dependency graph. The npm version command strips build metadata, so the three root version fields were set explicitly and checked against the previous manifest and lockfile. Pi's Git update performs a hard reset and cleans untracked files. The installed clone was backed up before the command, and its pre-existing untracked `bun.lock` was restored byte-for-byte afterwards. Package dependencies were installed by Pi through the configured Socket Firewall command.

## F3: Alias placeholders in the daily registry

The first daily-configuration smoke test exposed an additional addon defect: `tool-groups` registers placeholders such as `@inspect` and `@lens`, and `pi.getAllTools()` includes them. The provider collector forwarded those names as `whenTools`, which correctly rejected non-concrete names and blocked delegation before child launch. The earlier isolated live fixture did not load these placeholders.

The addon now excludes aliases using the existing shared `fromToolGroupAlias` function before provider discovery. The fork and its validation rules are unchanged. A unit regression covers a mixed provider and an alias-only provider. The real Pi resource-loader composition test now loads the public `tool-groups` entrypoint, confirms the alias is registered, and verifies successful preflight, child tool execution, denied tools, reload, and disposal. Both regressions failed before the production fix and passed afterwards.

The focused harness run passed 25 tests. Lint on the three changed files reported zero diagnostics before and after the correction. The mandatory ownership check passed with existing unrelated warnings. The production file was formatted and the diff passed whitespace validation. A local corrective review checked that only alias placeholders are excluded, concrete providers retain their existing validation, and no per-agent configuration or duplicate alias rule was introduced. This was not an independent delegated review.

The first smoke fixture also used a constant-only module, which yielded no Lens outline symbols and `available: false`. The successful repeat reused the earlier function-bearing proof fixture and passed all four parent Lens calls. This was a fixture correction, not a Lens or sandbox production change. The failed attempt remains in the evidence.

## Evidence and limits

Private evidence is retained under `/tmp/pi-o3-activation-214841g7/`: installation output and provenance, the first failed smoke, alias RED/GREEN logs, lint comparison, ownership scan, the successful `smoke-corrected/` transcripts and reports, and `summary.json`. The successful preflight selected three global providers and no configured extension list. It resolved group aliases into concrete tool names. Runtime resolution was checked inside the fresh Pi session against the installed Git clone.

The daily settings changed only the package source pin. Settings, tool groups, the preserved installed lockfile, and the proof source remained byte-identical throughout the successful smoke. Existing sessions were not stopped or restarted. The unrelated `docs/investigations/2026-10-13-live-delegation-e2e/` files were preserved and excluded from commits. Personal settings are ignored by Git, so the committed record contains the installation source rather than personal configuration.

This activation smoke did not rerun resume, workflows, nested fan-out, or an actual remote connection. Earlier qualification and the [A1 corrective review](review-corrections.md) cover their stated scopes. Full repository suites were not rerun, and the previously documented full-suite failures and timing sensitivity remain qualification limits. No Pi-core update, runtime promotion, or upstream merge was performed.
