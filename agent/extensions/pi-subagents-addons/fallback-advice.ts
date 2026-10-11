import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { rewriteProviderSystemPrompt } from "../_shared/provider-system-prompt.ts";
import {
    findFailedProviderRuns,
    observeProviderFailures,
    type FailedProviderRun,
} from "../_shared/subagents/provider-failures.ts";

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

export function findFailedModelAdvice(
    details: unknown,
    parentSessionFile: string | undefined,
    fallbackModels: Record<string, string[]>,
): FailedModelAdvice[] {
    return findFailedProviderRuns(details, parentSessionFile).flatMap(
        (failure) => {
            const candidates = fallbackModels[failure.agent]?.filter(
                (model) => model !== failure.failedModel,
            );
            return candidates?.length ? [{ ...failure, candidates }] : [];
        },
    );
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

    const enqueue = (failure: FailedProviderRun) => {
        const candidates = config.fallbackModels[failure.agent]?.filter(
            (model) => model !== failure.failedModel,
        );
        if (!candidates?.length) return;
        const candidate = { ...failure, candidates };
        const identity = `${candidate.runId}:${candidate.index}`;
        if (seen.has(identity)) return;
        seen.add(identity);
        if (seen.size > 128) seen.delete(seen.values().next().value!);
        pending.push(candidate);
        if (pending.length > 16) pending.shift();
    };
    observeProviderFailures(pi, enqueue);
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
