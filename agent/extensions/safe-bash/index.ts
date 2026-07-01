/**
 * Safe bash extension.
 * Wraps the built-in bash tool with dangerous command blocking.
 *
 * Based on amosblomqvist/pi-subagents safe-bash.ts
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { isDangerous } from "./guard";

export default function (pi: ExtensionAPI) {
  // Use createBashToolDefinition to get renderCall/renderResult
  // so safe_bash shows the command in the session UI like built-in bash.
  const bashDefinition = createBashToolDefinition(process.cwd());

  pi.registerTool({
    name: "safe_bash",
    label: "Safe Bash",
    description:
      "Execute a bash command. Provides basic guardrails against accidentally destructive operations (e.g., rm -rf /, sudo). NOT a security sandbox — determined attackers can bypass these checks.",
    parameters: Type.Object({
      command: Type.String({ description: "Bash command to execute" }),
      timeout: Type.Optional(
        Type.Number({ description: "Timeout in seconds (optional)" }),
      ),
    }),
    // Delegate renderers to bash tool definition so command is visible in TUI
    renderCall: bashDefinition.renderCall,
    renderResult: bashDefinition.renderResult,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const danger = isDangerous(params.command);
      if (danger) {
        throw new Error(danger);
      }
      return bashDefinition.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  });
}
