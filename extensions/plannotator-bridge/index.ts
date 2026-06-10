/**
 * plannotator-bridge — Thin extension exposing plan_submit and plan_annotate
 * tools that route to Plannotator's browser review UI.
 *
 * This bridges the gap between the Pi agent's native tool system and
 * Plannotator's browser-based plan review and annotation UI. The agent
 * (LLM) calls these tools, which read the file from disk, open the
 * Plannotator browser UI for review, and return the result.
 */

import { readFileSync, statSync } from "node:fs";
import { resolve, relative, extname, isAbsolute } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  openPlanReviewBrowser,
  openMarkdownAnnotation,
  hasPlanBrowserHtml,
} from "../../npm/node_modules/@plannotator/pi-extension/plannotator-browser.js";

// ── Pure helper functions (also tested independently in test.ts) ──

export function validatePlanPath(inputPath: string, cwd: string): string | null {
  if (!inputPath || !inputPath.trim()) {
    return "Path is required";
  }

  const resolved = resolve(cwd, inputPath.trim());
  const rel = relative(resolve(cwd), resolved);

  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return `Path must be inside the working directory: ${inputPath}`;
  }

  const ext = extname(resolved).toLowerCase();
  if (ext !== ".md" && ext !== ".mdx") {
    return `Plan file must be a markdown file (.md or .mdx), got: ${ext}`;
  }

  try {
    if (!statSync(resolved).isFile()) {
      return `Not a regular file: ${inputPath}`;
    }
  } catch {
    return `File not found: ${inputPath}`;
  }

  return null;
}

export function validateAnnotatePath(inputPath: string, cwd: string): string | null {
  if (!inputPath || !inputPath.trim()) {
    return "Path is required";
  }

  const resolved = resolve(cwd, inputPath.trim());
  const rel = relative(resolve(cwd), resolved);

  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return `Path must be inside the working directory: ${inputPath}`;
  }

  try {
    if (!statSync(resolved).isFile()) {
      return `Not a regular file: ${inputPath}`;
    }
  } catch {
    return `File not found: ${inputPath}`;
  }

  return null;
}

export function readPlanFile(inputPath: string, cwd: string): { ok: true; content: string } | { ok: false; error: string } {
  const validationError = validatePlanPath(inputPath, cwd);
  if (validationError) {
    return { ok: false, error: validationError };
  }

  const resolved = resolve(cwd, inputPath.trim());

  try {
    const content = readFileSync(resolved, "utf-8");
    if (!content.trim()) {
      return { ok: false, error: `Plan file is empty: ${inputPath}` };
    }
    return { ok: true, content };
  } catch (err) {
    return { ok: false, error: `Failed to read file: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function formatReviewResult(decision: { approved: boolean; feedback?: string }): string {
  if (decision.approved) {
    const notes = decision.feedback ? `\n\n**Reviewer notes:**\n${decision.feedback}` : "";
    return `## Plan Approved ✓${notes}\n\nProceed with execution. Mark completed steps with [DONE:n].`;
  }

  const feedback = decision.feedback || "No specific feedback provided.";
  return `## Plan Requires Revision\n\n**Feedback:**\n${feedback}\n\nEdit the plan file and re-submit via plan_submit.`;
}

export function formatAnnotationResult(result: { feedback?: string; exit?: boolean; approved?: boolean }): string {
  if (result.approved) {
    return "## Annotation Approved ✓";
  }
  if (result.exit) {
    return "## Annotation Closed\n\nThe annotation session was closed without feedback.";
  }
  if (result.feedback) {
    return `## Annotation Feedback\n\n${result.feedback}`;
  }
  return "## Annotation Closed\n\nNo feedback was provided.";
}

// ── Extension entry point ──

export default function (pi: ExtensionAPI) {
  // ── plan_submit tool ──
  pi.registerTool({
    name: "plan_submit",
    label: "Submit Plan",
    description:
      "Submit a plan markdown file (.md or .mdx) for browser-based review via Plannotator. " +
      "Write the plan file first using the write tool, then call this with its path. " +
      "The user will review the plan in a visual browser UI and can approve, annotate, or deny it. " +
      "If denied with feedback, edit the plan file and re-submit.",
    parameters: Type.Object({
      filePath: Type.String({
        description:
          "Path to the markdown plan file, relative to the working directory. Must end in .md or .mdx.",
      }),
    }),

    async execute(
      _toolCallId: string,
      params: unknown,
      _signal: AbortSignal | undefined,
      _onUpdate: ((data: unknown) => void) | undefined,
      ctx: ExtensionContext,
    ) {
      const inputPath = (params as { filePath?: string })?.filePath?.trim();
      if (!inputPath) {
        return {
          content: [{ type: "text", text: "Error: plan_submit requires a filePath argument." }],
        };
      }

      // Validate and read the plan file
      const readResult = readPlanFile(inputPath, ctx.cwd);
      if (!readResult.ok) {
        return {
          content: [{ type: "text", text: `Error: ${readResult.error}` }],
        };
      }

      // Check browser availability
      if (!ctx.hasUI || !hasPlanBrowserHtml()) {
        return {
          content: [
            {
              type: "text",
              text:
                "Plannotator browser review is unavailable in this session " +
                "(no UI support or missing browser assets). " +
                "Plan content:\n\n" +
                readResult.content +
                "\n\n---\nProceed with this plan or request changes.",
            },
          ],
        };
      }

      // Submit to Plannotator browser review
      try {
        const decision = await openPlanReviewBrowser(ctx, readResult.content);

        if (decision.approved) {
          const notes = decision.feedback ? `\n\n**Reviewer notes:**\n${decision.feedback}` : "";
          return {
            content: [
              {
                type: "text",
                text: `## Plan Approved ✓${notes}\n\nProceed with execution. Mark completed steps with [DONE:n].`,
              },
            ],
            details: { approved: true, feedback: decision.feedback },
          };
        }

        const feedback = decision.feedback || "No specific feedback provided.";
        return {
          content: [
            {
              type: "text",
              text: `## Plan Requires Revision\n\n**Feedback:**\n${feedback}\n\nEdit the plan file at \`${inputPath}\` and re-submit via plan_submit.`,
            },
          ],
          details: { approved: false, feedback: decision.feedback },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error launching plan review: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  });

  // ── plan_annotate tool ──
  pi.registerTool({
    name: "plan_annotate",
    label: "Annotate File",
    description:
      "Open a file for browser-based annotation review via Plannotator. " +
      "The user can annotate, approve, or provide feedback on the file content. " +
      "Supports markdown files, source code, HTML files, and URLs.",
    parameters: Type.Object({
      filePath: Type.String({
        description:
          "Path to the file to annotate, relative to the working directory. " +
          "Can be .md, .ts, .tsx, .html, or any text file.",
      }),
    }),

    async execute(
      _toolCallId: string,
      params: unknown,
      _signal: AbortSignal | undefined,
      _onUpdate: ((data: unknown) => void) | undefined,
      ctx: ExtensionContext,
    ) {
      const inputPath = (params as { filePath?: string })?.filePath?.trim();
      if (!inputPath) {
        return {
          content: [{ type: "text", text: "Error: plan_annotate requires a filePath argument." }],
        };
      }

      // Validate path
      const validationError = validateAnnotatePath(inputPath, ctx.cwd);
      if (validationError) {
        return {
          content: [{ type: "text", text: `Error: ${validationError}` }],
        };
      }

      // Read file content
      const resolved = resolve(ctx.cwd, inputPath.trim());
      let content: string;
      try {
        content = readFileSync(resolved, "utf-8");
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error reading file: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }

      // Check browser availability
      if (!ctx.hasUI || !hasPlanBrowserHtml()) {
        return {
          content: [
            {
              type: "text",
              text:
                "Plannotator annotation browser is unavailable in this session " +
                "(no UI support or missing browser assets). " +
                "File content:\n\n" +
                content,
            },
          ],
        };
      }

      // Submit to Plannotator annotation UI
      try {
        const result = await openMarkdownAnnotation(
          ctx,
          inputPath,
          content,
          "annotate",
        );

        if (result.approved) {
          return {
            content: [{ type: "text", text: "## Annotation Approved ✓" }],
            details: { approved: true },
          };
        }

        if (result.exit) {
          return {
            content: [
              { type: "text", text: "## Annotation Closed\n\nThe annotation session was closed without feedback." },
            ],
            details: { exit: true },
          };
        }

        if (result.feedback) {
          return {
            content: [
              {
                type: "text",
                text: `## Annotation Feedback\n\n${result.feedback}`,
              },
            ],
            details: { feedback: result.feedback },
          };
        }

        return {
          content: [
            { type: "text", text: "## Annotation Closed\n\nNo feedback was provided." },
          ],
          details: { exit: true },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error launching annotation: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  });
}
