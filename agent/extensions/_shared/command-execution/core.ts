import {
    createBashToolDefinition,
    type BashOperations,
    type BashToolDetails,
    type AgentToolResult,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
    recordExecution,
    resolveExecution,
    unknownExecution,
    type ExecutionObserver,
    type ExecutionProvenance,
} from "../execution-provenance/index.ts";
import { recordSandboxExecutionContext } from "../sandbox-runtime/execution-context.ts";
import type { SandboxExecutionContext } from "../sandbox-runtime/execution-context.ts";
import type { CreateBashOperationsOptions } from "./exec.ts";
import { classifySafeExecutionError, SafeExecutionError } from "./failure.ts";
import {
    inspectDangerousMatches,
    redirectShellCommandWithPolicy,
    type AllowedShellCommand,
    type DangerMatch,
} from "./guard.ts";
import {
    authorizeDangerousMatches,
    type CommandGuardPolicy,
    type GuardSessionApprovals,
} from "./policy.ts";
import {
    applyFirstRewrite,
    type BashRewriteRule,
    type CommandRewriteProfile,
} from "./rewrites.ts";

export type CommandExecutionDefinition = ReturnType<
    typeof createBashToolDefinition
>;
type CommandExecutionExecute = CommandExecutionDefinition["execute"];
export type CommandExecutionResult = AgentToolResult<
    (BashToolDetails & { execution?: ExecutionProvenance }) | undefined
>;
export type CommandExecutionUpdateCallback =
    Parameters<CommandExecutionExecute>[3];

export type CommandExecutionDecision = "allowed" | "blocked";
export type CommandExecutionOutcome =
    | "blocked"
    | "succeeded"
    | "failed"
    | "aborted";

export interface CommandExecutionRecord<
    Operation extends CommandRewriteProfile,
> {
    operation: Operation;
    toolCallId: string;
    command: string;
    match: DangerMatch | null;
    decision?: CommandExecutionDecision;
    outcome: CommandExecutionOutcome;
    groupId?: string;
    patternId?: string;
    reason?: string;
    error?: string;
}

export interface CommandExecutionTelemetryRecorder<
    Operation extends CommandRewriteProfile,
> {
    record(input: CommandExecutionRecord<Operation>): Promise<void>;
    flush(): Promise<void>;
}

export interface CommandExecutionRequest<
    Operation extends CommandRewriteProfile,
> {
    toolCallId: string;
    operation: Operation;
    command: string;
    timeout?: number;
    stdin?: string;
    signal?: AbortSignal;
    onUpdate?: CommandExecutionUpdateCallback;
    ctx: ExtensionContext;
}

export interface CommandExecutionService<
    Operation extends CommandRewriteProfile,
> {
    execute(
        request: CommandExecutionRequest<Operation>,
    ): Promise<CommandExecutionResult>;
}

export interface CommandExecutionOperationsOptions {
    onExecution?: ExecutionObserver;
    onSandboxContext?: (context: SandboxExecutionContext) => void;
    stdin?: string;
    rewriteCommand?: CreateBashOperationsOptions["rewriteCommand"];
}

export interface CommandExecutionServiceOptions<
    Operation extends CommandRewriteProfile,
> {
    approvals: GuardSessionApprovals;
    getAllowedShellCommands(): readonly AllowedShellCommand[];
    getGuardPolicy(): Readonly<Record<string, CommandGuardPolicy>>;
    getRewriteRules(): readonly BashRewriteRule[];
    getTelemetryRecorder(): CommandExecutionTelemetryRecorder<Operation> | null;
    shouldEnforceNativeTools(): boolean;
    createOperations(
        options: CommandExecutionOperationsOptions,
    ): BashOperations;
    createDefinition?: (
        cwd: string,
        operations: BashOperations,
    ) => Pick<CommandExecutionDefinition, "execute">;
}

export function createCommandExecutionService<
    Operation extends CommandRewriteProfile,
>(
    options: CommandExecutionServiceOptions<Operation>,
): CommandExecutionService<Operation> {
    const createDefinition =
        options.createDefinition ??
        ((cwd: string, operations: BashOperations) =>
            createBashToolDefinition(cwd, { operations }));

    return {
        async execute(request) {
            recordExecution(request.toolCallId, unknownExecution());
            const telemetry = options.getTelemetryRecorder();
            const executionName = request.operation;
            const authorization = await authorizeDangerousMatches(
                inspectDangerousMatches(request.command, executionName),
                options.getGuardPolicy(),
                request.ctx,
                options.approvals,
                { toolName: executionName },
            );
            const danger = authorization.match ?? null;
            if (!authorization.allowed && danger) {
                recordExecution(request.toolCallId, {
                    ...unknownExecution(),
                    phase: "policy",
                    outcome: "blocked",
                });
                await telemetry?.record({
                    operation: request.operation,
                    toolCallId: request.toolCallId,
                    command: request.command,
                    match: danger,
                    outcome: "blocked",
                    reason: authorization.reason,
                });
                const reason = authorization.reason ?? danger.message;
                throw new SafeExecutionError("guard", reason, reason);
            }

            const redirect = redirectShellCommandWithPolicy(
                request.command,
                options.shouldEnforceNativeTools(),
                options.getAllowedShellCommands(),
                executionName,
            );
            if (redirect) {
                recordExecution(request.toolCallId, {
                    ...unknownExecution(),
                    phase: "policy",
                    outcome: "blocked",
                });
                await telemetry?.record({
                    operation: request.operation,
                    toolCallId: request.toolCallId,
                    command: request.command,
                    match: null,
                    decision: "blocked",
                    outcome: "blocked",
                    groupId: "native-tool-redirect",
                    reason: redirect,
                });
                throw new SafeExecutionError("redirect", redirect, redirect);
            }

            const operations = options.createOperations({
                onExecution: (execution) =>
                    recordExecution(request.toolCallId, execution),
                onSandboxContext: (context) =>
                    recordSandboxExecutionContext(request.toolCallId, context),
                stdin: request.stdin,
                rewriteCommand: (command) =>
                    applyFirstRewrite(command, request.operation, [
                        ...options.getRewriteRules(),
                    ]),
            });
            const definition = createDefinition(request.ctx.cwd, operations);
            try {
                const result = await definition.execute(
                    request.toolCallId,
                    {
                        command: request.command,
                        timeout: request.timeout,
                    },
                    request.signal,
                    request.onUpdate,
                    request.ctx,
                );
                await telemetry?.record({
                    operation: request.operation,
                    toolCallId: request.toolCallId,
                    command: request.command,
                    match: danger,
                    decision: danger ? "allowed" : undefined,
                    outcome: "succeeded",
                });
                return {
                    ...result,
                    details: {
                        ...result.details,
                        execution: resolveExecution(request.toolCallId),
                    },
                };
            } catch (error) {
                const classified = classifySafeExecutionError(error);
                await telemetry?.record({
                    operation: request.operation,
                    toolCallId: request.toolCallId,
                    command: request.command,
                    match: danger,
                    decision: danger ? "allowed" : undefined,
                    outcome: request.signal?.aborted ? "aborted" : "failed",
                    error: classified.raw,
                });
                throw new SafeExecutionError(
                    classified.kind,
                    classified.reason,
                    classified.raw,
                    classified.code,
                );
            }
        },
    };
}
