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
import { shellToolPresentation } from "../_shared/shell-presentation/index.ts";
import { CapabilityError } from "../sandbox/capabilities/authority.ts";
import {
    currentShellPolicy,
    requireForcedSandboxShellPolicy,
    requireShellPolicy,
    resolveForcedSandboxPolicyForExecution,
    resolveShellPolicyForExecution,
    trackShellOperation,
} from "../sandbox/capabilities/runtime.ts";

function createConfiguredSandboxOperations(
    policy: Awaited<ReturnType<typeof resolveShellPolicyForExecution>>,
    options: SandboxBashOperationOptions,
    forced = false,
): BashOperations {
    const observer: typeof options.onExecution = (value) =>
        options.onExecution?.({
            ...value,
            mode: "sandbox",
            shellProfile: policy.profile,
        });
    return createSandboxBashOperations({
        ...options,
        onExecution: observer,
        beforeDispatch: (fingerprint) => {
            const latest = forced
                ? requireForcedSandboxShellPolicy(policy.projectRoot)
                : requireShellPolicy(policy.projectRoot);
            if (
                latest.profile !== policy.profile ||
                (latest.sandboxFingerprint &&
                    latest.sandboxFingerprint !== fingerprint)
            ) {
                throw new CapabilityError(
                    "authorization-required",
                    "Shell policy changed. Refresh with /sandbox mode " +
                        (latest.requestedMode ?? latest.mode ?? "sandbox") +
                        ". The command was not executed.",
                );
            }
            options.beforeDispatch?.(fingerprint);
        },
    });
}

function resolveForcedSandboxOperations(
    options: SandboxBashOperationOptions = {},
): BashOperations {
    return {
        exec: async (command, cwd, executionOptions) => {
            const policy = await resolveForcedSandboxPolicyForExecution(cwd);
            const operations = createConfiguredSandboxOperations(
                policy,
                options,
                true,
            );
            return trackShellOperation(policy, command, () =>
                operations.exec(command, cwd, executionOptions),
            );
        },
    };
}

export function resolveBashOperations(
    localSupervisor: BashProcessSupervisor,
    options: SandboxBashOperationOptions = {},
): BashOperations {
    return {
        exec: async (command, cwd, executionOptions) => {
            if ("hostCapability" in options) {
                throw new CapabilityError(
                    "migration-required",
                    "Legacy hostCapability was removed. Use a standard bash command and choose the execution mode explicitly.",
                );
            }
            let policy;
            try {
                policy = await resolveShellPolicyForExecution(cwd);
            } catch (error) {
                let currentPolicy;
                try {
                    currentPolicy = currentShellPolicy();
                } catch {
                    // Preserve the original policy refusal when resolution itself failed.
                }
                options.onExecution?.({
                    ...unknownExecution(),
                    ...(currentPolicy
                        ? {
                              mode:
                                  currentPolicy.mode === "host"
                                      ? ("host" as const)
                                      : ("sandbox" as const),
                              shellProfile: currentPolicy.profile,
                          }
                        : {}),
                    phase: "policy",
                    outcome: "blocked",
                });
                throw error;
            }
            const observer: typeof options.onExecution = (value) =>
                options.onExecution?.({
                    ...value,
                    mode: policy.mode === "host" ? "host" : "sandbox",
                    shellProfile: policy.profile,
                });
            const sandbox = createConfiguredSandboxOperations(policy, options);
            const operations =
                policy.mode === "host"
                    ? localSupervisor.createOperations({
                          // Do not rewrite a permission-checked command using project-controlled host code.
                          detached: true,
                          onExecution: observer,
                          stdin: options.stdin,
                      })
                    : sandbox;
            return trackShellOperation(policy, command, () =>
                operations.exec(command, cwd, executionOptions),
            );
        },
    };
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
                ? resolveForcedSandboxOperations(operationOptions)
                : sandboxPrefix
                  ? undefined
                  : resolveBashOperations(
                        options.localSupervisor,
                        operationOptions,
                    );
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
