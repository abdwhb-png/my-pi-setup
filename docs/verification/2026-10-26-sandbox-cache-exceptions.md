# Scoped sandbox cache writes

The correction is implemented, published and active globally. The managed runtime is `native-40305494210-1`, qualified by [native Linux CI run 40305494210](https://github.com/abdwhb-png/my-pi-setup/actions/runs/40305494210) at Pi commit `7a7fbe41b2ca5159fdb99992f1ade9aace56f265`. The promoted engine is the exact downloaded CI artifact, built from Zerobox commit `a894c62407854f0e17d35a8250696f100b8f3ad2`, including the previously deployed Docker trust correction recorded in `3071114`.

## Permission and diagnostic behavior

`filesystem.denyWriteExceptions` binds literal paths to one existing denial glob. The global authority now exempts `node_modules/.vite-temp`, `node_modules/.vite`, `node_modules/.cache`, `node_modules/.vue-global-types` and `node_modules/.tmp` from `node_modules/*`. Their uses were verified in project configurations and installed Vite/Vitest, Nuxt, Jiti, Laravel Vite and Vue tooling. Exceptions still require ordinary write authority; other denial rules and read restrictions remain effective. Basename denial globs such as `*.key` retain their documented recursive scope.

Projects and sessions inherit the selection and may narrow it or disable it with `filesystem.denyWriteExceptions: []`. Selection precedes validation of redirected paths, so a project can disable inherited exceptions even when it shares its dependencies through a symlink. Active redirected exceptions remain rejected. Existing worktree configurations and shared dependencies were not modified. Dependency package directories, `.pnpm` and `.bin` are not exempted.

Admission schema 3 carries the exact exception pairs. Pi verifies the receipt before dispatch and rejects missing or widened exceptions. Configurations without exceptions retain the existing schema routes. Native write refusals come from filesystem enforcement through bounded terminal status metadata. Pi neither infers a confirmed denial from stderr nor duplicates the native glob matcher. Failed shell context records the observed mode; `bash` and `safe_bash` follow the same selected mode. Removing an exception revokes affected running commands. Shell routing now awaits cancellation cleanup and final provenance before returning.

## Validation

- Native CI: 1,235 passing Pi regression tests across 133 files, with 79 explicit opt-in skips and no failures. All 26 candidate contract files, five pinned-builder tests and the fresh installed-runtime Pi contract passed.
- Zerobox package suite on WSL2: 439 tests passed; three Docker SDK scenarios and one explicit benchmark remained ignored. An earlier concurrent glob run encountered a Bubblewrap mount setup failure before one target started; its log was retained, and sequential checks passed.
- The original Workbench command passed both test files and all 35 tests inside the downloaded native runtime with the normal Vitest configuration loader. Duration: 216.13 seconds. The earlier WSL-built candidate also passed all 35 tests in 181.05 seconds.
- After daily promotion, a fresh local Pi contract passed real `bash` and `safe_bash`, private temporary storage, environment/read-scope protection and admission identity: 14 assertions. The normal Workbench configuration loader resolves all five global cache exceptions in sandbox mode.
- Extension ownership checks passed. Full typecheck still reports four diagnostics outside changed files: `agent-browser-sandbox-artifacts.integration.test.ts`, `sandbox/preparation.test.ts` and two locations in `sandbox/runtime/runtime-bundle.test.ts`. This report does not claim a clean global typecheck.

The native CI preparation now restores the exact frozen daily Pi 1.1.0 archives without rewriting lockfile integrity. Its Ubuntu snapshot downloads use the runner's CA bundle without upgrading pinned builder packages. Runtime fixtures persist required project trust through Pi's public store, target canonical configuration paths and validate candidate provenance separately from historical installed provenance. Docker assertions check authorized execution starts rather than a client-specific creation sequence. The runner executes every candidate file and reports all failures before returning nonzero. Earlier failures and focused RED/GREEN evidence are retained in the private evidence report.

The engine's existing path-based limitation for pre-existing hard-link aliases remains. Native tests cover attempts to create protected links, redirect writes through symlinks and rename dependencies into permitted caches.

## Installed identity and recovery

The daily entry `~/.pi/bin/zerobox` points to `~/.pi/runtimes/zerobox/native-40305494210-1/bin/zerobox`. Engine/helper SHA-256: `1232884cc94810b051736ee7d5502a078f193758bd8e63571e201723feb8000c`. Runtime manifest SHA-256: `892dd4c9c512fdac1492e96af0a5f4d15edb4158c752a1680fa2b1683949b7fc`. The downloaded ZIP matched GitHub artifact `12642627064` and its recorded SHA-256 `894cef205973ac8b99587e5438463b905a5caf0cf2a42343c3d0080080dc945f`; the nested archive and extracted provenance were also checked. Builder permissions were restored after safe tar extraction before local validation, without changing file contents.

Only `filesystem.denyWriteExceptions` changed in `~/.pi/agent/config/sandbox.json`; every other value was compared and preserved. The file remains mode `0600`. The previous runtime `2026.10.01.docker-trust.1` and exact prior configuration bytes remain available. Recovery state, the backup and a guarded rollback script are under `~/.cache/pi-sandbox-cache-exceptions-20261026/activation-wh1mz2cz/`. The rollback script refuses to overwrite later configuration or runtime changes and was not executed during rollout.

The full evidence report is `~/.cache/pi-sandbox-cache-exceptions-20261026/REPORT.md`. Existing Pi sessions must reload the changed extensions or restart Pi; the fresh-session checks above used the promoted release. Unrelated local edits were preserved and excluded from the targeted commits.
