import { shouldEnforceNativeTools } from "../_shared/audit-mode/audit-tool-routing.ts";
import {
    createCommandExecutionService,
    type CommandExecutionService,
    type CommandExecutionServiceOptions,
    type CommandExecutionTelemetryRecorder,
} from "../_shared/command-execution/core.ts";
import { GuardSessionApprovals } from "../_shared/command-execution/policy.ts";
import { createSandboxBashOperations } from "../_shared/sandbox-runtime/index.ts";

import type { ThinkInCodeConfig } from "./config.ts";

export type ThinkCommandOperation = "think_execute" | "think_batch_execute";

export interface ThinkCommandExecutionOptions {
    getConfig(): ThinkInCodeConfig;
    getTelemetryRecorder(): CommandExecutionTelemetryRecorder<ThinkCommandOperation> | null;
    shouldEnforceNativeTools?: () => boolean;
    createOperations?: CommandExecutionServiceOptions<ThinkCommandOperation>["createOperations"];
    createDefinition?: CommandExecutionServiceOptions<ThinkCommandOperation>["createDefinition"];
}

export interface ThinkCommandExecution {
    service: CommandExecutionService<ThinkCommandOperation>;
    approvals: GuardSessionApprovals;
}

export function createThinkCommandExecution(
    options: ThinkCommandExecutionOptions,
): ThinkCommandExecution {
    const approvals = new GuardSessionApprovals();
    const service = createCommandExecutionService<ThinkCommandOperation>({
        approvals,
        getAllowedShellCommands: () =>
            options.getConfig().commandPolicy.allowedShellCommands,
        getGuardPolicy: () => options.getConfig().commandPolicy.guardPolicy,
        getRewriteRules: () => options.getConfig().commandPolicy.rewrites,
        getTelemetryRecorder: () => options.getTelemetryRecorder(),
        shouldEnforceNativeTools:
            options.shouldEnforceNativeTools ?? shouldEnforceNativeTools,
        createOperations: (operationOptions) =>
            (options.createOperations ?? createSandboxBashOperations)(
                operationOptions,
            ),
        ...(options.createDefinition
            ? { createDefinition: options.createDefinition }
            : {}),
    });
    return { service, approvals };
}
