---
agent: Plan
---
I have installed this pi package/extension, but when I used it I noticed I need to customize it so I forked it in `pi-integrations`.

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
  - The code that *writes* the bad value (prevent future occurrences)
  - The code that *reads* the bad value (handle legacy data gracefully)

### 3. Determine Install Strategy: Standalone or Monorepo?

The fork's project structure determines how it can be installed.

**Standalone package** (e.g. pi-roles): a single package at repo root.
- Can use **remote GitHub URL** in `settings.json`
- Must add `"prepare": "npm run build"` to package.json (see §4)

**Monorepo package** (e.g. plannotator): the extension lives in a subdirectory (`apps/pi-extension/`) of a larger project.
- **Cannot use remote GitHub URL** — pi's `installGit` always clones the full repo and reads from root; it has no mechanism to target a subdirectory.
- Must use **local path** in `settings.json` instead (e.g. `/home/abdwhb/projects/pi-integrations/<fork>/apps/pi-extension`)
- Also needs `prepare: true` in `trust.json` if the extension has TypeScript files that pi loads directly (pi may need to report trust before running `.ts` extensions)

Check these to decide:
- Does the pi extension's `package.json` have a `"pi"` key with extension paths?
- Does the **root** package.json have that key? If only the subdirectory has it, it's a monorepo.
- Are the extension's build-time assets gitignored (generated/ , .html files from sibling apps)?

### 4. Local Installation Test
- Build the package (`npm run build` or equivalent)
- Point pi's `settings.json` to the local path (e.g. `/home/abdwhb/projects/pi-integrations/<fork>` or the monorepo subdir)
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

| Pitfall | Mitigation |
|---------|-----------|
| `dist/` doesn't exist after git clone | Add `"prepare": "npm run build"` to package.json |
| Old persisted state blocks fix | Normalize legacy values on read, not just on write |
| Build fails locally (missing peer deps) | Check if deps are available in pi's context (they will be during `pi install`) |
| Upstream merges conflict | Keep scripts compatible with upstream conventions (use `npm run`, not `bun run`) |
| Tests pass but real command still broken | Run the actual end-user command (e.g. `pi --resume`) not just unit tests |
| Extension is inside a monorepo subdirectory | Cannot use remote GitHub URL — use local path instead. Pi can't target subdirectories in git clones |
| TypeScript extension not loading (trust) | Check `trust.json` — set `"prepare": true` if pi needs to pre-compile `.ts` entry points; or use `pi config --trust` |

Here is the customisation I need.