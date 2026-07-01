# Plannotator Bridge Consolidation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate `plan_submit` and `plan_annotate` tools into the main plannotator extension, so the main extension owns all plan-submission logic (browser review, `plannotator:plan-approved` events, `autoExecute` flow, phase management). Delete the `plannotator-bridge.ts` extension entirely.

**Architecture:** Extract a shared `submitPlan()` function that both `plannotator_submit_plan` (with phase gate) and `plan_submit` (without phase gate) call. Move `plan_annotate` tool registration into the main extension. The main extension emits `plannotator:plan-approved` on every approval — the bridge never owned events.

**Tech Stack:** TypeScript, Pi ExtensionAPI, Plannotator browser UI

## Global Constraints

- `plan_submit` must remain available to all roles (no phase gate — unlike `plannotator_submit_plan`
- `autoExecute` config must work identically for both `plannotator_submit_plan` and `plan_submit` (send "Continue" follow-up after approval)
- `plannotator:plan-approved` event must be emitted on every approval (consumed by `plan-auto-switch`)
- `plan_annotate` must continue working as before
- Delete `plannotator-bridge.ts` and all its exports (event emission, validation helpers) — move any still-needed code into the main extension or config
- `package.json` `pi.extensions` must be updated to remove `"./plannotator-bridge.ts"`

---

### Task 1: Extract shared submit logic into `_submitPlan` helper

**Files:**
- Modify: `index.ts` (main plannotator extension)

**Interfaces:**
- Consumes: `PLAN_SUBMIT_TOOL`, `plannotatorConfig`, `phase`, `lastSubmittedPath`, `checklistItems`, `justApprovedPlan`, `openPlanReviewBrowser`, `resolveAutoExecute`, `applyPhaseConfig`, `persistState`, `getPlanApprovedPrompt`, `getPlanApprovedWithNotesPrompt`, `getPlanDeniedPrompt`, `getPlanAutoApprovedPrompt`, `loadConfig`, `parseChecklist`
- Produces: `submitPlan(opts)` function used by Task 2 and Task 3

**Design:** Extract all the shared logic from the existing `plannotator_submit_plan.execute()` body into a standalone async function:

```ts
interface SubmitPlanOpts {
  params: { filePath?: string };
  ctx: Parameters<typeof pi.registerTool>[0]["execute"] extends (...args: infer A) => any ? A[4] : never;
  pi: ExtensionAPI;
  /** When true, gate on phase === "planning". When false, skip the gate. */
  withPhaseGate: boolean;
}

async function submitPlan(opts: SubmitPlanOpts): Promise<ToolResult> {
  // 1. Validate inputPath (shared with existing code)
  // 2. If opts.withPhaseGate: check phase === "planning", return error if not
  // 3. Validate path, read file (shared)
  // 4. If !ctx.hasUI || !hasPlanBrowserHtml(): auto-approve path (shared)
  // 5. Open browser, get decision (shared)
  // 6. On approval: emit plannotator:plan-approved event (NEW — using bridge's emitPlanApprovedEvent logic)
  // 7. On approval + autoExecute: set phase, applyPhaseConfig, justApprovedPlan=true (shared)
  // 8. Return appropriate prompt/result (shared)
}
```

- [ ] **Step 1: Write the failing test for `submitPlan`**

```ts
// test/submit-plan.test.ts
import { describe, expect, it, mock, beforeAll } from "bun:test";

// Mock external deps that require jiti/pi runtime
mock.module("./plannotator-browser.js", () => ({
  openPlanReviewBrowser: mock(),
  openMarkdownAnnotation: mock(),
  hasPlanBrowserHtml: mock().mockReturnValue(false),
}));

const { submitPlan } = await import("../index.ts");

describe("submitPlan", () => {
  it("emits plannotator:plan-approved on approval", async () => {
    const appendEntrySpy = mock(() => {});
    const fakePi = {
      appendEntry: appendEntrySpy,
      on: mock(() => {}),
      registerTool: mock(() => {}),
      registerCommand: mock(() => {}),
      registerShortcut: mock(() => {}),
      registerMessageRenderer: mock(() => {}),
      registerFlag: mock(() => {}),
      sendMessage: mock(() => {}),
      sendUserMessage: mock(() => {}),
    };
    const fakeCtx = {
      cwd: "/tmp/test",
      hasUI: false,
      sessionManager: { getEntries: mock(() => []) },
    };

    const result = await submitPlan({
      params: { filePath: "test-plan.md" },
      ctx: fakeCtx as any,
      pi: fakePi as any,
      withPhaseGate: false,
    });

    // Verify event emission
    const planApprovedCall = appendEntrySpy.mock.calls.find(
      ([type]: [string, any]) => type === "plannotator:plan-approved"
    );
    expect(planApprovedCall).toBeDefined();
    expect(planApprovedCall[1].approved).toBe(true);
  });

  it("gates on planning phase when withPhaseGate is true", async () => {
    // ... set phase to "idle", expect error result
  });

  it("skips phase gate when withPhaseGate is false", async () => {
    // ... set phase to "idle", expect approval to proceed (no error)
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/abdwhb/projects/pi-integrations/plannotator/apps/pi-extension && bun test test/submit-plan.test.ts`
Expected: FAIL — `submitPlan` not exported yet.

- [ ] **Step 3: Extract `submitPlan` function from `plannotator_submit_plan.execute()`**

Copy the body of `plannotator_submit_plan.execute()` into `submitPlan()`, with these changes:
- Wrap the phase gate check (`if (phase !== "planning")`) in `if (opts.withPhaseGate)`
- After browser decision returns approved: add `emitPlanApprovedEvent(opts.pi, fullPath, result.feedback)` — inline the bridge's `emitPlanApprovedEvent` logic or import from a shared location (see Task 6)
- Move `PLAN_APPROVED_ENTRY_TYPE` constant into this file (rehome from bridge)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/abdwhb/projects/pi-integrations/plannotator/apps/pi-extension && bun test test/submit-plan.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /home/abdwhb/projects/pi-integrations/plannotator/apps/pi-extension
git add index.ts test/submit-plan.test.ts
git commit -m "refactor: extract submitPlan helper with event emission"
```

---

### Task 2: Rewire `plannotator_submit_plan` to call `submitPlan`

**Files:**
- Modify: `index.ts:722-920` (the `plannotator_submit_plan` tool registration)

**Interfaces:**
- Consumes: `submitPlan` from Task 1
- Produces: `plannotator_submit_plan` tool now delegates to `submitPlan`

- [ ] **Step 1: Update the test to verify `plannotator_submit_plan` works**

Add to test file:

```ts
it("plannotator_submit_plan delegates to submitPlan with phase gate", async () => {
  // Set phase to "planning", call plannotator_submit_plan via the tool API
  // Verify it delegates to submitPlan
});
```

- [ ] **Step 2: Run test to verify it fails** (tool still uses old inline implementation)

Run: `cd /home/abdwhb/projects/pi-integrations/plannotator/apps/pi-extension && bun test test/submit-plan.test.ts`
Expected: FAIL — tool delegates to old body.

- [ ] **Step 3: Replace `plannotator_submit_plan.execute()` body with delegation**

```ts
async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
  return submitPlan({ params: params as { filePath?: string }, ctx, pi, withPhaseGate: true });
}
```

Delete all the old inline code (lines ~740-920).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/abdwhb/projects/pi-integrations/plannotator/apps/pi-extension && bun test test/submit-plan.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add index.ts test/submit-plan.test.ts
git commit -m "refactor: plannotator_submit_plan delegates to submitPlan"
```

---

### Task 3: Register `plan_submit` tool in the main extension

**Files:**
- Modify: `index.ts` (main extension)

**Interfaces:**
- Consumes: `submitPlan` from Task 1
- Produces: `plan_submit` tool registered alongside `plannotator_submit_plan`

- [ ] **Step 1: Write the failing test**

```ts
it("plan_submit delegates to submitPlan without phase gate", async () => {
  // Verify plan_submit tool is registered and calls submitPlan with withPhaseGate: false
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — `plan_submit` tool not registered.

- [ ] **Step 3: Register `plan_submit` tool**

Add after the `plannotator_submit_plan` registration:

```ts
pi.registerTool({
  name: "plan_submit",
  label: "Submit Plan",
  description:
    "Submit a plan markdown file (.md or .mdx) for browser-based review via Plannotator. " +
    "Write the plan file first using the write tool, then call this with its path. " +
    "The user will review the plan in a visual browser UI and can approve, annotate, or deny it. " +
    "When autoExecute is enabled in plannotator config, the agent automatically continues " +
    "with execution after approval.",
  parameters: Type.Object({
    filePath: Type.String({
      description:
        "Path to the markdown plan file, relative to the working directory. Must end in .md or .mdx.",
    }),
  }) as any,
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    return submitPlan({ params: params as { filePath?: string }, ctx, pi, withPhaseGate: false });
  },
});
```

- [ ] **Step 4: Run test to verify it passes**

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add index.ts test/submit-plan.test.ts
git commit -m "feat: register plan_submit tool in main extension"
```

---

### Task 4: Move `plan_annotate` tool into the main extension

**Files:**
- Modify: `index.ts` (main extension)
- Delete: `plannotator-bridge.ts` (in Task 5)

**Interfaces:**
- Consumes: `openMarkdownAnnotation`, `hasPlanBrowserHtml` from `./plannotator-browser.js`
- Produces: `plan_annotate` tool registered in main extension

- [ ] **Step 1: Write the failing test**

```ts
it("plan_annotate tool is registered and works", async () => {
  // Verify plan_annotate tool opens the annotation browser
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — `plan_annotate` not in main extension.

- [ ] **Step 3: Move `plan_annotate` tool registration**

Copy the `plan_annotate` tool registration from `plannotator-bridge.ts` lines ~330-430 into the main extension's `index.ts`, after the `plan_submit` registration. Import `openMarkdownAnnotation` from `./plannotator-browser.js` (already imported in the main extension — verify).

- [ ] **Step 4: Run test to verify it passes**

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add index.ts test/submit-plan.test.ts
git commit -m "feat: register plan_annotate tool in main extension"
```

---

### Task 5: Delete `plannotator-bridge.ts` and its test file

**Files:**
- Delete: `plannotator-bridge.ts`
- Delete: `plannotator-bridge.test.ts` (if exists)
- Modify: `package.json` — remove `"./plannotator-bridge.ts"` from `pi.extensions`

- [ ] **Step 1: Verify no other files import from `plannotator-bridge.ts`**

Run: `grep -rn "plannotator-bridge" /home/abdwhb/projects/pi-integrations/plannotator/apps/pi-extension/ --include="*.ts" --include="*.json" | grep -v "test\|node_modules"`
Expected: Only `package.json` and the bridge file itself.

- [ ] **Step 2: Update `package.json`**

```json
// Before:
"pi": { "extensions": ["./", "./plannotator-bridge.ts"] }
// After:
"pi": { "extensions": ["./"] }
```

- [ ] **Step 3: Delete `plannotator-bridge.ts` and `plannotator-bridge.test.ts`**

```bash
rm plannotator-bridge.ts
rm plannotator-bridge.test.ts  # if exists
```

- [ ] **Step 4: Run full test suite**

Run: `cd /home/abdwhb/projects/pi-integrations/plannotator/apps/pi-extension && bun test`
Expected: All tests pass, no bridge tests remaining.

- [ ] **Step 5: Commit**

```bash
git rm plannotator-bridge.ts
git rm plannotator-bridge.test.ts  # if exists
git add package.json
git commit -m "refactor: delete plannotator-bridge, tools now in main extension"
```

---

### Task 6: Rehome `emitPlanApprovedEvent` into main extension

**Files:**
- Modify: `index.ts` (main extension)

**Context:** The bridge's `emitPlanApprovedEvent` and `PLAN_APPROVED_ENTRY_TYPE` are already consumed by `plan-auto-switch` and the new `submitPlan` function (Task 1). Move these definitions into the main extension (or a shared module) so they survive the bridge deletion.

- [ ] **Step 1: Verify `PLAN_APPROVED_ENTRY_TYPE` and `emitPlanApprovedEvent` are defined in index.ts**

Check: the `submitPlan` function (Task 1) already inlined these or imported them. If imported from bridge, relocate to index.ts.

- [ ] **Step 2: Run tests to verify event emission still works**

Run: `cd /home/abdwhb/projects/pi-integrations/plannotator/apps/pi-extension && bun test test/submit-plan.test.ts`
Expected: PASS — event emission test still green.

- [ ] **Step 3: Commit**

```bash
git add index.ts
git commit -m "refactor: rehome plan-approved event into main extension"
```

---

### Task 7: End-to-end verification

- [ ] **Step 1: Rebuild and test in Pi**

```bash
cd /home/abdwhb/projects/pi-integrations/plannotator/apps/pi-extension
# Rebuild if needed (check if build script exists)
```

- [ ] **Step 2: Restart Pi and test `plan_submit` with autoExecute**

1. Start Pi, switch to a role that has `plan_submit` tool (e.g. plan role)
2. Have the LLM write a plan and call `plan_submit`
3. Approve the plan in the browser
4. Verify: the role auto-switches to pi-agent (via `plan-auto-switch` → `pi-roles:switch-request`)
5. Verify: with `autoExecute: true`, the LLM continues execution without waiting for user message
6. Check session log for `plannotator:plan-approved` → `pi-roles:switch-request` → `pi-roles:active-role=pi-agent` sequence

- [ ] **Step 3: Test `plan_annotate` tool**

1. Call `plan_annotate` with a file path
2. Verify the annotation browser opens
3. Submit feedback — verify it's returned to the LLM

- [ ] **Step 4: Test `plannotator_submit_plan` (phase-gated) still works**

1. `/plannotator` to enter planning mode
2. Write plan, call `plannotator_submit_plan`
3. Verify phase gate works (can't call outside planning mode)
4. Approve — verify autoExecute works

- [ ] **Step 5: Commit final verification notes**
