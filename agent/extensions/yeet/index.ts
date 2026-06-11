import { defineTool, type ExtensionAPI, type AgentToolResult } from "@mariozechner/pi-coding-agent";
import { Type } from "@mariozechner/pi-ai";
import { CommitPlanSession } from "./session";
import type { CommitPlanParams, CommitPlanResult } from "./types";

const YEET_PROMPT = [
  "Commit the current repository changes.",
  "",
  "You MUST call propose_commit_plan BEFORE staging or committing.",
  "",
  "Steps:",
  "1. Run git status and git diff to analyze what changed.",
  "2. Formulate a commit plan: summary, files to include, commit message.",
  "3. Call propose_commit_plan with your proposed plan.",
  "4. The user can review and modify the plan in the interactive UI.",
  "5. If ACCEPTED: git add -A (checking for draft/proposal files), then git commit with the approved message.",
  "6. If REJECTED: adjust your plan based on feedback and call propose_commit_plan again.",
  "",
  "IMPORTANT: If the tool returns a HARD_CANCEL signal, the user wants to stop the commit process entirely.",
  "Do NOT propose another plan. Acknowledge the cancellation and return to normal conversation.",
  "",
  "Do NOT push unless explicitly requested.",
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
    "Call propose_commit_plan with a summary, file list, and proposed message after analyzing git changes.",
    "If the tool returns ACCEPTED, proceed with git add and git commit using the approved values.",
    "If the tool returns REJECTED, call propose_commit_plan again with a different plan. Do NOT stage or commit without approval.",
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
      const prompt = args.trim()
        ? YEET_PROMPT + "\n\nAdditional instructions from the user:\n" + args.trim()
        : YEET_PROMPT;

      if (ctx.isIdle()) {
        pi.sendUserMessage(prompt);
      } else {
        pi.sendUserMessage(prompt, { deliverAs: "followUp" });
        ctx.ui.notify("Queued /yeet as a follow-up", "info");
      }
    },
  });
}
