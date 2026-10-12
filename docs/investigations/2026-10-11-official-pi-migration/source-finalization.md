# Pi 1.1.0 source finalization

The qualified migration sources are committed. Subagents, Todo, and Browser are also published to their fork repositories for the original Git installation mode. The primary core checkout at `~/engineering/pi-core` now uses `pi-core-v1.1.0`. The package repositories retain their existing primary branches and receive the qualified commits by fast-forward. The harness migration is recorded on `develop` in the commit containing this document.

| Repository | Source commit | Primary branch |
| --- | --- | --- |
| pi-core | `26eb6a028cf93787d2f00e8181c6c2f06fb0bbc6` | `pi-core-v1.1.0` |
| pi-subagents | `7fcc8a42c93ededa7e299a9a6100122d84a51f7b` | `a1-a2-delegation` |
| pi-agent-browser-native | `21a9092c7410ffe27ad1d1d09090f09859ebbc99` | `main` |
| rpiv-todo | `638be62754b65990bff6daf0c20419b22e4c747e` | `main` |
| pi-lens | `bbb0ce798ed58b84068154f4d627a36a20265fe6` | `develop` |
| pi-test-harness | `b987af1002fad59b1ef5d925082f12a716b01bab` | `main` |
| pi-session-recall | `ab9664e62638ca81a19845279553de7e2b9d98ee` | `perf/persistent-session-views` |

The core commit includes the official `v1.1.0` commit `abe508e1b89912adde45528136c3221eb69acdd7` as a merge parent. The subagents, browser, and Lens commits preserve their recorded upstream revisions in their history. Browser's migration commit `e74cf9c2059e91c06539863d7ed4a5131d6fc606` has upstream merge parent `e7b3b57a387e37722e0ce2401eb91935d0bea3c1`, the 0.9.4 release merge, which also contains the earlier recorded revision `0058c8e0e6dda568c5313be603841c440fc19d85`. Footer needed no source modification.

## Verification and preservation

Before committing, all eight candidate patches matched the SHA-256 values in the promotion review. Every additional source file matched its archived copy. All 73 harness code, test, dependency, and configuration files selected for the commit matched the qualified candidate. Commit trees were checked against their staged trees, and primary checkout trees were checked against the resulting commits.

The core `npm run check` passed again, including formatting, dependency and import checks, install-lock verification, TypeScript, and browser smoke. The focused public MCP export test passed. Lens's existing pre-commit hook passed lockfile, changelog, TypeScript, strict lint, and formatting checks. No hook was bypassed. Whitespace diagnostics inherited from upstream Lens documentation and recorded diff/log fixtures were retained. The fork delta against the upstream merge parent passed `git diff --check`.

The earlier qualification and five live daily E2E scenarios remain the behavioral evidence for the unchanged source snapshots: real file reading, native session resume, a native DeepWiki call through codemode, an asynchronous GLM child run, and the document TUI with a real browser. The previously reported global-suite limitations and remaining private/project MCP failures remain applicable. The initial source finalization did not rerun full suites. The subsequent Git installation validation is recorded below.

The existing formatting edit in the primary test-harness checkout was byte-identical to the qualified commit. Staging that exact post-image allowed the fast-forward without replacing its content. Unrelated untracked harness files and investigation artifacts remain in place. Temporary candidate worktrees are retained. Git finalization did not copy their installed dependencies or generated artifacts. The subsequent package-source transition restored the primary repositories from their qualified lockfiles and rebuilt Browser, Lens, and Session Recall through their existing build scripts.

## Daily runtime and future work

The daily release remains `1.1.0-00c5e7e300ba-dirty-79f8bc0b6a58`. Its `dirty` label and original build source reference describe the immutable artifact built before these commits. The release does not depend on the continued presence of that temporary source checkout. `pi-fork verify` passes after source integration.

The daily package configuration preserves the original distribution modes. Subagents uses `git:github.com/abdwhb-png/pi-subagents@v0.77.0-a1a2.1`, Todo uses `git:github.com/abdwhb-png/rpiv-todo`, and Browser uses `git:github.com/abdwhb-png/pi-agent-browser-native`. Pi manages their clones under `~/.pi/agent/git/github.com/abdwhb-png/`. Footer and Session Recall retain local references under `~/engineering/pi-integrations/`, and Lens loads `~/engineering/shared-services/pi-lens/dist/index.js`. The npm package pins and package order are unchanged. The former `~/.pi/runtime/package-sets/pi-1.1.0-20261011/` copies remain only as rollback artifacts. The user authorized the three Git publications on 2026-10-12. No additional core promotion was performed.

The remaining local references load their source checkouts. Git packages load Pi-managed clones and are updated through the Pi CLI. Preserve each package's configured distribution mode during future updates unless the user requests a change. The core remains independently promoted and immutable. Ten migration, A1/A2, and active Footer branches were renamed without changing their commits. Use branch names without the `codex/` prefix. Historical branches unrelated to this migration were left in place.

The previous source heads are preserved by `backup/pi-1.1-source-finalization-20261011` in each repository. These source references do not replace the separate runtime migration rollback procedure. The source audit, commit and integration records, and final runtime check are stored privately under `~/.pi/runtime/migrations/2026-10-11-pi-1.1.0/source-finalization/`. The live E2E report remains under that migration's `evidence/live-e2e-20261011/REPORT.md`.

## Intermediate local-source validation (2026-10-11)

Before switching the active paths, the promoted SDK loaded all 51 extensions from the proposed configuration with no load errors. The active configuration then passed the same check with no remaining package-set resource paths. All five managed package links resolve to their canonical repositories. Only `packages` and `extensions` changed in the personal settings.

Dependencies were restored through Socket Firewall from the qualified npm lockfiles and Session Recall Bun lockfile, after checking 77 exact direct dependency versions against the official registry. The existing Browser, Lens, and Session Recall build commands passed without tracked source changes. Real Chromium open, codemode text extraction, and close passed through the promoted SDK. Real TypeScript LSP hover and document-symbol calls passed. The 13 focused Footer configuration and rendering tests passed against its concurrent working-tree edits, which were preserved.

Three fresh daily CLI scenarios passed: file reading with a random marker, asynchronous subagent execution with `bg_wait` and an exact child result, and the fullscreen document TUI with a real browser and exact page marker. All exited successfully. The fixture mission and index were archived and removed from daily storage, and the temporary trust entry was removed. `pi-fork verify` passed. The existing resource-loader listener warning remains visible and was already present before this transition. No full suite or additional private/project MCP validation was run for this configuration-only transition.

Detailed logs, the source map, before/after settings, branch records, and live evidence are private under `~/.pi/runtime/migrations/2026-10-11-pi-1.1.0/source-finalization/canonical-packages/`.

## Restored Git installations (2026-10-12)

The published and installed Subagents tag resolves to `7fcc8a42c93ededa7e299a9a6100122d84a51f7b`; Todo main resolves to `638be62754b65990bff6daf0c20419b22e4c747e`; Browser main resolves to `21a9092c7410ffe27ad1d1d09090f09859ebbc99`. Every managed clone HEAD and package-resolution link was checked. Installation and removal of the interim local references used the daily Pi CLI with its configured Socket Firewall and Bun command. Only the `packages` setting changed during this restoration.

A fresh Browser Git install exposed a preparation defect: resolving TypeScript from an ancestor directory incorrectly skipped development dependency installation, although the build invokes the compiler inside the checkout. Commit `21a9092` adds that executable check, preserves Android's native compiler path, adds a regression test, and documents the behavior. Two pre-existing test formatting issues were also corrected mechanically. The regression failed before the fix; all seven preparation tests passed afterward. A clean installation fixture with ancestor dependencies and the real checkout-only browser TUI smoke also passed.

Browser build, scope/policy validation, lint, formatting, and TypeScript passed. The full `npm run quality` gate remains failing: multiple browser fixture tests failed, and a representative missing-session-name failure was reproduced on the unmodified `e74cf9c` baseline. The broad test run was stopped after confirming that baseline failure. The later generated-document checks were not reached. This restoration does not claim full-suite success or address those separate failures.

The promoted SDK loaded all 51 extensions with no errors after Git restoration. Todo create/update/list passed through the actual tool boundary. Fresh daily CLI scenarios passed for asynchronous delegation with the exact child result and the fullscreen document TUI with real Chromium and codemode page extraction. Both sessions exited successfully. The live traces were archived before removing the completed fixture mission and temporary trust entries. The temporary Browser install fixture and fix worktree were removed. A final `pi-fork verify` passed, and the daily core release is unchanged.

Detailed publication records, installation logs, clone identities, the regression evidence, and fresh runtime checks are private under `~/.pi/runtime/migrations/2026-10-11-pi-1.1.0/source-finalization/git-installation/`.
