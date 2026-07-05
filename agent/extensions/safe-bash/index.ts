/**
 * Safe bash extension.
 * Wraps the built-in bash tool with dangerous command blocking.
 *
 * Based on amosblomqvist/pi-subagents safe-bash.ts
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { isDangerous, redirectShellCommandWithPolicy } from "../_shared/bash-guard";
import { shouldEnforceNativeTools } from "../_shared/audit-mode/audit-tool-routing";
import { createBashPrefixRenderer } from "../_shared/bash-prefix-renderer";
import { appendCompressionFooter } from "../_shared/compression-render";

export default function (pi: ExtensionAPI) {
  // Use createBashToolDefinition to get renderCall/renderResult
  // so safe_bash shows the command in the session UI like built-in bash.
  const bashDefinition = createBashToolDefinition(process.cwd());

  pi.registerTool({
    name: "safe_bash",
    label: "🔒Safe Bash",
    description:
      "Execute a bash command. Provides basic guardrails against accidentally destructive operations (e.g., rm -rf /, sudo). NOT a security sandbox — determined attackers can bypass these checks.",
    parameters: Type.Object({
      command: Type.String({ description: "Bash command to execute" }),
      timeout: Type.Optional(
        Type.Number({ description: "Timeout in seconds (optional)" }),
      ),
    }),
    // Custom renderCall shows 🔒 prefix so user knows safe_bash ran
    renderCall: createBashPrefixRenderer("🔒"),
    // renderResult delegates to bash's and optionally appends compression footer
    renderResult: (
      result: Parameters<NonNullable<typeof bashDefinition.renderResult>>[0],
      options: Parameters<NonNullable<typeof bashDefinition.renderResult>>[1],
      theme: Parameters<NonNullable<typeof bashDefinition.renderResult>>[2],
      context: Parameters<NonNullable<typeof bashDefinition.renderResult>>[3],
    ) => {
      const component = bashDefinition.renderResult!(result, options, theme, context);
      if (!options.isPartial) {
        appendCompressionFooter(component, result.details, theme);
      }
      return component;
    },
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const danger = isDangerous(params.command);
      if (danger) {
        throw new Error(danger);
      }
      const redirect = redirectShellCommandWithPolicy(
        params.command,
        shouldEnforceNativeTools(),
      );
      if (redirect) {
        throw new Error(redirect);
      }
      return bashDefinition.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  });
}
