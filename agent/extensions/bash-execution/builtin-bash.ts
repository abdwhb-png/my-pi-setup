import {
    createBashToolDefinition,
    defineTool,
    type BashOperations,
    type BashToolDetails,
    type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";

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
    unknownExecution,
} from "../_shared/execution-provenance/index.ts";
import { recordSandboxExecutionContext } from "../_shared/sandbox-runtime/execution-context.ts";
import {
    createSandboxBashOperations,
    getSandboxRuntime,
    type SandboxBashOperationOptions,
} from "../_shared/sandbox-runtime/index.ts";

export function resolveBashOperations(
    localSupervisor: BashProcessSupervisor,
    options: SandboxBashOperationOptions = {},
): BashOperations {
    const runtime = getSandboxRuntime();
    const sandbox = createSandboxBashOperations(options);
    if (runtime.state === "disabled") {
        const local = localSupervisor.createOperations({
            onExecution: options.onExecution,
            stdin: options.stdin,
            rewriteCommand: options.rewriteCommand,
        });
        return {
            exec: (command, cwd, executionOptions) =>
                getSandboxRuntime().state === "disabled"
                    ? local.exec(command, cwd, executionOptions)
                    : sandbox.exec(command, cwd, executionOptions),
        };
    }
    return sandbox;
}

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
    pi.registerTool(
        defineTool<typeof bashWithStdinSchema, BashToolDetails | undefined>({
            ...bashDefinition,
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
        const sandboxPrefix = /^s(?:\s|$)/.test(event.command);
        const command = sandboxPrefix
            ? event.command.slice(1).trimStart()
            : event.command;
        const operationOptions = {
            onExecution: (value: typeof execution) => {
                execution = value;
            },
        };
        const operations =
            sandboxPrefix && command.length > 0
                ? createSandboxBashOperations(operationOptions)
                : sandboxPrefix
                  ? undefined
                  : options.localSupervisor.createOperations(operationOptions);
        return {
            operations: {
                exec: async (_command, cwd, executionOptions) => {
                    try {
                        if (sandboxPrefix && command.length === 0) {
                            throw new Error("Usage: !s <command>");
                        }
                        if (!operations) {
                            throw new Error("Usage: !s <command>");
                        }
                        return await operations.exec(
                            sandboxPrefix ? command : _command,
                            cwd,
                            executionOptions,
                        );
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
        rewriteRules = loadBashRewrites(projectCwd).rules;
    });
}
