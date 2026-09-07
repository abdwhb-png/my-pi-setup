import { parseExecutionProvenance } from "../_shared/execution-provenance/index.ts";
import { redactTextPreservingContext } from "../_shared/redaction.ts";
import type { ThinkExecutionProvenance } from "./execution-provenance.ts";

import type { ThinkExecuteAction } from "./types.ts";

export type ThinkResultStatus = "success" | "partial";
export type ThinkSourceStatus = "succeeded" | "failed" | "mixed";
export type ThinkIndexStatus = "indexed" | "failed" | "unknown";
export type ThinkFailureStage = "source" | "analysis" | "store";
export type ThinkRecovery =
    | "restore_sandbox"
    | "change_command"
    | "change_program"
    | "change_source"
    | "repair_store"
    | "retry";

export interface ThinkExecuteHeader extends Partial<ThinkExecutionProvenance> {
    status: ThinkResultStatus;
    action: ThinkExecuteAction;
    sourceStatus: ThinkSourceStatus;
    sourceBytes: number;
    resultBytes: number;
    truncated: boolean;
    archiveIds: readonly string[];
    indexStatus: ThinkIndexStatus;
    total?: number;
    succeeded?: number;
    failed?: number;
    blocked?: number;
}

export interface ThinkFailurePayload extends Partial<ThinkExecutionProvenance> {
    tool: "think_execute";
    status: "error";
    action: ThinkExecuteAction;
    stage: ThinkFailureStage;
    code: string;
    reason: string;
    recovery: ThinkRecovery;
}

export interface ThinkArtifactSearchFailurePayload {
    tool: "think_artifact_search";
    status: "error";
    stage: "store";
    code: string;
    reason: string;
    recovery: "repair_store" | "retry";
}

const THINK_EXECUTION_ERROR_BRAND: unique symbol = Symbol.for(
    "pi.think-in-code.ThinkExecutionError.v1",
);
type OpaqueValue = ErrorOptions["cause"];

export function createThinkExecuteContent(
    header: ThinkExecuteHeader,
    result: string,
): [{ type: "text"; text: string }, { type: "text"; text: string }] {
    return [
        { type: "text", text: JSON.stringify(header) },
        { type: "text", text: result },
    ];
}

export function createThinkExecutionError(
    input: Omit<ThinkFailurePayload, "tool" | "status">,
): Error {
    const payload: ThinkFailurePayload = {
        tool: "think_execute",
        status: "error",
        action: input.action,
        stage: input.stage,
        code: input.code.replace(/[^a-z0-9_-]/gi, "-").slice(0, 64),
        reason: redactTextPreservingContext(input.reason, { maxLength: 512 }),
        recovery: input.recovery,
    };
    const error = new Error(JSON.stringify(payload));
    error.name = "ThinkExecutionError";
    Object.defineProperty(error, THINK_EXECUTION_ERROR_BRAND, {
        configurable: false,
        enumerable: false,
        value: true,
        writable: false,
    });
    return error;
}

export function createThinkArtifactSearchError(input: {
    code: string;
    reason: string;
    recovery: ThinkArtifactSearchFailurePayload["recovery"];
}): Error {
    const payload: ThinkArtifactSearchFailurePayload = {
        tool: "think_artifact_search",
        status: "error",
        stage: "store",
        code: input.code.replace(/[^a-z0-9_-]/gi, "-").slice(0, 64),
        reason: redactTextPreservingContext(input.reason, { maxLength: 512 }),
        recovery: input.recovery,
    };
    const error = new Error(JSON.stringify(payload));
    error.name = "ThinkArtifactSearchError";
    return error;
}

export function isThinkExecutionError(error: OpaqueValue): error is Error {
    if (typeof error !== "object" || error === null) return false;
    return Reflect.get(error, THINK_EXECUTION_ERROR_BRAND) === true;
}

export function parseThinkExecuteHeader(
    content: OpaqueValue,
): ThinkExecuteHeader | undefined {
    const text = firstText(content);
    if (text === undefined) return undefined;
    let parsed: OpaqueValue;
    try {
        parsed = JSON.parse(text);
    } catch {
        return undefined;
    }
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const status = Reflect.get(parsed, "status");
    const action = Reflect.get(parsed, "action");
    const sourceStatus = Reflect.get(parsed, "sourceStatus");
    const sourceBytes = Reflect.get(parsed, "sourceBytes");
    const resultBytes = Reflect.get(parsed, "resultBytes");
    const truncated = Reflect.get(parsed, "truncated");
    const archiveIds = Reflect.get(parsed, "archiveIds");
    const rawIndexStatus = Reflect.get(parsed, "indexStatus");
    const indexStatus = isThinkIndexStatus(rawIndexStatus)
        ? rawIndexStatus
        : "unknown";
    const total = Reflect.get(parsed, "total");
    const succeeded = Reflect.get(parsed, "succeeded");
    const failed = Reflect.get(parsed, "failed");
    const blocked = Reflect.get(parsed, "blocked");
    const sourceExecution = parseExecutionProvenance(
        Reflect.get(parsed, "sourceExecution"),
    );
    const analysisExecution = parseExecutionProvenance(
        Reflect.get(parsed, "analysisExecution"),
    );
    const rawSources = Reflect.get(parsed, "sourceExecutions");
    const sourceExecutions = Array.isArray(rawSources)
        ? rawSources.flatMap((item) => {
              const execution =
                  item && typeof item === "object"
                      ? parseExecutionProvenance(item.execution)
                      : undefined;
              return execution &&
                  typeof item.id === "string" &&
                  item.id.length <= 128
                  ? [{ id: item.id, execution }]
                  : [];
          })
        : undefined;
    if (
        (status !== "success" && status !== "partial") ||
        !isThinkAction(action) ||
        !isThinkSourceStatus(sourceStatus) ||
        typeof sourceBytes !== "number" ||
        typeof resultBytes !== "number" ||
        typeof truncated !== "boolean" ||
        !isStringArray(archiveIds) ||
        !isOptionalCount(total) ||
        !isOptionalCount(succeeded) ||
        !isOptionalCount(failed) ||
        !isOptionalCount(blocked)
    ) {
        return undefined;
    }
    return {
        status,
        action,
        sourceStatus,
        sourceBytes,
        resultBytes,
        truncated,
        archiveIds,
        indexStatus,
        ...(total === undefined ? {} : { total }),
        ...(succeeded === undefined ? {} : { succeeded }),
        ...(failed === undefined ? {} : { failed }),
        ...(blocked === undefined ? {} : { blocked }),
        ...(sourceExecution ? { sourceExecution } : {}),
        ...(analysisExecution ? { analysisExecution } : {}),
        ...(sourceExecutions ? { sourceExecutions } : {}),
    };
}

export function parseThinkArtifactSearchFailurePayload(
    content: OpaqueValue,
): ThinkArtifactSearchFailurePayload | undefined {
    const text = firstText(content);
    if (text === undefined) return undefined;
    let parsed: OpaqueValue;
    try {
        parsed = JSON.parse(text);
    } catch {
        return undefined;
    }
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const tool = Reflect.get(parsed, "tool");
    const status = Reflect.get(parsed, "status");
    const stage = Reflect.get(parsed, "stage");
    const code = Reflect.get(parsed, "code");
    const reason = Reflect.get(parsed, "reason");
    const recovery = Reflect.get(parsed, "recovery");
    if (
        tool !== "think_artifact_search" ||
        status !== "error" ||
        stage !== "store" ||
        typeof code !== "string" ||
        typeof reason !== "string" ||
        (recovery !== "repair_store" && recovery !== "retry")
    ) {
        return undefined;
    }
    return { tool, status, stage, code, reason, recovery };
}

export function parseThinkFailurePayload(
    content: OpaqueValue,
): ThinkFailurePayload | undefined {
    const text = firstText(content);
    if (text === undefined) return undefined;
    let parsed: OpaqueValue;
    try {
        parsed = JSON.parse(text);
    } catch {
        return undefined;
    }
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const tool = Reflect.get(parsed, "tool");
    const status = Reflect.get(parsed, "status");
    const action = Reflect.get(parsed, "action");
    const stage = Reflect.get(parsed, "stage");
    const code = Reflect.get(parsed, "code");
    const reason = Reflect.get(parsed, "reason");
    const recovery = Reflect.get(parsed, "recovery");
    if (
        tool !== "think_execute" ||
        status !== "error" ||
        !isThinkAction(action) ||
        !isThinkFailureStage(stage) ||
        typeof code !== "string" ||
        typeof reason !== "string" ||
        !isThinkRecovery(recovery)
    ) {
        return undefined;
    }
    return { tool, status, action, stage, code, reason, recovery };
}

function firstText(content: OpaqueValue): string | undefined {
    if (!Array.isArray(content)) return undefined;
    const first = content[0];
    if (typeof first !== "object" || first === null) return undefined;
    if (Reflect.get(first, "type") !== "text") return undefined;
    const value = Reflect.get(first, "text");
    if (typeof value !== "string") {
        return undefined;
    }
    const jsonStart = value.indexOf("{");
    const candidate = jsonStart >= 0 ? value.slice(jsonStart) : value;
    return candidate.split("\n", 1)[0];
}

function isThinkAction(value: OpaqueValue): value is ThinkExecuteAction {
    return (
        value === "command" ||
        value === "content" ||
        value === "archives" ||
        value === "file" ||
        value === "batch"
    );
}

function isThinkSourceStatus(value: OpaqueValue): value is ThinkSourceStatus {
    return value === "succeeded" || value === "failed" || value === "mixed";
}

function isThinkIndexStatus(value: OpaqueValue): value is ThinkIndexStatus {
    return value === "indexed" || value === "failed" || value === "unknown";
}

function isThinkFailureStage(value: OpaqueValue): value is ThinkFailureStage {
    return value === "source" || value === "analysis" || value === "store";
}

function isThinkRecovery(value: OpaqueValue): value is ThinkRecovery {
    return (
        value === "restore_sandbox" ||
        value === "change_command" ||
        value === "change_program" ||
        value === "change_source" ||
        value === "repair_store" ||
        value === "retry"
    );
}

function isStringArray(value: OpaqueValue): value is string[] {
    return (
        Array.isArray(value) && value.every((item) => typeof item === "string")
    );
}

function isOptionalCount(value: OpaqueValue): value is number | undefined {
    return (
        value === undefined ||
        (typeof value === "number" && Number.isInteger(value) && value >= 0)
    );
}
