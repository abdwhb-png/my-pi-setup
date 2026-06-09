import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const YEET_PROMPT = `Commit and push the current repository changes.

Steps:
1. Add all unstaged changes with \`git add -A\`.
2. Inspect the staged changes and write a concise commit message that accurately summarizes them.
3. Commit the changes with that message.

Keep the commit message concise.`;

export default function (pi: ExtensionAPI) {
  pi.registerCommand("yeet", {
    description: "Add, commit, and push the current repo changes",
    handler: async (args, ctx) => {
      const prompt = args?.trim()
        ? `${YEET_PROMPT}\n\nAdditional instructions from the user:\n${args.trim()}`
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
