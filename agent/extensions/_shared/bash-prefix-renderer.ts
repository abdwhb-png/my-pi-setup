/**
 * bash-prefix-renderer — shared renderCall for bash-like tools.
 *
 * Factory that creates a renderCall function showing "{prefix} $ {command}"
 * instead of bare tool name or bare "$ {command}". Tracks startedAt/endedAt
 * on context.state so bash's renderResult can read timing.
 *
 * Usage:
 *   import { createBashPrefixRenderer } from "../_shared/bash-prefix-renderer";
 *   pi.registerTool({
 *     ...,
 *     renderCall: createBashPrefixRenderer("🔒"),
 *     renderResult: bashDefinition.renderResult,
 *   });
 */
import { Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

interface RenderCallArgs {
  command?: string;
  timeout?: number;
}

interface RenderCallContext {
  lastComponent?: Component;
  state: Record<string, unknown>;
  executionStarted?: boolean;
}

/**
 * Create a renderCall function that displays "{prefix} $ {command}" in the TUI.
 *
 * @param prefixOrFn - Static string or dynamic getter (called each render).
 *   Use a getter when prefix depends on runtime state (e.g. sandbox on/off).
 */
export function createBashPrefixRenderer(
  prefixOrFn: string | (() => string),
): (args: RenderCallArgs, theme: Theme, context: RenderCallContext) => Component {
  const resolve = typeof prefixOrFn === "function" ? prefixOrFn : () => prefixOrFn;

  return (args, theme, context) => {
    // Track execution started/ended for bash's renderResult
    if (context.executionStarted && context.state.startedAt === undefined) {
      context.state.startedAt = Date.now();
      context.state.endedAt = undefined;
    }

    // Reuse Text component across renders (perf + preserves cached lines)
    const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);

    const command = args?.command;
    const timeout = args?.timeout;
    const prefix = resolve();
    const timeoutSuffix = timeout
      ? theme.fg("muted", ` (timeout ${timeout}s)`)
      : "";
    const commandDisplay = command || theme.fg("toolOutput", "...");

    text.setText(
      theme.fg("toolTitle", theme.bold(`${prefix} $ ${commandDisplay}`)) +
        timeoutSuffix,
    );

    return text;
  };
}
