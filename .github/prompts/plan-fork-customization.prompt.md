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

### 3. Local Installation Test
- Build the package (`npm run build` or equivalent)
- Point pi's `settings.json` to the local path (e.g. `/home/abdwhb/projects/pi-integrations/<fork>`)
- **Run the actual pi command that was broken** to confirm the fix works end-to-end

### 4. Remote Installation
- Commit and push to the remote fork
- Update `settings.json` to point to the remote GitHub URL
- Run `pi install <url>` to test fresh clone flow
- **Verify the `prepare` script exists** in package.json — without it, `pi install` from git will clone but never build `dist/`. The `prepare` lifecycle hook runs automatically after `bun install`/`npm install`.
  - Use `"prepare": "npm run build"` (not `bun run build`) to stay compatible with upstream merges
- **Run the actual pi command** again to confirm the remote install works

### 5. Fallback
If remote installation fails (network, auth, etc.), keep the local path installation as fallback and note it.

## Common Pitfalls

| Pitfall | Mitigation |
|---------|-----------|
| `dist/` doesn't exist after git clone | Add `"prepare": "npm run build"` to package.json |
| Old persisted state blocks fix | Normalize legacy values on read, not just on write |
| Build fails locally (missing peer deps) | Check if deps are available in pi's context (they will be during `pi install`) |
| Upstream merges conflict | Keep scripts compatible with upstream conventions (use `npm run`, not `bun run`) |
| Tests pass but real command still broken | Run the actual end-user command (e.g. `pi --resume`) not just unit tests |

Here is the customisation I need.