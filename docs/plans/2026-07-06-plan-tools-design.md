# Design: write_plan / edit_plan Tools

**Date:** 2026-07-06
**Context:** Agent fails to write plan files in the designated `pi-plans/` directory, causing `plan_submit` rejections. The plan role's `write`/`edit` tools need path-guarding wrappers.

## Architecture

Two new tools registered by `pi-roles-addons` extension, replacing `write`/`edit` in the plan role:

- `write_plan(path, content)` — file write restricted to configured plan directory
- `edit_plan(path, edits)` — file edit restricted to configured plan directory

Read config from `plannotator.json` chain (`resolvePlanFileDir()`), consistent with `plan_submit`.

## Path Resolution (shared)

```
resolvePlanPath(rawPath, cwd, planFileDir):
  1. If rawPath contains ".." → reject (security)
  2. If isAbsolute(rawPath):
       If not rawPath.startsWith(resolve(cwd, planFileDir)) → reject
  3. Else:
       resolved = resolve(cwd, planFileDir, rawPath)
  4. Return resolved
```

## Tool: write_plan

**Parameters:** `{ path: string, content: string }`

**Execute:**
1. Load `planFileDir` from plannotator config chain
2. If unset → error: "No plan directory configured"
3. Resolve target path via `resolvePlanPath`
4. `mkdir -p` plan dir + parent dirs
5. Write content to file
6. Return success with byte count

## Tool: edit_plan

**Parameters:** `{ path: string, edits: Array<{ oldText: string, newText: string }> }`

**Execute:**
1-3. Same as write_plan
4. File must exist → else error
5. Read original content
6. For each edit: find unique `oldText` match → replace
7. Write back
8. Return success with edit count

## Error Cases

| Condition | Message |
|---|---|
| No planFileDir | "No plan directory configured. Set 'planFileDir' in plannotator.json." |
| Path contains `..` | "Path must be inside the plan directory: {path}" |
| Absolute path outside dir | "Path must be inside the plan directory ({dir}): {path}" |
| File not found (edit) | "File not found: {path}" |
| oldText not found | "Could not find match in {path}" |
| oldText ambiguous | "oldText matches N locations — must be unique" |

## Role Update

`roles/plan.md` tools line: `write, edit` → `write_plan, edit_plan`

## Files

- `extensions/pi-roles-addons/plan-tools.ts` — new module
- `extensions/pi-roles-addons/plan-tools.test.ts` — unit tests
- `extensions/pi-roles-addons/index.ts` — register tools (modify)
- `agent/roles/plan.md` — tool list update (modify)
