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
import { rewriteProviderSystemPrompt } from "../_shared/provider-system-prompt.ts";

export interface FallbackAdviceConfig {
    enabled: boolean;
    fallbackModels: Record<string, string[]>;
}

export interface FailedModelAdvice {
    runId: string;
    index: number;
    agent: string;
    failedModel: string;
    candidates: string[];
}

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseFallbackAdviceConfig(
    value: unknown,
): FallbackAdviceConfig {
    if (!record(value) || typeof value.enabled !== "boolean")
        throw new Error("Invalid fallback advice enabled flag");
    if (!value.enabled) return { enabled: false, fallbackModels: {} };
    if (!record(value.fallbackModels))
        throw new Error("Fallback advice requires per-agent fallbackModels");
    const fallbackModels: Record<string, string[]> = {};
    for (const [agent, models] of Object.entries(value.fallbackModels)) {
        if (
            !agent.trim() ||
            !Array.isArray(models) ||
            !models.length ||
            !models.every(
                (model) =>
                    typeof model === "string" &&
                    model.trim() === model &&
                    model.includes("/") &&
                    model.length > 2,
            ) ||
            new Set(models).size !== models.length
        )
            throw new Error(`Invalid fallback models for agent ${agent}`);
        fallbackModels[agent] = [...models];
    }
    return { enabled: true, fallbackModels };
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

/** Interpret the official package's compacted result, not its untrusted error text. */
export function findFailedModelAdvice(
    details: unknown,
    parentSessionFile: string | undefined,
    fallbackModels: Record<string, string[]>,
): FailedModelAdvice[] {
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
    const advice: FailedModelAdvice[] = [];
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
        const failedModel = failedAssistantModel(
            parentSessionFile,
            details.runId,
            result.index,
            result.sessionFile,
        );
        if (
            !failedModel ||
            (typeof result.model === "string" && result.model !== failedModel)
        )
            continue;
        const candidates = fallbackModels[result.agent]?.filter(
            (model) => model !== failedModel,
        );
        if (!candidates?.length) continue;
        advice.push({
            runId: details.runId,
            index: result.index,
            agent: result.agent,
            failedModel,
            candidates,
        });
    }
    return advice;
}

const START = "<pi-subagent-fallback-advice>";
const END = "</pi-subagent-fallback-advice>";
const BLOCK =
    /\n{0,2}<pi-subagent-fallback-advice>[\s\S]*?<\/pi-subagent-fallback-advice>/g;

function stripAdvice(prompt: string): string {
    return prompt.replace(BLOCK, "");
}

function appendAdvice(prompt: string, advice: FailedModelAdvice[]): string {
    const base = stripAdvice(prompt);
    if (!advice.length) return base;
    const data = advice.map(
        ({ runId, index, agent, failedModel, candidates }) =>
            JSON.stringify({
                runId,
                index,
                agent,
                failedModel,
                candidates,
            }).replaceAll("<", "\\u003c"),
    );
    return [
        base,
        "",
        START,
        "These completed Pi child runs failed on a provider request before doing useful work. Advice only: inspect run/status before deciding whether to relaunch. Never retry automatically; preserve run ownership and review any partial effects.",
        ...data,
        END,
    ].join("\n");
}

/** Observes only Pi results; never changes tool output or saved conversation. */
export function registerFallbackAdvice(
    pi: ExtensionAPI,
    config: FallbackAdviceConfig,
): void {
    if (!config.enabled) return;
    let sessionId: string | undefined;
    let parentSessionFile: string | undefined;
    let pending: FailedModelAdvice[] = [];
    const seen = new Set<string>();
    let warning: string | undefined;

    const enqueue = (details: unknown, file: string | undefined) => {
        for (const candidate of findFailedModelAdvice(
            details,
            file,
            config.fallbackModels,
        )) {
            const identity = `${candidate.runId}:${candidate.index}`;
            if (seen.has(identity)) continue;
            seen.add(identity);
            if (seen.size > 128) seen.delete(seen.values().next().value!);
            pending.push(candidate);
            if (pending.length > 16) pending.shift();
        }
    };
    pi.on("session_start", (_event, ctx) => {
        sessionId = ctx.sessionManager.getSessionId();
        parentSessionFile = ctx.sessionManager.getSessionFile();
        pending = [];
        seen.clear();
    });
    pi.on("session_shutdown", () => {
        sessionId = undefined;
        parentSessionFile = undefined;
        pending = [];
        seen.clear();
    });
    pi.on("tool_result", (event, ctx) => {
        if (
            event.toolName !== "subagent" ||
            sessionId !== ctx.sessionManager.getSessionId()
        )
            return;
        enqueue(event.details, ctx.sessionManager.getSessionFile());
    });
    pi.events.on("subagent:async-complete", (data: unknown) => {
        if (
            !record(data) ||
            typeof data.sessionId !== "string" ||
            data.sessionId !== sessionId
        )
            return;
        enqueue(data, parentSessionFile);
    });
    pi.on("before_provider_request", (event, ctx) => {
        if (sessionId !== ctx.sessionManager.getSessionId()) return undefined;
        parentSessionFile =
            ctx.sessionManager.getSessionFile() ?? parentSessionFile;
        if (!pending.length) return undefined;
        try {
            const payload = rewriteProviderSystemPrompt(
                ctx.model?.api ?? "unknown",
                event.payload,
                (prompt) => appendAdvice(prompt, pending),
                stripAdvice,
            );
            pending = [];
            warning = undefined;
            return payload;
        } catch (error) {
            const reason =
                error instanceof Error
                    ? error.message
                    : "Invalid provider payload";
            if (warning !== reason)
                ctx.ui.notify(
                    `Subagent fallback advice unavailable: ${reason}`,
                    "warning",
                );
            warning = reason;
            return undefined;
        }
    });
}
