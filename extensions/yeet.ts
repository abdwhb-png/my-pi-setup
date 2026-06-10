import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const YEET_PROMPT = `Commit the current repository changes.

Steps:
1. Add all unstaged changes with \`git add -A\`.
2. Inspect the staged changes and write a concise commit message that accurately summarizes them.
3. Commit the changes with that message.

Keep the commit message concise.

Do NOT push unless the user explicitly requests it.`;

export default function (pi: ExtensionAPI) {
  pi.registerCommand("yeet", {
    description: "Add and commit current repo changes (push only if user requests it)",
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
