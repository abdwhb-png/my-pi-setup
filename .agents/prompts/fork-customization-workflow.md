I have installed this pi package/extension, but when I used it I noticed I need to customize it so I forked it in `~/projects/pi-integrations`.

## Fork Workflow

### 1. Discovery

Read the project's discovery files (package.json, tsconfig, tests, .gitignore) to understand:

- Package manager and build system (bun, npm, pnpm)
- Test framework (vitest, bun:test, jest)
- Whether `dist/` is gitignored (it always is → `prepare` script needed)
- The `pi.extensions` entry point path
- Whether the package has peer deps that may be missing locally

### 2. Implementation (TDD — RED → GREEN → REFACTOR)

- Write a failing test first that captures the broken behavior
- Write minimal code to fix it
- Refactor without breaking tests
- Run the **full** test suite

**⚠ Watch for persisted state:** If the bug involves data that gets written to session logs or disk (e.g. `pi.appendEntry`, `pi.setSessionName`, config files), old persisted values may outlive the code fix. Fix both:

- The code that _writes_ the bad value (prevent future occurrences)
- The code that _reads_ the bad value (handle legacy data gracefully)

### 3. Determine Install Strategy: Standalone or Monorepo?

The fork's project structure determines how it can be installed.

**Standalone package** (e.g. pi-roles): a single package at repo root.

- Can use **remote GitHub URL** in `settings.json`
- Must add `"prepare": "npm run build"` to package.json (see §4)

**Monorepo package** (e.g. plannotator): the extension lives in a subdirectory (`apps/pi-extension/`) of a larger project.

- **Cannot use remote GitHub URL** — pi's `installGit` always clones the full repo and reads from root; it has no mechanism to target a subdirectory.
- Must use **local path** in `settings.json` instead (e.g. `~/projects/pi-integrations/<fork>/apps/pi-extension`)
- Also needs `prepare: true` in `trust.json` if the extension has TypeScript files that pi loads directly (pi may need to report trust before running `.ts` extensions)

Check these to decide:

- Does the pi extension's `package.json` have a `"pi"` key with extension paths?
- Does the **root** package.json have that key? If only the subdirectory has it, it's a monorepo.
- Are the extension's build-time assets gitignored (generated/ , .html files from sibling apps)?

### 4. Local Installation Test

- Build the package (`npm run build` or equivalent)
- Point pi's `settings.json` to the local path (e.g. `~/projects/pi-integrations/<fork>` or the monorepo subdir)
- If the extension uses TypeScript entry points directly (not `dist/`), ensure `trust.json` marks it as trusted or includes `"prepare": true` so pi pre-compiles it
- **Run the actual pi command that was broken** to confirm the fix works end-to-end

### 5. Remote Installation (standalone packages only)

- Commit and push to the remote fork
- Update `settings.json` to point to the remote GitHub URL
- Run `pi install <url>` to test fresh clone flow
- **Verify the `prepare` script exists** in package.json — without it, `pi install` from git will clone but never build `dist/`. The `prepare` lifecycle hook runs automatically after `bun install`/`npm install`.
  - Use `"prepare": "npm run build"` (not `bun run build`) to stay compatible with upstream merges
- **Run the actual pi command** again to confirm the remote install works

### 6. Fallback

- **Standalone**: if remote installation fails (network, auth, etc.), keep the local path installation as fallback
- **Monorepo**: local path is the primary (and only) option — no fallback needed

### 7. Keep the Prompt Updated

After completing the customisation, update this prompt with any new pitfalls or patterns you discovered so future iterations benefit from the experience.

## Common Pitfalls

| Pitfall                                                                              | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dist/` doesn't exist after git clone                                                | Add `"prepare": "npm run build"` to package.json                                                                                                                                                                                                                                                                                                                                                                                         |
| Old persisted state blocks fix                                                       | Normalize legacy values on read, not just on write                                                                                                                                                                                                                                                                                                                                                                                       |
| Build fails locally (missing peer deps)                                              | Check if deps are available in pi's context (they will be during `pi install`)                                                                                                                                                                                                                                                                                                                                                           |
| Upstream merges conflict                                                             | Keep scripts compatible with upstream conventions (use `npm run`, not `bun run`)                                                                                                                                                                                                                                                                                                                                                         |
| Tests pass but real command still broken                                             | Run the actual end-user command (e.g. `pi --resume`) not just unit tests                                                                                                                                                                                                                                                                                                                                                                 |
| Extension is inside a monorepo subdirectory                                          | Cannot use remote GitHub URL — use local path instead. Pi can't target subdirectories in git clones                                                                                                                                                                                                                                                                                                                                      |
| TypeScript extension not loading (trust)                                             | Check `trust.json` — set `"prepare": true` if pi needs to pre-compile `.ts` entry points; or use `pi config --trust`                                                                                                                                                                                                                                                                                                                     |
| DTS build fails on missing peer dep                                                  | tsup with `dts: true` fails if a `type-only` import from an optional peer dep can't be resolved. Set `dts: false` in tsup config — Pi loads via jiti at runtime and doesn't need `.d.ts` files                                                                                                                                                                                                                                           |
| `prepare` script runs `npm run build` but DTS fails → no `dist/` after install       | Same fix: disable DTS in tsup config so the ESM build passes cleanly. Verify with `pi install <url>` end-to-end                                                                                                                                                                                                                                                                                                                          |
| Event-driven cross-extension communication                                           | Use `pi.appendEntry(customType, data)` to emit events to the session log; consumers scan `ctx.sessionManager.getEntries()` in `before_agent_start`. Do NOT rely on the LLM to call a tool to trigger the switch — `before_agent_start` runs programmatically every turn                                                                                                                                                                  |
| Processing markers for idempotency                                                   | When consuming session-log events, persist a `processed` marker entry (`customType: "my-ext:processed", data: { sourceEntryId }`) so the same event isn't re-processed on every turn. Scan for markers after the event entry                                                                                                                                                                                                             |
| `@earendil-works/pi-tui` typecheck error in pi-roles fork                            | Pre-existing — `pi-tui` is an optional peer dep not installed locally. The error exists on `main` before any changes. Filter it out when verifying typecheck                                                                                                                                                                                                                                                                             |
| oxlint not installed in fork                                                         | Use `~/.pi/agent/node_modules/.bin/oxlint` from the pi agent installation, or `npx oxlint` (slow first run). The fork's `package.json` declares it as devDep but `bun install` may not have run                                                                                                                                                                                                                                          |
| Adding a setting to PlannotatorConfig                                                | Four touchpoints: (1) interface `PlannotatorConfig`, (2) `loadConfigSource` parse branch, (3) `mergeConfig` merge field, (4) export a `resolve*` helper. Always add TDD tests for loading, clearing, default, and merge precedence                                                                                                                                                                                                       |
| **pi-roles dist/ stale after source edit**                                           | pi-roles uses `tsup` to compile `src/` → `dist/`. Pi loads the built `dist/index.js`. After ANY source change, run `npm run build` (or `npm run prepare`) before testing with a real pi command. The `prepare` script exists and runs `npm run build`, so `npm install` also triggers it — but inline edits do NOT. Always rebuild before end-to-end verification                                                                        |
| **Moving shared functions between pi extensions**                                    | When refactoring shared functions from one extension file to another (e.g. bridge → main), the importing file must use `./index.js` (ESM `.js` extension). Re-export from the original location for backward compatibility. Tests should import from the new canonical location (`./index.js`), not the re-export. This avoids circular dependencies and keeps the bridge thin                                                           |
| **Bridge pattern for cross-extension events**                                        | When one extension emits events that another extension consumes, the emitter calls a shared function (e.g. `emitPlanApprovedEvent`) imported from the consumer. The consumer detects the event in its lifecycle hook (e.g. `agent_end`), not the emitter. Use processed markers (`customType: "ext:processed", data: { sourceEntryId }`) for idempotency. This keeps the emitter lightweight and the consumer in control of the workflow |
| **Stale package shim masks local-install behavior**                                  | Before local E2E testing, uninstall the old package and verify `~/.pi/agent/node_modules/<pkg>` does not contain stale hand-written re-export stubs from a previous git install. A stale shim can keep pointing at a deleted git checkout and make the wrong failure mode appear.                                                                                                                                                        |
| **Local path install may not provide bare-import resolution for sibling extensions** | If another extension imports the fork by package name/subpath (e.g. `pi-roles/protocol`), `pi install /local/path` may update `settings.json` but still not create a `node_modules` symlink/bridge. Verify `~/.pi/agent/node_modules/<pkg>` after install. If it is missing, create a clean symlink to the local fork before running the real `pi` command, otherwise the local E2E test is invalid.                                     |
