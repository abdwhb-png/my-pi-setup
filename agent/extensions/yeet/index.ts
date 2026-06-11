import { defineTool, type ExtensionAPI, type AgentToolResult } from "@mariozechner/pi-coding-agent";
import { Type } from "@mariozechner/pi-ai";
import { CommitPlanSession } from "./session";
import type { CommitPlanParams, CommitPlanResult } from "./types";

const YEET_PROMPT = [
  "Commit the current repository changes.",
  "",
  "CRITICAL RULE: Before performing any git operations, you MUST use the 'propose_commit_plan' tool.",
  "",
  "Workflow:",
  "1. Analyze the current changes (git status, git diff) provided below.",
  "2. Group changes into logical, atomic units (e.g., separate a refactor from a feature, or a bugfix from a doc update).",
  "3. Propose the FIRST logical commit using 'propose_commit_plan'.",
  "4. If the user accepts, proceed to commit those specific files.",
  "5. After a commit is successful, analyze the REMAINING changes and repeat the process until all changes are committed.",
  "6. If the user rejects a plan, adjust it and propose again.",
  "",
  "Commit Quality Guidelines:",
  "- Use Conventional Commits (e.g., 'feat:', 'fix:', 'refactor:', 'docs:').",
  "- Be descriptive. Avoid 'update files' or 'fix bugs'.",
  "- Each commit should do one thing and do it completely.",
  "",
  "IMPORTANT: If the tool returns HARD_CANCEL, stop the entire commit process immediately and return to normal conversation.",
  "Do NOT push unless explicitly requested.",
  "",
  "--- Current Git Status ---",
].join("\n");

// Number of rejection retries before forcing a hard cancel option
const _MAX_RETRIES = 2;

const proposeCommitPlanTool = defineTool({
  name: "propose_commit_plan",
  label: "Propose Commit Plan",
  description:
    "Propose a commit plan to the user. The user can review, edit the message, and toggle files in an interactive UI before approving.",
  promptSnippet: "Propose a commit plan for user review before staging or committing.",
  promptGuidelines: [
    "Analyze changes and group them into logical, atomic units (e.g., separate refactors from features).",
    "Propose the first logical commit using propose_commit_plan. Do NOT commit everything at once.",
    "If the tool returns ACCEPTED, proceed with git add and git commit for those specific files.",
    "If the tool returns REJECTED, adjust the plan and propose again.",
    "After each successful commit, analyze remaining changes and propose the next commit until all are handled.",
    "If the tool returns HARD_CANCEL, stop the commit workflow immediately and return to normal conversation.",
  ],
  parameters: Type.Object({
    plan_summary: Type.String({ description: "Summary of the changes and why the commit is needed." }),
    files: Type.Array(Type.String(), { description: "File paths to include in the commit." }),
    commit_message: Type.String({ description: "The proposed commit message." }),
  }),
  async execute(
    _toolCallId: string,
    params: CommitPlanParams,
    _signal: AbortSignal | undefined,
    _onUpdate: unknown,
    ctx: any,
  ): Promise<AgentToolResult<CommitPlanResult>> {
    const result = await (ctx.ui.custom as any)(
      (_tui: unknown, theme: unknown, _kb: unknown, done: (r: CommitPlanResult) => void) =>
        new CommitPlanSession({ theme: theme as any, params, done }),
      { overlay: true, overlayOptions: { anchor: "center" as const, width: "80%" as const } },
    ) as CommitPlanResult;

    // Accept → proceed with commit
    if (result.accepted) {
      return {
        content: [
          {
            type: "text" as const,
            text: [
              "User ACCEPTED the commit plan. Proceed with:",
              "",
              "Files: " + result.files.join(", "),
              "Message: " + result.commit_message,
            ].join("\n"),
          },
        ],
        details: result,
      };
    }

    // Reject (Ctrl+R) → repropose
    if (!result.cancelled) {
      return {
        content: [
          {
            type: "text" as const,
            text: [
              "User REJECTED the commit plan.",
              "",
              "You MUST call propose_commit_plan again with a different plan.",
              "Do NOT stage or commit without approval.",
            ].join("\n"),
          },
        ],
        details: result,
      };
    }

    // Hard cancel (Esc) → stop everything
    return {
      content: [
        {
          type: "text" as const,
          text: [
            "HARD_CANCEL: The user cancelled the commit process.",
            "",
            "You MUST NOT call propose_commit_plan again.",
            "Do NOT stage or commit anything.",
            "Acknowledge the cancellation and return to normal conversation.",
          ].join("\n"),
        },
      ],
      details: result,
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(proposeCommitPlanTool);

  pi.registerCommand("yeet", {
    description: "Add and commit current repo changes (push only if user requests it)",
    handler: async (args: string, ctx: any) => {
      // Programmatically check git status so the LLM always has real data
      let gitStatus = "";
      let gitDiffStat = "";
      try {
        const statusResult = await pi.exec("git", ["status", "--short"], { cwd: ctx.cwd });
        gitStatus = statusResult.stdout.trim();
      } catch {
        gitStatus = "(not a git repository or git status failed)";
      }

      try {
        const diffResult = await pi.exec("git", ["diff", "--stat"], { cwd: ctx.cwd });
        gitDiffStat = diffResult.stdout.trim();
      } catch {
        gitDiffStat = "(git diff failed)";
      }

      const hasChanges = gitStatus.length > 0;

      const prompt = [
        YEET_PROMPT,
        "",
        gitStatus || "(no changes)",
        "",
        "--- Diff Summary ---",
        gitDiffStat || "(no diff)",
        "",
        hasChanges
          ? "There are pending changes. Analyze them and propose the first atomic commit."
          : "The working tree is clean. There is nothing to commit.",
        "",
        args.trim() ? "Additional instructions from the user:\n" + args.trim() : "",
      ].join("\n");

      if (ctx.isIdle()) {
        pi.sendUserMessage(prompt);
      } else {
        pi.sendUserMessage(prompt, { deliverAs: "followUp" });
        ctx.ui.notify("Queued /yeet as a follow-up", "info");
      }
    },
  });
}
