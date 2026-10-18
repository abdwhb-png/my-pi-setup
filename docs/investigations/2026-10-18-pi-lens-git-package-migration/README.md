# Pi Lens pinned Git package migration

Date: 2026-10-18.

Pi Lens now loads from the Pi-managed Git package `git:github.com/abdwhb-png/pi-lens@v4.4.3+fork.1`. The published tag resolves to commit `401c9791c4f61de871bf05ce0f6401a715748996`. Both the Pi extension and the VS Code MCP configuration use `~/.pi/agent/git/github.com/abdwhb-png/pi-lens`.

## Preserved behavior and packaging correction

The package preserves upstream 4.4.3 and the existing local correction that selects `~/.pi/agent/tsconfig.json` for extension files without their own TypeScript project. The development checkout remains on its existing `develop` commit. Its `master` branch was not moved. The published release tag was also imported into that checkout.

The first clean Git installation reproduced a packaging failure: Pi used the configured Socket Firewall/Bun installer with development and peer dependencies omitted, and Bun rewrote `npm run build:dist` to `bun run build:dist`. The distribution builder then rejected Bun's `npm_execpath`. The release changes only the lifecycle invocation to `npm --loglevel=notice run build:dist`, which preserves the actual npm runner, and adds a changelog fragment. No dependency version or analysis behavior was changed.

This is a build-configuration correction. Its executable before-and-after validation was the failed original installation followed by a successful clean installation through the same daily Pi CLI and installer configuration.

## Configuration changes

The former `~/engineering/shared-services/pi-lens/dist/index.js` entry was removed from `agent/settings.json`'s `extensions` array. Its replacement is a package entry with the pinned Git source and `skills: []`, preserving the prior extension-only selection. The existing tool-groups owner restored its package to the last position. The npm command remains `sfw -- bun`.

Only the `pi-lens` server entry changed in `.vscode/mcp.json`. It retains `node` and now uses `${userHome}/.pi/agent/git/github.com/abdwhb-png/pi-lens/dist/mcp/server.js` with `--cwd=${userHome}/.pi`. Other server entries and all unrelated Pi settings were compared with the pre-migration snapshots and remained semantically identical.

## Verification

| Check | Observed result |
| --- | --- |
| Existing TypeScript root regression suite | One file, five tests passed after the required in-place JavaScript build |
| Original isolated Git installation | Failed at the expected npm runner boundary |
| Corrected isolated Git installation | Passed through the daily Pi CLI with Socket Firewall and Bun |
| Installed package self-test | Twelve checks passed, including the native ast-grep binary and core grammars |
| Pi RPC registration | Nine Lens commands, all attributed to the pinned package entrypoint, with no duplicate command names |
| MCP initialization and tool inventory | Eighteen unique tools from the installed server |
| Daily resource resolution | Exactly one enabled Lens extension and zero enabled skills from this package |
| Published package installation | Passed from the actual GitHub tag; installed HEAD matches the published commit |
| Daily CLI inventory | Reports the pinned filtered package at its managed Git root |

The final protocol probe loaded the physical daily installation through a minimal isolated Pi configuration. The MCP probe used the arguments from the edited VS Code configuration after expanding `${userHome}`. No model request was sent. The installed self-test's standalone entrypoint check stops at a host-supplied import; the separate real Pi RPC probe verified actual extension registration beyond that boundary.

## Failure evidence and limits

The first focused test attempt stopped before running tests because its compiled JavaScript was stale. `npm run build` completed, then the unchanged focused suite passed. The first isolated MCP fixture also lacked Pi's host peer packages and failed to import `@earendil-works/pi-tui`; it was rerun with the already installed host packages exposed in the fixture. The final daily MCP probe used the real package ancestry.

Bun reported one blocked dependency postinstall during installation. The package's own self-test nevertheless resolved and ran the platform ast-grep binary successfully. The published installation's best-effort loader-cache warm reported that no cache entry was written; the subsequent Pi registration probe passed. These notices are retained in the installation logs.

No full Pi Lens suite, cross-platform matrix, application analysis, or VS Code UI restart was performed. Existing interactive Pi sessions and already running editor MCP processes were not terminated. Open a new Pi session or run `/reload`, and restart the Pi Lens MCP server in VS Code, to apply the new configuration to those existing clients. The previous development checkout and MCP 4.3.0 copy remain available for rollback.

## Evidence and rollback

`verification.json` records the selected commit, resolved resource counts, protocol results, original configuration hashes, and private backup location. `original-install-failure.log`, `isolated-install-success.log`, and `published-install-success.log` retain the installation outcomes. Home paths in these evidence files are normalized to `~`; `evidence-sha256.json` hashes those normalized files.

Private pre-migration snapshots are stored under `~/.pi/migration-backups/pi-lens-git-migration-20261018T103544Z/` with a private directory and file modes. To roll back, restore only the former Lens extension entry and MCP server entry from those snapshots, preserving subsequent unrelated edits. Remove the pinned package through `~/.pi/bin/pi remove 'git:github.com/abdwhb-png/pi-lens@v4.4.3+fork.1'`, then reload the affected clients. Do not overwrite the entire current settings files with an older snapshot.

For a later fork release, publish a new immutable tag, qualify its clean installation, then install that exact source through the daily Pi CLI. Reusing the existing tag would break the provenance this migration verified.
