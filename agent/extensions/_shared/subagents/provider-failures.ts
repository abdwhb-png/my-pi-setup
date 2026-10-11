import {
    closeSync,
    fstatSync,
    openSync,
    readFileSync,
    realpathSync,
} from "node:fs";
import { constants } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface FailedProviderRun {
    runId: string;
    index: number;
    agent: string;
    failedModel: string;
}
function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
const MAX_TRANSCRIPT_BYTES = 1024 * 1024;
// Dot segments would escape the parent-derived run directory.
const RUN_ID = /^(?!\.{1,2}$)[a-zA-Z0-9._-]{1,128}$/;

/** Only read a Pi child's exact parent-derived session file; skip arbitrary paths or incomplete sessions. */
function failedAssistantModel(
    parentSessionFile: string | undefined,
    runId: string,
    index: number,
    sessionFile: string,
): string | undefined {
    if (
        !parentSessionFile?.endsWith(".jsonl") ||
        !isAbsolute(parentSessionFile) ||
        !RUN_ID.test(runId) ||
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index > 1000
    )
        return undefined;
    const expected = join(
        dirname(parentSessionFile),
        basename(parentSessionFile, ".jsonl"),
        runId,
        `run-${index}`,
        "session.jsonl",
    );
    if (resolve(sessionFile) !== expected) return undefined;
    let fd: number | undefined;
    try {
        if (realpathSync(sessionFile) !== expected) return undefined;
        fd = openSync(sessionFile, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > MAX_TRANSCRIPT_BYTES)
            return undefined;
        const entries = readFileSync(fd, "utf8").trimEnd().split("\n");
        let failedModel: string | undefined;
        for (const line of entries) {
            const entry: unknown = JSON.parse(line);
            if (
                !record(entry) ||
                entry.type !== "message" ||
                !record(entry.message)
            )
                continue;
            const message = entry.message;
            if (message.role === "toolResult" || message.role === "custom")
                return undefined;
            if (message.role !== "assistant") continue;
            if (
                !Array.isArray(message.content) ||
                message.content.some(
                    (part) =>
                        !record(part) ||
                        part.type !== "text" ||
                        typeof part.text !== "string" ||
                        part.text.trim(),
                )
            )
                return undefined;
            if (
                message.stopReason !== "error" ||
                typeof message.errorMessage !== "string" ||
                !message.errorMessage.trim() ||
                typeof message.provider !== "string" ||
                typeof message.model !== "string"
            )
                return undefined;
            failedModel = `${message.provider}/${message.model}`;
        }
        return failedModel;
    } catch {
        // Missing, malformed or inaccessible transcripts are insufficient evidence.
        return undefined;
    } finally {
        if (fd !== undefined) closeSync(fd);
    }
}

/** Verify the actual provider model even when the result includes a thinking suffix. */
function matchesFailedModel(
    result: Record<string, unknown>,
    failedModel: string,
): boolean {
    if (
        typeof result.requestedModel === "string" &&
        result.requestedModel !== failedModel
    )
        return false;
    if (typeof result.model !== "string" || result.model === failedModel)
        return true;
    const thinking = result.thinking;
    return (
        result.requestedModel === failedModel &&
        typeof thinking === "string" &&
        ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
            thinking,
        ) &&
        result.model === `${failedModel}:${thinking}`
    );
}

/** Interpret the official package's compacted result, not its untrusted error text. */
export function findFailedProviderRuns(
    details: unknown,
    parentSessionFile: string | undefined,
): FailedProviderRun[] {
    if (
        !record(details) ||
        !["single", "parallel", "chain", "workflow"].includes(
            String(details.mode),
        ) ||
        typeof details.runId !== "string" ||
        !RUN_ID.test(details.runId) ||
        !Array.isArray(details.results)
    )
        return [];
    const advice: FailedProviderRun[] = [];
    for (const result of details.results) {
        if (!record(result)) continue;
        const foregroundFailure =
            Number.isSafeInteger(result.exitCode) &&
            result.exitCode !== 0 &&
            record(result.progressSummary) &&
            result.progressSummary.toolCount === 0;
        const asyncFailure =
            typeof details.sessionId === "string" &&
            details.sessionId.length > 0 &&
            result.exitCode === undefined &&
            result.progressSummary === undefined &&
            result.success === false &&
            result.outputState === "absent";
        if (
            (!foregroundFailure && !asyncFailure) ||
            typeof result.agent !== "string" ||
            typeof result.sessionFile !== "string" ||
            typeof result.index !== "number" ||
            !Number.isSafeInteger(result.index) ||
            typeof result.error !== "string" ||
            result.timedOut ||
            result.interrupted ||
            result.stopped ||
            result.contextOverflow ||
            result.detached ||
            result.turnBudgetExceeded ||
            result.toolBudgetBlocked ||
            result.outputState === "present" ||
            (typeof result.finalOutput === "string" &&
                result.finalOutput.trim()) ||
            (Array.isArray(result.toolCalls) && result.toolCalls.length > 0) ||
            result.runner !== undefined
        )
            continue;
        // Async completion identifies the outer run; its child transcript has a distinct run ID.
        const childRunId = asyncFailure
            ? basename(dirname(dirname(result.sessionFile)))
            : details.runId;
        if (
            asyncFailure &&
            typeof result.runId === "string" &&
            result.runId !== childRunId
        )
            continue;
        const failedModel = failedAssistantModel(
            parentSessionFile,
            childRunId,
            result.index,
            result.sessionFile,
        );
        if (!failedModel || !matchesFailedModel(result, failedModel)) continue;
        advice.push({
            runId: details.runId,
            index: result.index,
            agent: result.agent,
            failedModel,
        });
    }
    return advice;
}

export function observeProviderFailures(
    pi: ExtensionAPI,
    receive: (failure: FailedProviderRun) => void,
): void {
    let sessionId: string | undefined;
    let parentFile: string | undefined;
    pi.on("session_start", (_event, ctx) => {
        sessionId = ctx.sessionManager.getSessionId();
        parentFile = ctx.sessionManager.getSessionFile();
    });
    pi.on("session_shutdown", () => {
        sessionId = undefined;
        parentFile = undefined;
    });
    pi.on("before_provider_request", (_event, ctx) => {
        if (sessionId === ctx.sessionManager.getSessionId())
            parentFile = ctx.sessionManager.getSessionFile() ?? parentFile;
    });
    pi.on("tool_result", (event, ctx) => {
        if (
            event.toolName !== "subagent" ||
            sessionId !== ctx.sessionManager.getSessionId()
        )
            return;
        for (const failure of findFailedProviderRuns(
            event.details,
            ctx.sessionManager.getSessionFile(),
        ))
            receive(failure);
    });
    pi.events.on("subagent:async-complete", (data: unknown) => {
        if (
            !record(data) ||
            typeof data.sessionId !== "string" ||
            (data.sessionId !== sessionId && data.sessionId !== parentFile)
        )
            return;
        for (const failure of findFailedProviderRuns(data, parentFile))
            receive(failure);
    });
}
