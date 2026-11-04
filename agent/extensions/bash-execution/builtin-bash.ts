import {
    createBashToolDefinition,
    createLocalBashOperations,
    defineTool,
    type BashToolDetails,
    type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import {
    bashWithStdinSchema,
    type BashProcessSupervisor,
} from "../_shared/command-execution/exec.ts";
import { createBashPrefixRenderer } from "../_shared/command-execution/prefix-renderer.ts";
import {
    applyFirstRewrite,
    loadBashRewrites,
} from "../_shared/command-execution/rewrites.ts";
import { appendCompressionFooter } from "../_shared/compression-render.ts";
import {
    recordExecution,
    hostExecution,
    executionFromDetails,
    formatShellExecutionLabel,
    unknownExecution,
} from "../_shared/execution-provenance/index.ts";
import { recordSandboxExecutionContext } from "../_shared/sandbox-runtime/execution-context.ts";
import { getSandboxRuntime } from "../_shared/sandbox-runtime/index.ts";
import { CapabilityError } from "../_shared/shell-capability-error.ts";
import { shellToolPresentation } from "../_shared/shell-presentation/index.ts";
import { resolveBashOperations } from "../_shared/shell-runtime/operations.ts";

export { resolveBashOperations } from "../_shared/shell-runtime/operations.ts";

export interface BuiltinBashRegistrationOptions {
    localSupervisor: BashProcessSupervisor;
}

export function registerBuiltinBash(
    pi: ExtensionAPI,
    options: BuiltinBashRegistrationOptions,
): void {
    let projectCwd = process.cwd();
    let bashDefinition = createBashToolDefinition(projectCwd);
    let rewriteRules = loadBashRewrites(projectCwd).rules;
    pi.registerEntryRenderer("pi.execution.user-bash.v1", (entry) => {
        const execution = executionFromDetails(entry.data);
        return execution
            ? new Text(
                  formatShellExecutionLabel(
                      execution,
                      execution.mode ?? "host",
                  ),
                  0,
                  0,
              )
            : undefined;
    });
    pi.registerTool(
        defineTool<typeof bashWithStdinSchema, BashToolDetails | undefined>({
            ...bashDefinition,
            ...shellToolPresentation("bash"),
            name: "bash",
            parameters: bashWithStdinSchema,
            label: "bash",
            renderCall: createBashPrefixRenderer(() =>
                getSandboxRuntime().state === "enabled" ? "🛡️" : "",
            ),
            renderResult: (result, renderOptions, theme, context) => {
                const component = bashDefinition.renderResult!(
                    result,
                    renderOptions,
                    theme,
                    context,
                );
                if (!renderOptions.isPartial) {
                    appendCompressionFooter(component, result.details, theme);
                }
                return component;
            },
            async execute(id, params, signal, onUpdate, ctx) {
                if ("hostCapability" in params) {
                    throw new CapabilityError(
                        "migration-required",
                        "Legacy hostCapability was removed from tool parameters. Use a standard command and select the desired execution mode.",
                    );
                }
                recordExecution(id, unknownExecution());
                const operations = resolveBashOperations(
                    options.localSupervisor,
                    {
                        stdin: params.stdin,
                        onExecution: (execution) =>
                            recordExecution(id, execution),
                        onSandboxContext: (context) =>
                            recordSandboxExecutionContext(id, context),
                        rewriteCommand: (command) =>
                            applyFirstRewrite(command, "bash", rewriteRules),
                    },
                );
                const tool = createBashToolDefinition(projectCwd, {
                    operations,
                });
                return tool.execute(
                    id,
                    { command: params.command, timeout: params.timeout },
                    signal,
                    onUpdate,
                    ctx,
                );
            },
        }),
    );

    pi.on("user_bash", (event) => {
        let execution = unknownExecution();
        const operations = createLocalBashOperations({
            shellPath: pi.getSettings().shellPath,
        });
        return {
            operations: {
                exec: async (command, cwd, executionOptions) => {
                    try {
                        const result = await operations.exec(
                            command,
                            cwd,
                            executionOptions,
                        );
                        execution = {
                            ...hostExecution("process"),
                            backend: "local",
                            outcome: executionOptions.signal?.aborted
                                ? "aborted"
                                : result.exitCode === 0
                                  ? "succeeded"
                                  : "failed",
                            ...(result.exitCode !== null
                                ? { exitCode: result.exitCode }
                                : {}),
                        };
                        return result;
                    } catch (error) {
                        execution = {
                            ...execution,
                            mode: "host",
                            phase: "process",
                            outcome: executionOptions.signal?.aborted
                                ? "aborted"
                                : "failed",
                        };
                        throw error;
                    } finally {
                        pi.appendEntry("pi.execution.user-bash.v1", {
                            command: event.command,
                            execution,
                        });
                    }
                },
            },
        };
    });

    pi.on("session_start", (_event, ctx) => {
        options.localSupervisor.shutdown();
        projectCwd = ctx.cwd;
        bashDefinition = createBashToolDefinition(projectCwd);
        rewriteRules = loadBashRewrites(
            projectCwd,
            ctx.isProjectTrusted(),
        ).rules;
    });
}
