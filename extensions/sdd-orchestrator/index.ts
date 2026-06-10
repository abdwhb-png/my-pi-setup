/**
 * sdd-orchestrator — Programmatic SDD plan executor
 *
 * Registers three tools:
 * - sdd_submit: reads a plan markdown file, extracts tasks, queues for execution
 * - sdd_status: checks progress of a run
 * - sdd_result: retrieves final result of a run
 *
 * Protocol: Tools write to .sdd/queue/. The background orchestrator subagent
 * (sdd-orchestrator agent) polls .sdd/queue/ and executes plans via subagent
 * dispatching with fresh context and review loops.
 *
 * This keeps the cheap parent LLM completely out of orchestration — it only
 * submits plans and reads results. The orchestrator handles all subagent
 * dispatching programmatically.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// ── Constants ──

const SDD_DIR = resolve(process.env.HOME || "/home/abdwhb", ".pi", "agent", ".sdd");
const QUEUE_DIR = resolve(SDD_DIR, "queue");
const PROGRESS_DIR = resolve(SDD_DIR, "progress");
const RESULTS_DIR = resolve(SDD_DIR, "results");

// ── Helpers ──

function ensureDirs(): void {
  mkdirSync(QUEUE_DIR, { recursive: true });
  mkdirSync(PROGRESS_DIR, { recursive: true });
  mkdirSync(RESULTS_DIR, { recursive: true });
}

function generateRunId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `sdd-${ts}-${rand}`;
}

// ── Plan Parsing ──

interface ParsedTask {
  id: number;
  title: string;
  description: string;
}

export interface ParsedPlan {
  title: string;
  tasks: ParsedTask[];
}

export function parsePlan(content: string): ParsedPlan {
  const tasks: ParsedTask[] = [];
  let planTitle = "Untitled Plan";

  // Extract the main title (first # heading)
  const titleMatch = content.match(/^# (.+)$/m);
  if (titleMatch) {
    planTitle = titleMatch[1].trim();
  }

  // Find all task headings: ## Task N: Title, ### Task N: Title, etc.
  const taskRegex = /^#{2,4}\s*(?:Task\s*)?(\d+)[:.]?\s*(.+)$/gm;
  const taskMatches = [...content.matchAll(taskRegex)];

  for (let i = 0; i < taskMatches.length; i++) {
    const match = taskMatches[i];
    const taskId = parseInt(match[1], 10);
    const taskTitle = match[2].trim();

    // Extract description: everything from after heading to next heading (any level)
    const startPos = match.index! + match[0].length;
    const nextMatch = taskMatches[i + 1];
    const endPos = nextMatch ? nextMatch.index! : content.length;

    let description = content.slice(startPos, endPos).trim();

    // Remove leading list markers and clean up
    description = description
      .replace(/^[-*]\s+/gm, "") // Remove bullet markers
      .replace(/^\d+\.\s+/gm, "") // Remove numbered list markers
      .replace(/\n{3,}/g, "\n\n") // Normalize spacing
      .trim();

    tasks.push({
      id: taskId,
      title: taskTitle,
      description,
    });
  }

  // If no task headings found, treat the whole plan as one task
  if (tasks.length === 0) {
    // Get content after title
    const titleEnd = titleMatch ? titleMatch.index! + titleMatch[0].length : 0;
    const body = content.slice(titleEnd).trim();
    tasks.push({
      id: 1,
      title: planTitle,
      description: body || "See plan file for details.",
    });
  }

  return { title: planTitle, tasks };
}

// ── Queue Entry ──

interface QueueEntry {
  runId: string;
  planPath: string;
  planTitle: string;
  tasks: ParsedTask[];
  queuedAt: string;
}

// ── Progress ──

interface TaskStatus {
  id: number;
  title: string;
  status: "pending" | "in_progress" | "done" | "failed";
  specReview: "pending" | "pass" | "fail";
  codeReview: "pending" | "pass" | "fail";
}

interface RunProgress {
  runId: string;
  planTitle: string;
  status: "queued" | "running" | "needs_input" | "done" | "failed";
  currentTask: number;
  totalTasks: number;
  taskStatuses: TaskStatus[];
  needsInput: boolean;
  inputMessage: string;
  lastUpdated: string;
}

interface RunResult {
  runId: string;
  planTitle: string;
  status: "done" | "failed" | "needs_input";
  allPassed: boolean;
  tasks: {
    id: number;
    title: string;
    status: string;
    specPassed: boolean;
    codeReviewPassed: boolean;
    files: string[];
    notes: string;
  }[];
  summary: string;
  completedAt: string;
}

// ── Extension Entry Point ──

export default function (pi: ExtensionAPI) {
  // ── sdd_submit ──

  pi.registerTool({
    name: "sdd_submit",
    label: "Submit Plan for SDD",
    description:
      "Submit a plan markdown file for programmatic execution via the SDD orchestrator. " +
      "The orchestrator will dispatch subagents per task with spec review and code quality review loops. " +
      "Returns a runId you can use with sdd_status and sdd_result.",
    parameters: Type.Object({
      planPath: Type.String({
        description: "Path to the plan markdown file, relative to the working directory.",
      }),
    }),

    async execute(
      _toolCallId: string,
      params: unknown,
      _signal: AbortSignal | undefined,
      _onUpdate: ((data: unknown) => void) | undefined,
      ctx: ExtensionContext,
    ) {
      const inputPath = (params as { planPath?: string })?.planPath?.trim();
      if (!inputPath) {
        return {
          content: [{ type: "text", text: "Error: sdd_submit requires a planPath argument." }],
        };
      }

      // Read plan file
      let planContent: string;
      try {
        const resolved = resolve(ctx.cwd, inputPath);
        planContent = readFileSync(resolved, "utf-8");
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error reading plan file: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }

      // Parse tasks
      const parsed = parsePlan(planContent);
      if (parsed.tasks.length === 0) {
        return {
          content: [{ type: "text", text: "Error: Could not find any tasks in the plan file. Ensure tasks are marked with '## Task N: Title' headings." }],
        };
      }

      // Create queue entry
      const runId = generateRunId();
      const entry: QueueEntry = {
        runId,
        planPath: resolve(ctx.cwd, inputPath),
        planTitle: parsed.title,
        tasks: parsed.tasks,
        queuedAt: new Date().toISOString(),
      };

      try {
        ensureDirs();
        writeFileSync(resolve(QUEUE_DIR, `${runId}.json`), JSON.stringify(entry, null, 2));
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error creating queue entry: ${err instanceof Error ? err.message : String(err)}. Ensure the SDD orchestrator subagent is running (start it with: subagent with agent="sdd-orchestrator" async=true).`,
            },
          ],
        };
      }

      // Create initial progress
      const progress: RunProgress = {
        runId,
        planTitle: parsed.title,
        status: "queued",
        currentTask: 0,
        totalTasks: parsed.tasks.length,
        taskStatuses: parsed.tasks.map((t) => ({
          id: t.id,
          title: t.title,
          status: "pending" as const,
          specReview: "pending" as const,
          codeReview: "pending" as const,
        })),
        needsInput: false,
        inputMessage: "",
        lastUpdated: new Date().toISOString(),
      };
      writeFileSync(resolve(PROGRESS_DIR, `${runId}.json`), JSON.stringify(progress, null, 2));

      return {
        content: [
          {
            type: "text",
            text: [
              `## Plan Queued ✓`,
              ``,
              `**Run ID:** \`${runId}\``,
              `**Plan:** ${parsed.title}`,
              `**Tasks:** ${parsed.tasks.length}`,
              ``,
              `| # | Task |`,
              `|---|------|`,
              ...parsed.tasks.map((t) => `| ${t.id} | ${t.title} |`),
              ``,
              `The orchestrator will pick this up shortly. Check progress with \`sdd_status({ runId: "${runId}" })\`.`,
              ``,
              `⚠️ If the orchestrator is not running, start it with: \`subagent({ agent: "sdd-orchestrator", async: true })\``,
            ].join("\n"),
          },
        ],
        details: { runId, tasks: parsed.tasks.length },
      };
    },
  });

  // ── sdd_status ──

  pi.registerTool({
    name: "sdd_status",
    label: "Check SDD Run Status",
    description:
      "Check the progress of a plan execution run. Returns the current task, phase, and any issues.",
    parameters: Type.Object({
      runId: Type.Optional(
        Type.String({
          description: "The runId returned by sdd_submit. If omitted, returns the most recent active run.",
        })
      ),
    }),

    async execute(
      _toolCallId: string,
      params: unknown,
      _signal: AbortSignal | undefined,
      _onUpdate: ((data: unknown) => void) | undefined,
      _ctx: ExtensionContext,
    ) {
      const runId = (params as { runId?: string })?.runId?.trim();

      try {
        ensureDirs();

        if (runId) {
          // Specific run
          const filePath = resolve(PROGRESS_DIR, `${runId}.json`);
          if (!existsSync(filePath)) {
            return {
              content: [{ type: "text", text: `Run \`${runId}\` not found. It may not exist or may have already completed.` }],
            };
          }
          const progress = JSON.parse(readFileSync(filePath, "utf-8")) as RunProgress;
          const taskTable = progress.taskStatuses
            .map((t) => `| ${t.id} | ${t.title} | ${t.status} | ${t.specReview} | ${t.codeReview} |`)
            .join("\n");

          return {
            content: [
              {
                type: "text",
                text: [
                  `## Run \`${runId}\``,
                  `**Status:** ${progress.status} | **Task:** ${progress.currentTask}/${progress.totalTasks}`,
                  ``,
                  `| # | Task | Status | Spec | Code |`,
                  `|---|------|--------|------|------|`,
                  taskTable,
                  progress.needsInput ? `\n⚠️ **Needs input:** ${progress.inputMessage}` : "",
                ].join("\n"),
              },
            ],
            details: progress,
          };
        }

        // No runId — list active runs
        const progressFiles = existsSync(PROGRESS_DIR)
          ? readdirSync(PROGRESS_DIR).filter((f) => f.endsWith(".json"))
          : [];

        if (progressFiles.length === 0) {
          return {
            content: [{ type: "text", text: "No active SDD runs. Submit a plan with `sdd_submit` to create one." }],
          };
        }

        const activeRuns: RunProgress[] = [];
        for (const file of progressFiles) {
          const progress = JSON.parse(readFileSync(resolve(PROGRESS_DIR, file), "utf-8")) as RunProgress;
          if (progress.status === "queued" || progress.status === "running" || progress.status === "needs_input") {
            activeRuns.push(progress);
          }
        }

        if (activeRuns.length === 0) {
          return {
            content: [{ type: "text", text: "No active SDD runs. All previous runs have completed." }],
          };
        }

        const runLines = activeRuns.map(
          (r) =>
            `| \`${r.runId}\` | ${r.planTitle} | ${r.status} | ${r.currentTask}/${r.totalTasks} |`
        );

        return {
          content: [
            {
              type: "text",
              text: [
                `## Active SDD Runs (${activeRuns.length})`,
                ``,
                `| Run ID | Plan | Status | Progress |`,
                `|--------|------|--------|----------|`,
                ...runLines,
                ``,
                `Use \`sdd_status({ runId: "..." })\` for details on a specific run.`,
              ].join("\n"),
            },
          ],
          details: { activeRuns: activeRuns.length, runs: activeRuns.map((r) => r.runId) },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error reading SDD status: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  });

  // ── sdd_result ──

  pi.registerTool({
    name: "sdd_result",
    label: "Get SDD Run Result",
    description:
      "Retrieve the final result of a completed plan execution run. Returns per-task status, file changes, and summary.",
    parameters: Type.Object({
      runId: Type.String({
        description: "The runId returned by sdd_submit.",
      }),
    }),

    async execute(
      _toolCallId: string,
      params: unknown,
      _signal: AbortSignal | undefined,
      _onUpdate: ((data: unknown) => void) | undefined,
      _ctx: ExtensionContext,
    ) {
      const runId = (params as { runId?: string })?.runId?.trim();
      if (!runId) {
        return {
          content: [{ type: "text", text: "Error: sdd_result requires a runId argument." }],
        };
      }

      try {
        ensureDirs();

        // Check results first
        const resultPath = resolve(RESULTS_DIR, `${runId}.json`);
        if (existsSync(resultPath)) {
          const result = JSON.parse(readFileSync(resultPath, "utf-8")) as RunResult;
          const taskLines = result.tasks.map(
            (t) =>
              `| ${t.id} | ${t.title} | ${t.status} | ${t.specPassed ? "✅" : "❌"} | ${t.codeReviewPassed ? "✅" : "❌"} | ${t.files.join(", ") || "-"} |`
          );

          return {
            content: [
              {
                type: "text",
                text: [
                  `## SDD Result: ${result.planTitle}`,
                  `**Run:** \`${runId}\` | **Status:** ${result.status} | **All passed:** ${result.allPassed ? "✅" : "❌"}`,
                  ``,
                  `| # | Task | Status | Spec | Code | Files |`,
                  `|---|------|--------|------|------|-------|`,
                  ...taskLines,
                  ``,
                  `**Summary:** ${result.summary}`,
                  `**Completed:** ${result.completedAt}`,
                ].join("\n"),
              },
            ],
            details: result,
          };
        }

        // Check progress if no result yet
        const progressPath = resolve(PROGRESS_DIR, `${runId}.json`);
        if (existsSync(progressPath)) {
          const progress = JSON.parse(readFileSync(progressPath, "utf-8")) as RunProgress;
          return {
            content: [
              {
                type: "text",
                text: `Run \`${runId}\` is still **${progress.status}**. Use \`sdd_status\` to check progress.`,
              },
            ],
            details: progress,
          };
        }

        return {
          content: [{ type: "text", text: `Run \`${runId}\` not found.` }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error reading SDD result: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  });
}
