<!-- markdownlint-disable MD013 MD024 MD029 MD031 MD032 MD040 -->

# Modular Deterministic SDD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking. Do not fork pi-subagents.

**Goal:** Replace the manually polled SDD queue with a deterministic, profile-driven TDD orchestrator that uses the public pi-subagents 0.35.1 foreground delegation contract.

**Architecture:** A strict Markdown compiler produces versioned plan tasks, a read-only assessor produces schema-validated signals, and pure TypeScript rules compile an approvable manifest. A durable state machine delegates one foreground child at a time or a statically safe batch, launches fresh correction workers when required, and fails safe on restart when a child response is uncertain.

**Tech Stack:** Bun 1.3.14, TypeScript 6 strict mode, bun:test, TypeBox 0.34.49, Pi ExtensionAPI, pi-subagents 0.35.1 delegation events, existing shared config loader, Pi TUI.

## Global Constraints

- Use only the public pi-subagents/delegation export; do not import package internals or fork pi-subagents.
- Follow RED then GREEN then REFACTOR vertically; never write production code before observing the corresponding failing test.
- Worker and correction-worker requests have no hard turn or tool-call budget. Bound them with exact scope and a 45-minute outer timeout.
- Reviewer requests have no hard turn or tool-call budget. Bound them with read-only instructions and a 15-minute outer timeout.
- One logical assessor job may have one schema-repair retry. A review schema-repair retry consumes one reviewer attempt and one child launch from the approved profile ceiling; it cannot expand that ceiling.
- Direct launches zero children; Light launches one worker; Standard launches at most four children; Critical launches at most seven children before an optional global integration review.
- Standard and Critical corrections always use fresh child sessions with explicit prior output, artifacts, and findings.
- Persist a transition before every external delegation or cancellation.
- Never automatically relaunch an unterminated foreground delegation after restart.
- Preserve agent/.sdd/queue/sdd-mqxpovpu-8m9fgo.json and its progress file byte-for-byte until the user explicitly resolves the legacy run.
- Do not add dependencies: use node built-ins, existing TypeBox, and existing shared helpers.
- Do not run build or dev commands.
- Do not commit unless the user explicitly authorizes commits during execution.

## File Structure

- Create agent/extensions/sdd-orchestrator/types.ts: shared domain types and profile ordering.
- Create agent/extensions/sdd-orchestrator/schemas.ts: TypeBox schemas and strict JSON result parsing.
- Create agent/extensions/sdd-orchestrator/plan-parser.ts: strict Task heading and sdd-task metadata compiler.
- Create agent/extensions/sdd-orchestrator/classification.ts: deterministic signal-to-profile rules.
- Create agent/extensions/sdd-orchestrator/config.ts: validated settings.json overlay for agents, models, timeouts, and concurrency.
- Create agent/extensions/sdd-orchestrator/manifest.ts: digests, effective profiles, budgets, dependency validation, and parallel eligibility.
- Create agent/extensions/sdd-orchestrator/state-machine.ts: legal transitions and idempotency.
- Create agent/extensions/sdd-orchestrator/store.ts: atomic snapshot and append-only transition persistence.
- Create agent/extensions/sdd-orchestrator/delegation-client.ts: public pi-subagents event adapter.
- Create agent/extensions/sdd-orchestrator/prompts.ts: assessor, worker, correction, and reviewer contracts.
- Create agent/extensions/sdd-orchestrator/workflow.ts: profile execution, correction loops, batches, and restart reconciliation.
- Create agent/extensions/sdd-orchestrator/review-ui.ts: typed manifest decision controller and interactive overlay.
- Rewrite agent/extensions/sdd-orchestrator/index.ts: thin tool and command registration.
- Split agent/extensions/sdd-orchestrator/sdd-orchestrator.test.ts into focused module tests, retaining a real index.ts import smoke test.
- Create agent/agents/orchestration-assessor.md, sdd-combined-reviewer.md, sdd-spec-reviewer.md, and sdd-quality-reviewer.md.
- Modify agent/roles/plan.md and agent/roles/quick-planner.md.
- Modify agent/agents/sdd-orchestrator.md only to mark it legacy-only; do not remove it while the legacy queue exists.
- Modify agent/extensions/sdd-orchestrator/package.json.

---

### Task 1: Strict Plan Contract and Parser

```sdd-task
{"id":"task-1","dependsOn":[],"files":["agent/extensions/sdd-orchestrator/types.ts","agent/extensions/sdd-orchestrator/schemas.ts","agent/extensions/sdd-orchestrator/plan-parser.ts","agent/extensions/sdd-orchestrator/plan-parser.test.ts","agent/extensions/sdd-orchestrator/sdd-orchestrator.test.ts"],"verify":[{"id":"task-1-tests","command":"cd ~/.pi/agent && bun test extensions/sdd-orchestrator/plan-parser.test.ts extensions/sdd-orchestrator/sdd-orchestrator.test.ts"}]}
```

**Files:**

- Create: agent/extensions/sdd-orchestrator/types.ts
- Create: agent/extensions/sdd-orchestrator/schemas.ts
- Create: agent/extensions/sdd-orchestrator/plan-parser.ts
- Create: agent/extensions/sdd-orchestrator/plan-parser.test.ts
- Modify: agent/extensions/sdd-orchestrator/sdd-orchestrator.test.ts

**Interfaces:**

- Produces: parseSddPlan(content: string): ParsedPlan
- Produces: parseStrictJson<T extends TSchema>(text: string, schema: T): Static<T>
- Produces: Profile, ParsedPlan, ParsedTask, VerifyCommand
- Consumes later: manifest.ts, prompts.ts, index.ts

- [ ] **Step 1: Write the failing strict-parser tracer test**

  import { describe, expect, it } from "bun:test";
  import { parseSddPlan } from "./plan-parser.ts";

  describe("parseSddPlan", () => {
  it("compiles an exact task heading and sdd-task metadata", () => {
  const plan = [
  "# Feature",
  "",
  "### Task 1: Add parser",
  "",
  "~~~sdd-task",
  JSON.stringify({
  id: "task-1",
  dependsOn: [],
  files: ["src/parser.ts", "src/parser.test.ts"],
  verify: [{ id: "parser", command: "bun test src/parser.test.ts" }],
  }),
  "~~~",
  "",
  "Implement with TDD.",
  ].join("\n");

              expect(parseSddPlan(plan).tasks[0]).toEqual({
                    id: "task-1",
                    ordinal: 1,
                    title: "Add parser",
                    body: "Implement with TDD.",
                    dependsOn: [],
                    files: ["src/parser.ts", "src/parser.test.ts"],
                    verify: [{ id: "parser", command: "bun test src/parser.test.ts" }],
                  });
                });

  });

- [ ] **Step 2: Run the tracer test and observe RED**

  Run: cd ~/.pi/agent && bun test extensions/sdd-orchestrator/plan-parser.test.ts

  Expected: FAIL because plan-parser.ts does not exist.

- [ ] **Step 3: Add the minimal domain types and parser**

  In types.ts:

  export const PROFILES = ["direct", "light", "standard", "critical"] as const;
  export type Profile = (typeof PROFILES)[number];

  export interface VerifyCommand {
  id: string;
  command: string;
  timeoutMs?: number;
  }

  export interface ParsedTask {
  id: string;
  ordinal: number;
  title: string;
  body: string;
  dependsOn: string[];
  files: string[];
  verify: VerifyCommand[];
  }

  export interface ParsedPlan {
  title: string;
  tasks: ParsedTask[];
  }

  In plan-parser.ts, implement the exact public behavior:

  import { Type, type Static } from "@sinclair/typebox";
  import { Value } from "@sinclair/typebox/value";
  import type { ParsedPlan } from "./types.ts";

  const MetadataSchema = Type.Object({
  id: Type.String({ pattern: "^task-[1-9][0-9]_$" }),
    dependsOn: Type.Array(Type.String({ pattern: "^task-[1-9][0-9]_$" })),
  files: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  verify: Type.Array(Type.Object({
  id: Type.String({ minLength: 1 }),
  command: Type.String({ minLength: 1 }),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
  }), { minItems: 1 }),
  }, { additionalProperties: false });

  type Metadata = Static<typeof MetadataSchema>;

  function readMetadata(section: string, ordinal: number): { metadata: Metadata; body: string } {
  const match = section.match(/^\s*~~~sdd-task\s*\n([\s\S]_?)\n~~~\s_\n?([\s\S]\*)$/);
  if (!match) throw new Error("Task " + ordinal + " must start with one ~~~sdd-task JSON block.");
  const parsed: unknown = JSON.parse(match[1]);
  if (!Value.Check(MetadataSchema, parsed)) {
  const errors = [...Value.Errors(MetadataSchema, parsed)].map((error) => error.message).join("; ");
  throw new Error("Task " + ordinal + " metadata is invalid: " + errors);
  }
  if (parsed.id !== "task-" + ordinal) throw new Error("Task " + ordinal + " metadata id must be task-" + ordinal + ".");
  return { metadata: parsed, body: match[2].trim() };
  }

  export function parseSddPlan(content: string): ParsedPlan {
  const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
      if (!title) throw new Error("SDD plan requires one level-one title.");
      const matches = [...content.matchAll(/^### Task ([1-9][0-9]*):\s+(.+)$/gm)];
  if (matches.length === 0) throw new Error("SDD plan requires at least one exact ### Task N: Title heading.");
  const tasks = matches.map((match, index) => {
  const ordinal = Number(match[1]);
  if (ordinal !== index + 1) throw new Error("Task headings must be contiguous and ordered from 1.");
  const start = (match.index ?? 0) + match[0].length;
  const end = matches[index + 1]?.index ?? content.length;
  const { metadata, body } = readMetadata(content.slice(start, end), ordinal);
  return { ordinal, title: match[2].trim(), body, ...metadata };
  });
  const ids = new Set(tasks.map((task) => task.id));
  for (const task of tasks) {
  for (const dependency of task.dependsOn) {
  if (!ids.has(dependency)) throw new Error(task.id + " depends on unknown task " + dependency + ".");
  if (dependency === task.id) throw new Error(task.id + " cannot depend on itself.");
  }
  }
  return { title, tasks };
  }

- [ ] **Step 4: Run the tracer test and observe GREEN**

  Run: cd ~/.pi/agent && bun test extensions/sdd-orchestrator/plan-parser.test.ts

  Expected: 1 pass, 0 fail.

- [ ] **Step 5: Add one RED then GREEN cycle for each rejection boundary**

  Add tests one at a time for missing metadata, duplicate or skipped ordinals, unknown dependency, self-dependency, invalid JSON, empty files, empty verify commands, and a legacy loose Markdown plan. Each test must assert the exact error fragment before adding only the validation needed for that case.

  Expected final focused result: all parser tests pass, and the legacy loose plan is rejected rather than silently converted into one task.

- [ ] **Step 6: Add strict JSON result parsing with its own RED then GREEN cycle**

  The public parser accepts either a raw JSON object or one complete fenced JSON object and rejects surrounding prose:

  export function normalizeJsonText(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^~~~json\s*\n([\s\S]*?)\n~~~$/);
  return fenced ? fenced[1].trim() : trimmed;
  }

  export function parseStrictJson<TSchema extends import("@sinclair/typebox").TSchema>(
  text: string,
  schema: TSchema,
  ): import("@sinclair/typebox").Static<TSchema> {
  const value: unknown = JSON.parse(normalizeJsonText(text));
  if (!Value.Check(schema, value)) {
  const errors = [...Value.Errors(schema, value)].map((error) => error.message).join("; ");
  throw new Error("Structured output is invalid: " + errors);
  }
  return value;
  }

  Test raw JSON, one fenced JSON object, prose plus JSON rejection, and schema mismatch.

- [ ] **Step 7: Refactor the old test file into an index import smoke test**

  Keep one test that mocks Pi packages before dynamically importing the real index.ts. Remove assertions that preserve the loose legacy parser behavior.

  Run: cd ~/.pi/agent && bun test extensions/sdd-orchestrator/plan-parser.test.ts extensions/sdd-orchestrator/sdd-orchestrator.test.ts

  Expected: PASS with the real modules imported.

- [ ] **Step 8: Record a Git checkpoint**

  Run: git diff -- agent/extensions/sdd-orchestrator

  Expected: only Task 1 files changed. Commit only if the user explicitly authorizes it.

### Task 2: Assessor Schemas and Deterministic Classification

```sdd-task
{"id":"task-2","dependsOn":["task-1"],"files":["agent/extensions/sdd-orchestrator/assessment.ts","agent/extensions/sdd-orchestrator/classification.ts","agent/extensions/sdd-orchestrator/classification.test.ts"],"verify":[{"id":"task-2-tests","command":"cd ~/.pi/agent && bun test extensions/sdd-orchestrator/classification.test.ts extensions/sdd-orchestrator/plan-parser.test.ts"}]}
```

**Files:**

- Create: agent/extensions/sdd-orchestrator/assessment.ts
- Create: agent/extensions/sdd-orchestrator/classification.ts
- Create: agent/extensions/sdd-orchestrator/classification.test.ts

**Interfaces:**

- Consumes: Profile and ParsedTask from types.ts
- Produces: AssessmentSchema, Assessment, TaskAssessment, classifyTask(), effectiveProfile()
- Consumed later by: manifest.ts and workflow.ts

- [ ] **Step 1: RED for one critical signal**

  import { expect, it } from "bun:test";
  import { classifyTask } from "./classification.ts";

  it("classifies one critical signal as critical", () => {
  expect(classifyTask({
  taskId: "task-1",
  signals: ["financial_logic"],
  evidence: [{ signal: "financial_logic", source: "Task 1 handles settlement amounts." }],
  confidence: "high",
  uncertainties: [],
  }).minimum).toBe("critical");
  });

  Run: cd ~/.pi/agent && bun test extensions/sdd-orchestrator/classification.test.ts

  Expected: FAIL because classifyTask is missing.

- [ ] **Step 2: GREEN with versioned categorical schemas**

  Define these exact signal values in assessment.ts:

  export const CRITICAL_SIGNALS = [
  "migration_or_data_transform", "authentication_or_authorization", "secrets",
  "financial_logic", "concurrency_or_processes", "resource_lifecycle",
  "shared_infrastructure", "pi_core_behavior", "inter_extension_protocol",
  "irreversible_operation", "architecture_uncertainty",
  ] as const;

  export const STANDARD_SIGNALS = [
  "multi_module", "public_contract", "external_integration",
  "weak_test_coverage", "requirements_uncertainty",
  ] as const;

  export const LOW_RISK_SIGNALS = [
  "isolated_scope", "clear_requirements", "existing_test_pattern",
  ] as const;

  AssessmentSchema must require version 1, the assessor model string, and exactly one task result per parsed task. Each result contains taskId, signals, evidence, confidence high or medium or low, uncertainties, and advisoryMinimum. advisoryMinimum is stored for audit but never used by classifyTask.

  In classification.ts:

  const rank = { direct: 0, light: 1, standard: 2, critical: 3 } as const;

  export function classifyTask(input: TaskAssessment): ClassificationResult {
  const rules: string[] = [];
  let minimum: Profile = "direct";
  if (input.signals.some((signal) => CRITICAL_SIGNALS.includes(signal as never))) {
  minimum = "critical";
  rules.push("critical-signal");
  } else if (input.signals.some((signal) => ["multi_module", "public_contract", "external_integration"].includes(signal))) {
  minimum = "standard";
  rules.push("standard-boundary");
  } else if (input.signals.includes("weak_test_coverage") && input.signals.includes("requirements_uncertainty")) {
  minimum = "standard";
  rules.push("standard-uncertainty-plus-weak-tests");
  } else if (input.signals.includes("isolated_scope") && input.signals.includes("clear_requirements")) {
  minimum = "light";
  rules.push("light-positive-scope");
  }
  if (input.confidence === "low" && minimum !== "critical") {
  minimum = PROFILES[rank[minimum] + 1];
  rules.push("low-confidence-escalation");
  }
  return { minimum, rules };
  }

- [ ] **Step 3: Run focused GREEN**

  Run: cd ~/.pi/agent && bun test extensions/sdd-orchestrator/classification.test.ts

  Expected: PASS.

- [ ] **Step 4: Add vertical cycles for every deterministic branch**

  Add one test and minimal implementation change at a time for each critical signal, each direct Standard boundary, the two-signal Standard combination, low-confidence escalation, medium-confidence stability, and the fact that advisoryMinimum cannot alter the result.

- [ ] **Step 5: RED then GREEN for global profile deviations**

  Implement:

  export function effectiveProfile(global: Profile, result: ClassificationResult, assessment: TaskAssessment): Profile {
  if (rank[result.minimum] >= rank[global]) return result.minimum;
  const provenLowRisk = assessment.signals.includes("isolated_scope")
  && assessment.signals.includes("clear_requirements")
  && assessment.signals.includes("existing_test_pattern")
  && assessment.confidence === "high";
  return provenLowRisk ? result.minimum : global;
  }

  Test that a Standard global profile stays Standard when evidence is missing, may become Light only with all positive evidence, and always rises to Critical for a critical signal.

- [ ] **Step 6: Verify**

  Run: cd ~/.pi/agent && bun test extensions/sdd-orchestrator/classification.test.ts extensions/sdd-orchestrator/plan-parser.test.ts

  Expected: all focused tests pass.

### Task 3: Configuration and Manifest Compiler

```sdd-task
{"id":"task-3","dependsOn":["task-1","task-2"],"files":["agent/extensions/sdd-orchestrator/config.ts","agent/extensions/sdd-orchestrator/config.test.ts","agent/extensions/sdd-orchestrator/manifest.ts","agent/extensions/sdd-orchestrator/manifest.test.ts"],"verify":[{"id":"task-3-tests","command":"cd ~/.pi/agent && bun test extensions/sdd-orchestrator/config.test.ts extensions/sdd-orchestrator/manifest.test.ts"}]}
```

**Files:**

- Create: agent/extensions/sdd-orchestrator/config.ts
- Create: agent/extensions/sdd-orchestrator/config.test.ts
- Create: agent/extensions/sdd-orchestrator/manifest.ts
- Create: agent/extensions/sdd-orchestrator/manifest.test.ts

**Interfaces:**

- Produces: loadSddConfig(cwd, agentDir?): SddConfig
- Produces: compileManifest(input: { planPath: string; planContent: string; parsedPlan: ParsedPlan; assessment: Assessment; globalProfile: Profile; parallelismEnabled: boolean; config: SddConfig }): DraftManifest
- Produces: applyApproval(draft: DraftManifest, decision: ManifestDecision, currentPlanContent: string): ApprovedManifest
- Produces: budgetsFor(profile): ProfileBudget

- [ ] **Step 1: RED for default configuration**

  Test that loadSddConfig returns these defaults when settings are absent:

  {
  agents: {
  assessor: "orchestration-assessor",
  worker: "worker",
  combinedReviewer: "sdd-combined-reviewer",
  specReviewer: "sdd-spec-reviewer",
  qualityReviewer: "sdd-quality-reviewer",
  },
  models: {},
  timeoutsMs: { assessor: 600000, worker: 2700000, reviewer: 900000 },
  maxConcurrentWriters: 2,
  structuredOutputRetries: 1,
  }

  Run the focused test and expect missing module failure.

- [ ] **Step 2: GREEN using the existing shared loader**

  Import loadExtensionConfig from ../\_shared/config-loader.ts and read the settings.json key sddOrchestrator with project-local overlay semantics. Normalize only known agent names, optional non-empty model strings, positive integer timeouts, maxConcurrentWriters from 1 through 4, and structuredOutputRetries from 0 through 1. Invalid fields fall back to defaults.

  Do not add a new JSON file or dependency.

- [ ] **Step 3: RED then GREEN for immutable budget ceilings**

  Implement exact budgets:

  export function budgetsFor(profile: Profile): ProfileBudget {
  if (profile === "direct") return { initialWorkers: 0, correctionWorkers: 0, reviewerAttempts: 0, maxLaunches: 0 };
  if (profile === "light") return { initialWorkers: 1, correctionWorkers: 0, reviewerAttempts: 0, maxLaunches: 1 };
  if (profile === "standard") return { initialWorkers: 1, correctionWorkers: 1, reviewerAttempts: 2, maxLaunches: 4 };
  return { initialWorkers: 1, correctionWorkers: 2, reviewerAttempts: 4, maxLaunches: 7 };
  }

  Test exact deep equality for all four profiles.

- [ ] **Step 4: RED then GREEN for manifest compilation**

  compileManifest must:

  - compute SHA-256 digests with node:crypto for source plan and canonical assessment JSON;
  - verify assessment task IDs exactly match parsed task IDs;
  - store manifestVersion 1 and ruleSetVersion 1;
  - store globalProfile, classification rules, recommended effective profile, dependencies, files, verify commands, and budgets;
  - reject dependency cycles with the concrete cycle path;
  - mark parallelEligible false for dependencies, overlapping files, critical shared-contract signals, or an explicit global parallelism disable;
  - compute maximumLaunches as the sum of per-task ceilings plus one only when finalIntegrationReview is required.

  Test a two-task plan where disjoint independent files are parallel eligible and overlapping files force sequential execution.

- [ ] **Step 5: RED then GREEN for typed approval**

  ManifestDecision contains globalProfile, taskOverrides, parallelismEnabled, criticalDowngradeConfirmations, criticalDowngradeJustifications, approvedBy, and approvedAt.

  applyApproval must reject:

  - stale source digest;
  - unknown task override;
  - Critical recommendation lowered to Light or Direct without both an explicit confirmation and a non-empty justification;
  - any effective profile outside the four enums.

  It must produce a frozen ApprovedManifest with state approved and an approval digest.

- [ ] **Step 6: Verify**

  Run: cd ~/.pi/agent && bun test extensions/sdd-orchestrator/config.test.ts extensions/sdd-orchestrator/manifest.test.ts

  Expected: PASS with no network or package install.

### Task 4: Durable State Machine and Storage

```sdd-task
{"id":"task-4","dependsOn":["task-3"],"files":["agent/extensions/sdd-orchestrator/state-machine.ts","agent/extensions/sdd-orchestrator/state-machine.test.ts","agent/extensions/sdd-orchestrator/store.ts","agent/extensions/sdd-orchestrator/store.test.ts"],"verify":[{"id":"task-4-tests","command":"cd ~/.pi/agent && bun test extensions/sdd-orchestrator/state-machine.test.ts extensions/sdd-orchestrator/store.test.ts"}]}
```

**Files:**

- Create: agent/extensions/sdd-orchestrator/state-machine.ts
- Create: agent/extensions/sdd-orchestrator/state-machine.test.ts
- Create: agent/extensions/sdd-orchestrator/store.ts
- Create: agent/extensions/sdd-orchestrator/store.test.ts

**Interfaces:**

- Produces: transition(snapshot: RunSnapshot, event: RunEvent): RunSnapshot
- Produces: SddStore.create(snapshot: RunSnapshot), load(runId: string), save(snapshot: RunSnapshot), appendTransition(record: TransitionRecord), list(): RunSnapshot[]
- Consumed by: workflow.ts and index.ts

- [ ] **Step 1: RED for legal and illegal transitions**

  Test pending to implementing, pending to awaiting_direct_agent, implementing to reviewing, reviewing to fixing, fixing to reviewing, reviewing to verified, and terminal states. Assert that pending to verified and failed to running throw exact illegal-transition errors.

- [ ] **Step 2: GREEN with a table-driven pure reducer**

  Use these state sets:

  export type RunState = "draft" | "assessed" | "awaiting_approval" | "approved" | "running" | "needs_input" | "failed" | "cancelled" | "completed";
  export type TaskState = "pending" | "awaiting_direct_agent" | "implementing" | "reviewing" | "fixing" | "verified" | "needs_input" | "failed" | "cancelled";

  The reducer must increment revision, append no filesystem data itself, reject stale expectedRevision, and keep consumed idempotency keys.

- [ ] **Step 3: RED for duplicate launch idempotency**

  Given the same delegation-planned event with the same key task-1:worker:0 twice, assert that the second transition returns the existing planned request without incrementing launch count.

- [ ] **Step 4: GREEN for idempotency and launch ceilings**

  Refuse a new delegation-planned event when task launches equal the approved maxLaunches. Store requestId, stage, attempt, and plannedAt before the caller emits an external event.

- [ ] **Step 5: RED then GREEN for atomic storage**

  SddStore uses getAgentDir()/.sdd/runs/runId/snapshot.json and transitions.jsonl. Save by writing snapshot.json.tmp and renaming it. Append one JSON object per line with revision, event, timestamp, and snapshotDigest.

  Tests inject a temporary base directory and verify:

  - load after save returns exact data;
  - two sequential saves leave no temp file;
  - malformed JSON fails visibly;
  - transition lines are append-only;
  - list ignores the legacy queue and progress directories.

- [ ] **Step 6: Verify**

  Run: cd ~/.pi/agent && bun test extensions/sdd-orchestrator/state-machine.test.ts extensions/sdd-orchestrator/store.test.ts

  Expected: PASS.

### Task 5: Public pi-subagents Delegation Client

```sdd-task
{"id":"task-5","dependsOn":["task-4"],"files":["agent/extensions/sdd-orchestrator/delegation-client.ts","agent/extensions/sdd-orchestrator/delegation-client.test.ts"],"verify":[{"id":"task-5-tests","command":"cd ~/.pi/agent && bun test extensions/sdd-orchestrator/delegation-client.test.ts"},{"id":"task-5-types","command":"cd ~/.pi/agent && bun run typecheck"}]}
```

**Files:**

- Create: agent/extensions/sdd-orchestrator/delegation-client.ts
- Create: agent/extensions/sdd-orchestrator/delegation-client.test.ts

**Interfaces:**

- Consumes: ExtensionAPI events and public types from pi-subagents/delegation
- Produces: DelegationClient.run(request, options): Promise<SubagentDelegationResponse>
- Produces: DelegationClient.cancel(requestId): void and dispose(): void

- [ ] **Step 1: RED for request and correlated response**

  Build a FakeEventBus with on and emit. Call client.run with requestId req-1, capture the emitted prompt-template:subagent:request payload, emit a response for req-2 and assert the promise remains pending, then emit req-1 and assert completion.

  Run: cd ~/.pi/agent && bun test extensions/sdd-orchestrator/delegation-client.test.ts

  Expected: FAIL because the client is missing.

- [ ] **Step 2: GREEN using only the public package export**

  The production imports must be exactly:

  import {
  SUBAGENT_DELEGATION_CANCEL_EVENT,
  SUBAGENT_DELEGATION_REQUEST_EVENT,
  SUBAGENT_DELEGATION_RESPONSE_EVENT,
  SUBAGENT_DELEGATION_STARTED_EVENT,
  SUBAGENT_DELEGATION_UPDATE_EVENT,
  type SubagentDelegationRequest,
  type SubagentDelegationResponse,
  type SubagentDelegationUpdate,
  } from "pi-subagents/delegation";

  Register listeners once in the constructor. Maintain a Map keyed by requestId. run rejects duplicate active IDs, emits the request, and resolves only one matching terminal response. Unknown and late responses are ignored.

- [ ] **Step 3: RED then GREEN for cancellation**

  Passing an aborted signal or calling cancel must emit:

  { version: 1, requestId: "req-1" }

  on prompt-template:subagent:cancel and must settle only when the terminal cancelled or interrupted response arrives, except for a local hard client deadline.

- [ ] **Step 4: RED then GREEN for deadline and disposal**

  A client deadline emits cancel, rejects with DelegationDeadlineError, removes the pending entry, and ignores the later response. dispose unregisters listeners and rejects every pending request with DelegationDisposedError.

- [ ] **Step 5: Add a source-boundary guard**

  Add a test that reads delegation-client.ts and asserts it contains pi-subagents/delegation and does not contain /src/, subagents:rpc, child_process, or a subagent tool invocation.

- [ ] **Step 6: Verify package resolution and focused tests**

  Run: cd ~/.pi/agent && bun test extensions/sdd-orchestrator/delegation-client.test.ts

  Run: cd ~/.pi/agent && bun run typecheck

  Expected: tests pass and TypeScript resolves the public subpath through agent/node_modules/pi-subagents.

### Task 6: Agent Contracts, Prompts, and Structured Output

```sdd-task
{"id":"task-6","dependsOn":["task-1","task-5"],"files":["agent/extensions/sdd-orchestrator/prompts.ts","agent/extensions/sdd-orchestrator/prompts.test.ts","agent/agents/orchestration-assessor.md","agent/agents/sdd-combined-reviewer.md","agent/agents/sdd-spec-reviewer.md","agent/agents/sdd-quality-reviewer.md"],"verify":[{"id":"task-6-tests","command":"cd ~/.pi/agent && bun test extensions/sdd-orchestrator/prompts.test.ts"},{"id":"task-6-parse","command":"cd ~/.pi/agent && bun run check:parse"}]}
```

**Files:**

- Create: agent/extensions/sdd-orchestrator/prompts.ts
- Create: agent/extensions/sdd-orchestrator/prompts.test.ts
- Create: agent/agents/orchestration-assessor.md
- Create: agent/agents/sdd-combined-reviewer.md
- Create: agent/agents/sdd-spec-reviewer.md
- Create: agent/agents/sdd-quality-reviewer.md

**Interfaces:**

- Produces: buildAssessmentRequest(), buildWorkerRequest(), buildCorrectionRequest(), buildReviewRequest()
- Produces: parseAssessmentResponse() and parseReviewResponse()

- [ ] **Step 1: RED for worker request safety**

  Test that buildWorkerRequest includes the exact task ID, approved body, allowed file list, acceptance commands, RED-GREEN-REFACTOR requirement, no hard turnBudget, no toolBudget, context fresh, 45-minute timeout, artifacts true, and acceptance level verified.

- [ ] **Step 2: GREEN with typed request builders**

  buildWorkerRequest returns a SubagentDelegationRequest using the configured worker and optional configured model. acceptance contains the task criteria, changed-files, tests-added, commands-run, validation-output, residual-risks, and every approved verify command.

  buildCorrectionRequest must include:

  - the unchanged approved task contract;
  - prior response output or outputPath;
  - prior sessionFile as evidence only, never as resumable input;
  - exact schema-validated findings;
  - changed files and command results already reported;
  - the remaining correction count;
  - an instruction to inspect the current working tree before editing.

- [ ] **Step 3: RED then GREEN for assessor and reviewer parsing**

  parseAssessmentResponse validates AssessmentSchema and rejects missing task results, duplicates, unknown signals, or prose around JSON.

  ReviewSchema version 1 must contain:

  {
  taskId: string,
  stage: "combined" | "spec" | "quality" | "integration",
  verdict: "pass" | "changes_required" | "blocked",
  findings: [{ id: string, severity: "critical" | "important" | "minor", file: string, line?: number, message: string }],
  evidence: string[],
  }

  parseReviewResponse validates exact taskId and stage in addition to the TypeBox schema.

- [ ] **Step 4: Add the read-only assessor agent**

  Frontmatter:

  ***

  name: orchestration-assessor
  description: Read-only SDD complexity and risk signal assessor
  tools: read, grep, find, ls
  thinking: high
  systemPromptMode: replace
  inheritProjectContext: true
  inheritSkills: false
  defaultContext: fresh
  acceptanceRole: read-only
  completionGuard: false

  ***

  Its body must state that it returns only version-1 JSON, may cite verified plan or code evidence, never chooses dependencies or parallelism, never edits, and treats advisoryMinimum as non-authoritative.

- [ ] **Step 5: Add three read-only reviewer roles**

  combined checks specification plus quality. spec checks only requested behavior and acceptance. quality checks correctness, maintainability, tests, and repository conventions. Their frontmatter uses read, grep, find, ls, safe_bash; acceptanceRole read-only; completionGuard false; fresh context. Their bodies prohibit edits, restrict safe_bash to inspection and approved test commands, and require only ReviewSchema JSON.

- [ ] **Step 6: Add one schema-repair retry test**

  The retry prompt includes the validation error and original output, asks only for corrected JSON, and keeps the same logical job ID. An assessor retry cannot exceed configured structuredOutputRetries. A reviewer retry also requires remaining reviewerAttempts and maxLaunches capacity and consumes both.

- [ ] **Step 7: Verify**

  Run: cd ~/.pi/agent && bun test extensions/sdd-orchestrator/prompts.test.ts

  Run: cd ~/.pi/agent && bun run check:parse

  Expected: prompt tests pass and all new agent Markdown remains data, not auto-loaded TypeScript.

### Task 7: Profile Workflow Engine and Safe Recovery

```sdd-task
{"id":"task-7","dependsOn":["task-2","task-3","task-4","task-5","task-6"],"files":["agent/extensions/sdd-orchestrator/workflow.ts","agent/extensions/sdd-orchestrator/workflow.test.ts"],"verify":[{"id":"task-7-tests","command":"cd ~/.pi/agent && bun test extensions/sdd-orchestrator/workflow.test.ts"}]}
```

**Files:**

- Create: agent/extensions/sdd-orchestrator/workflow.ts
- Create: agent/extensions/sdd-orchestrator/workflow.test.ts

**Interfaces:**

- Consumes: ApprovedManifest, SddStore, DelegationClient, request builders, state reducer
- Produces: SddWorkflow.run(runId: string, ctx: ExtensionContext), cancel(runId: string), reconcile(runId: string)

- [ ] **Step 1: RED then GREEN for Light**

  With an in-memory store and fake delegation client, assert Light performs exactly one worker request, persists implementing before emission, persists the terminal response, and transitions directly to verified only when response status is completed and acceptance status is verified or accepted.

- [ ] **Step 2: RED then GREEN for Standard pass**

  Assert the exact sequence worker then combined reviewer. A pass produces verified with two launches.

- [ ] **Step 3: RED then GREEN for Standard correction**

  Assert worker, combined review changes_required, fresh correction worker, combined re-review pass. Verify four unique request IDs, context fresh for both workers, and correction prompt contains prior output and exact findings. A second rejection after the correction moves the task to failed with budget_exhausted and never launches a fifth child.

- [ ] **Step 4: RED then GREEN for Critical shared correction budget**

  Cover these sequences independently:

  - worker, spec pass, quality pass gives three launches;
  - spec reject, correction, spec pass, quality pass gives five launches;
  - spec reject twice with two corrections, spec pass, quality reject gives failed with seven launches and no third correction;
  - quality reject after spec pass consumes from the same two-correction total.

- [ ] **Step 5: RED then GREEN for Direct handshake**

  Direct transitions pending to awaiting_direct_agent and emits no delegation. completeDirect accepts only evidence with changedFiles, tests, commands, validationOutput, and residualRisks, verifies the source digest is still current, then transitions to verified. Missing evidence or stale digest leaves the task awaiting_direct_agent.

- [ ] **Step 6: RED then GREEN for deterministic parallel batches**

  selectRunnableBatch returns only dependency-satisfied, parallelEligible tasks with disjoint approved file scopes, capped by maxConcurrentWriters. Any Direct task, overlapping file, shared contract, or unmet dependency forces sequential execution.

- [ ] **Step 7: RED then GREEN for restart reconciliation**

  A persisted delegation-planned transition without a terminal response becomes needs_input with reason uncertain_foreground_delegation. reconcile must not call DelegationClient.run. A persisted terminal response advances from the next legal transition.

- [ ] **Step 8: RED then GREEN for cancellation**

  Persist cancelling before DelegationClient.cancel. A terminal cancelled response marks only the active task and run cancelled. Repeated cancel calls are idempotent.

- [ ] **Step 9: Verify profile ceilings**

  Run: cd ~/.pi/agent && bun test extensions/sdd-orchestrator/workflow.test.ts

  Expected: assertions prove 0, 1, 4, and 7 maximum task launches for Direct, Light, Standard, and Critical.

### Task 8: Manifest Review UI and Extension Tools

```sdd-task
{"id":"task-8","dependsOn":["task-3","task-4","task-5","task-6","task-7"],"files":["agent/extensions/sdd-orchestrator/review-ui.ts","agent/extensions/sdd-orchestrator/review-ui.test.ts","agent/extensions/sdd-orchestrator/index.ts","agent/extensions/sdd-orchestrator/sdd-orchestrator.test.ts","agent/extensions/sdd-orchestrator/package.json"],"verify":[{"id":"task-8-tests","command":"cd ~/.pi/agent && bun test extensions/sdd-orchestrator"}]}
```

**Files:**

- Create: agent/extensions/sdd-orchestrator/review-ui.ts
- Create: agent/extensions/sdd-orchestrator/review-ui.test.ts
- Rewrite: agent/extensions/sdd-orchestrator/index.ts
- Modify: agent/extensions/sdd-orchestrator/sdd-orchestrator.test.ts
- Modify: agent/extensions/sdd-orchestrator/package.json

**Interfaces:**

- Produces tools: sdd_prepare, sdd_submit legacy alias, sdd_approve, sdd_status, sdd_result, sdd_cancel, sdd_direct_complete
- Produces command: /sdd-review manifestId
- Persists custom entry: sdd:manifest-approved

- [ ] **Step 1: RED then GREEN for the pure review controller**

  createReviewController(draft) exposes current decision, setGlobalProfile, setTaskOverride, setParallelism, confirmCriticalDowngrade, setCriticalJustification, validate, and approve. Test profile changes recalculate launch preview, an unconfirmed Critical-to-Light or Critical-to-Direct downgrade blocks approval, and cancel returns null without mutating the draft.

- [ ] **Step 2: Add the single interactive overlay**

  openManifestReview(ctx, draft) uses ctx.ui.custom once. It displays plan title and digest, global profile selector, per-task recommendation and override, rule reasons, dependency and parallel status, maximum launch count, Critical warnings, justification input, Approve, Return to planning, and Cancel.

  Keep all business decisions in createReviewController so the component only renders state and forwards input. Test the controller directly and keep one dynamic-import smoke test for review-ui.ts because MockUI cannot drive ctx.ui.custom.

- [ ] **Step 3: RED then GREEN for sdd_prepare**

  sdd_prepare accepts planPath and globalProfile. It reads and strictly parses the plan, runs one assessor job through DelegationClient, applies at most one JSON repair retry, compiles and stores the draft, and either opens the overlay when interactive or returns the complete manifest preview plus instructions for sdd_approve.

  It must throw tool errors rather than returning an ignored isError field.

- [ ] **Step 4: RED then GREEN for structured approval**

  sdd_approve accepts manifestId, globalProfile, taskOverrides, parallelismEnabled, Critical downgrade confirmations and justifications, and approvedBy. It calls applyApproval, appends sdd:manifest-approved, stores approved before starting workflow, and returns the run ID plus Direct handoff instructions when applicable.

  It must not append plannotator:plan-approved.

- [ ] **Step 5: RED then GREEN for status, result, cancel, and Direct completion**

  Preserve the public names sdd_status and sdd_result but render the new snapshot. Add exact schemas for cancellation and Direct evidence. Every result details object contains the durable snapshot needed for session reconstruction.

- [ ] **Step 6: Preserve sdd_submit as a bounded compatibility alias**

  sdd_submit accepts the old planPath and delegates to the same prepare handler with globalProfile standard. Its output starts with a deprecation warning and never writes a new file under agent/.sdd/queue.

- [ ] **Step 7: Thin index import test**

  Mock Pi and TypeBox, dynamically import the real index.ts, register it against a fake ExtensionAPI, and assert the seven tools and one command are registered. Assert index.ts contains no classification rules, filesystem store implementation, or workflow loops.

- [ ] **Step 8: Update package metadata**

  Set version 2.0.0 and describe the deterministic manifest and public delegation architecture. Keep the Pi extension entry at index.ts and add no dependency.

- [ ] **Step 9: Verify**

  Run: cd ~/.pi/agent && bun test extensions/sdd-orchestrator

  Expected: all extension tests pass.

### Task 9: Planning Roles and Legacy Migration Guard

```sdd-task
{"id":"task-9","dependsOn":["task-8"],"files":["agent/roles/plan.md","agent/roles/quick-planner.md","agent/agents/sdd-orchestrator.md","agent/extensions/sdd-orchestrator/migration.test.ts"],"verify":[{"id":"task-9-tests","command":"cd ~/.pi/agent && bun test extensions/sdd-orchestrator/migration.test.ts"}]}
```

**Files:**

- Modify: agent/roles/plan.md
- Modify: agent/roles/quick-planner.md
- Modify: agent/agents/sdd-orchestrator.md
- Create: agent/extensions/sdd-orchestrator/migration.test.ts

**Interfaces:**

- Plan role produces exact sdd-task metadata and calls sdd_prepare only for the important SDD path.
- Quick planner remains opt-in.
- Legacy polling agent remains available only for explicit user-directed recovery.

- [ ] **Step 1: RED for role contract text**

  Add a test that reads plan.md and asserts:

  - writing-plans is named correctly;
  - important SDD plans require exact Task headings and sdd-task JSON;
  - plan-reviewer runs before sdd_prepare;
  - orchestration-assessor is not launched manually;
  - ordinary plan_submit is not used for the SDD manifest approval;
  - one manifest approval is the handoff.

  Add a quick-planner assertion that it never invokes assessment automatically.

- [ ] **Step 2: GREEN by updating plan.md**

  Add sdd_prepare, sdd_approve, sdd_status, and sdd_direct_complete to the tool list. Split the workflow explicitly:

  - important SDD path: discovery, ambiguity resolution, writing-plans format, plan-reviewer, sdd_prepare, one manifest review and approval;
  - ordinary non-SDD path: existing plan_submit flow;
  - quick path: quick-planner with no automatic assessment.

  Permit code blocks only for sdd-task metadata in the role's otherwise prose-oriented plan template.

- [ ] **Step 3: GREEN by updating quick-planner.md**

  State that quick-planner may recommend handing a saved plan to sdd_prepare but does not call plan-reviewer, assessor, or manifest compilation automatically.

- [ ] **Step 4: Mark the old agent legacy-only**

  Change its description and first paragraph so it never starts automatically and may touch the old queue only after explicit user authorization for a named legacy run. Do not remove its tools or delete the file while the queued run exists.

- [ ] **Step 5: Add a byte-preservation migration test**

  Compute SHA-256 of the existing queue and progress files before and after importing and exercising the new extension against a temporary store. Assert both hashes are unchanged and the status renderer lists the old run as legacy_queued with its original plan path.

- [ ] **Step 6: Verify**

  Run: cd ~/.pi/agent && bun test extensions/sdd-orchestrator/migration.test.ts

  Run: sha256sum ~/.pi/agent/.sdd/queue/sdd-mqxpovpu-8m9fgo.json ~/.pi/agent/.sdd/progress/sdd-mqxpovpu-8m9fgo.json

  Expected: test passes and hashes remain stable across the implementation.

### Task 10: Integrated TDD Scenarios and Release Gates

```sdd-task
{"id":"task-10","dependsOn":["task-8","task-9"],"files":["agent/extensions/sdd-orchestrator/sdd-orchestrator.integration.test.ts","docs/plans/2026-07-21-modular-deterministic-sdd-design.md"],"verify":[{"id":"focused-tests","command":"cd ~/.pi/agent && bun test extensions/sdd-orchestrator"},{"id":"full-tests","command":"cd ~/.pi/agent && bun test --isolate"},{"id":"typecheck","command":"cd ~/.pi/agent && bun run typecheck"},{"id":"lint","command":"cd ~/.pi/agent && bun run lint"},{"id":"format","command":"cd ~/.pi/agent && bun run fmt:check"},{"id":"parse","command":"cd ~/.pi/agent && bun run check:parse"}]}
```

**Files:**

- Create: agent/extensions/sdd-orchestrator/sdd-orchestrator.integration.test.ts
- Modify: docs/plans/2026-07-21-modular-deterministic-sdd-design.md only if implementation evidence reveals a verified contract difference

**Interfaces:**

- Exercises the registered public tools through a fake Pi event bus and real domain modules.
- Uses no real model call in the automated suite.

- [ ] **Step 1: Add integrated profile scenarios one at a time**

  For each profile, first add the failing scenario, run it, then add only the missing orchestration behavior:

  - Direct waits for explicit evidence and launches zero children.
  - Light launches one worker.
  - Standard reaches four launches on one correction and stops there.
  - Critical shares two corrections across both review stages and stops at seven.

- [ ] **Step 2: Add mixed dependency and parallelism scenario**

  A three-task manifest with two disjoint roots and one dependent task must launch the two roots concurrently only when parallelism is approved, then launch the dependent task after both are verified.

- [ ] **Step 3: Add stale plan and Critical downgrade scenarios**

  Changing the plan after draft creation blocks approval. Lowering a Critical task to Standard records the override without the extra downgrade gate. Lowering it to Light or Direct succeeds only with explicit confirmation and persisted justification; otherwise it is rejected.

- [ ] **Step 4: Add malformed and unavailable delegation scenarios**

  Cover invalid assessor JSON with one repair retry, invalid reviewer JSON with one repair retry charged to the profile ceiling, unavailable_context, timed_out, acceptance_failed, duplicate terminal response, and late response after cancellation.

- [ ] **Step 5: Add restart scenarios**

  Restart during worker and restart during reviewer both become needs_input without calling run again. Restart after a persisted terminal response continues once from the next transition.

- [ ] **Step 6: Reproduce the former slow topology as a deterministic assertion**

  Feed an eight-task fixture equivalent in shape to the legacy plan and assert the manifest's exact maximum launch count before execution. Assert no profile can exceed its per-task correction ceiling and no mechanical polling agent is launched.

- [ ] **Step 7: Run mandatory verification gates**

  Run: cd ~/.pi/agent && bun test extensions/sdd-orchestrator

  Expected: all focused tests pass.

  Run: cd ~/.pi/agent && bun test --isolate

  Expected: full agent suite passes.

  Run: cd ~/.pi/agent && bun run typecheck

  Expected: zero TypeScript errors.

  Run: cd ~/.pi/agent && bun run lint

  Expected: exit 0; package-boundary warnings are handled according to AGENTS.md and not hidden with unsafe casts.

  Run: cd ~/.pi/agent && bun run fmt:check

  Expected: exit 0.

  Run: cd ~/.pi/agent && bun run check:parse

  Expected: exit 0.

  Run: cd ~/.pi && git diff --check

  Expected: no whitespace errors.

- [ ] **Step 8: Inspect unwanted artifacts**

  Run: cd ~/.pi && git status --short

  Expected: no build directory, wrong lockfile, temporary snapshot, generated queue item, or modified legacy queue artifact. Existing unrelated user changes remain untouched.

- [ ] **Step 9: Perform a user-authorized live smoke test after reload**

  This step changes live Pi session state, so execute it only with explicit user authorization. Prepare a two-task fixture, choose Standard globally, approve one Light override, verify the manifest entry, observe foreground delegation in the Pi UI, and cancel before any mutation-capable worker if the test is intended to remain read-only.

  Expected: no background polling agent, one typed manifest approval, correlated lifecycle updates, and deterministic launch preview matching the stored manifest.

### Task 11: Post-Implementation Review Remediation

```sdd-task
{"id":"task-11","dependsOn":["task-10"],"files":["agent/extensions/sdd-orchestrator/plan-parser.ts","agent/extensions/sdd-orchestrator/plan-parser.test.ts","agent/extensions/sdd-orchestrator/workflow.ts","agent/extensions/sdd-orchestrator/workflow.test.ts","agent/extensions/sdd-orchestrator/review-ui.ts","agent/extensions/sdd-orchestrator/review-ui.test.ts","agent/extensions/sdd-orchestrator/extension-tools.ts","agent/extensions/sdd-orchestrator/sdd-orchestrator.test.ts","agent/extensions/sdd-orchestrator/pi-runtime.integration.test.ts","docs/plans/2026-07-21-modular-deterministic-sdd-design.md"],"verify":[{"id":"focused-tests","command":"cd ~/.pi/agent && bun test extensions/sdd-orchestrator"},{"id":"full-tests","command":"cd ~/.pi/agent && bun test --isolate"},{"id":"typecheck","command":"cd ~/.pi/agent && bun run typecheck"},{"id":"lint","command":"cd ~/.pi/agent && bun run lint"},{"id":"format","command":"cd ~/.pi/agent && bun run fmt:check"},{"id":"parse","command":"cd ~/.pi/agent && bun run check:parse"}]}
```

**Completed corrections:**

- [x] Canonicalize and deduplicate lexical task-file aliases; reject absolute and project-escaping paths.
- [x] Make each run single-flight inside the extension runtime so concurrent callers join one execution.
- [x] Preserve per-task recommendations when the review surface is approved untouched.
- [x] Expose the optional final integration review in both the native overlay and `sdd_approve`.
- [x] Propagate Pi cancellation signals through assessment and execution, persisting cancellation before external cancel events.
- [x] Make crash reconciliation idempotent for tasks already in terminal states.
- [x] Return complete structured observations from `sdd_status` and `sdd_result`.
- [x] Exercise a real registered SDD tool through `@marcfargas/pi-test-harness`.
- [x] Re-run all repository release gates and record any pre-existing out-of-scope failures in the implementation handoff.

### Task 12: Separate Planning Roles

```sdd-task
{"id":"task-12","dependsOn":["task-11"],"files":["agent/roles/planning-base.md","agent/roles/plan.md","agent/roles/sdd-plan.md","agent/roles/quick-planner.md","agent/extensions/sdd-orchestrator/migration.test.ts","docs/plans/2026-07-21-modular-deterministic-sdd-design.md"],"verify":[{"id":"migration-tests","command":"cd ~/.pi/agent && bun test extensions/sdd-orchestrator/migration.test.ts"},{"id":"focused-tests","command":"cd ~/.pi/agent && bun test extensions/sdd-orchestrator"},{"id":"parse","command":"cd ~/.pi/agent && bun run check:parse"}]}
```

**Completed separation:**

- [x] Add a workflow-neutral, selectable `planning-base` role with the shared evidence-first preplanning method.
- [x] Restore `plan` to a Plannotator-only durable-file workflow and remove execution-method routing.
- [x] Move the compiler, assessor, manifest, approval, observation, recovery, and manual Direct handoff contract into `sdd-plan`.
- [x] Remove SDD and Plannotator routing from `quick-planner` while inheriting the shared planning method.
- [x] Cover the four role boundaries and exact tool sets in migration tests.

## Self-Review Record

- Spec coverage: all accepted profiles, deterministic assessment, one approval, public 0.35.1 delegation, fresh corrections, Direct handshake, bounded launches, persistence, recovery, parallelism, observability, role separation, and legacy preservation map to Tasks 1 through 12.
- Placeholder scan: every action has concrete files, interfaces, commands, expected results, and bounded failure behavior; the only three-dot tokens are valid TypeScript spread operators in complete snippets.
- Type consistency: Profile, ParsedPlan, Assessment, DraftManifest, ApprovedManifest, RunSnapshot, ManifestDecision, DelegationClient, SddStore, and SddWorkflow are introduced before their consumers.
- Scope: no pi-subagents fork, no pi-subagents-addons UI work, no Plannotator fork, no package install, and no model catalog change.
