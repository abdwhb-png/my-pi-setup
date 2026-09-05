import {
    createBashToolDefinition,
    type BashOperations,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { CreateBashOperationsOptions } from "./exec.ts";
import { classifySafeExecutionError, SafeExecutionError } from "./failure.ts";
import {
    inspectDangerousMatches,
    redirectShellCommandWithPolicy,
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
export type CommandExecutionResult = Awaited<
    ReturnType<CommandExecutionExecute>
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
    stdin?: string;
    rewriteCommand?: CreateBashOperationsOptions["rewriteCommand"];
}

export interface CommandExecutionServiceOptions<
    Operation extends CommandRewriteProfile,
> {
    approvals: GuardSessionApprovals;
    getAllowedShellCommands(): readonly string[];
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
                return result;
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
                );
            }
        },
    };
}
