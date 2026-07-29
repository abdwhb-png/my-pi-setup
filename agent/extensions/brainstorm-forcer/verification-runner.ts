import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import {
    basename,
    dirname,
    isAbsolute,
    join,
    resolve as resolvePath,
    sep,
} from "node:path";
import {
    ARCHITECT_AGENT,
    VERIFICATION_DOMAINS,
    VERIFICATION_OUTCOMES,
    VERIFIER_AGENT_ALLOWLIST,
    type VerificationDomain,
    type VerificationOutcome,
} from "./verification";

export const SUBAGENT_RPC_PROTOCOL_VERSION = 1 as const;
export const SUBAGENT_RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
export const SUBAGENT_RPC_REPLY_EVENT_PREFIX = "subagents:rpc:v1:reply:";
export const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";

type RpcMethod = "ping" | "spawn" | "status";

export interface EventBusLike {
    on(event: string, handler: (data: unknown) => void): (() => void) | void;
    emit(event: string, data: unknown): void;
}

type VerificationSpawnInput = Readonly<{
    chain: readonly unknown[];
}>;

type PendingVerificationStepBase = Readonly<{
    outputName: string;
    agent: string;
    claimIds: readonly string[];
    evidenceIds: readonly string[];
    resultIndex: number;
    chainStepIndex: number;
}>;

export type PendingVerificationStep = Readonly<
    | (PendingVerificationStepBase & {
          role: "verifier";
          domain: VerificationDomain;
          outcome: VerificationOutcome;
      })
    | (PendingVerificationStepBase & {
          role: "architect";
      })
>;

export type PendingVerificationRun = Readonly<{
    runId: string;
    asyncDir: string;
    ownerSessionId: string;
    brainstormRunId: string;
    claimIds: readonly string[];
    startedAt: string;
    expectedSteps: readonly PendingVerificationStep[];
}>;

export type OwnedTerminalCompletion =
    | {
          kind: "complete";
          structuredOutputs: Readonly<Record<string, unknown>>;
      }
    | { kind: "unrelated" }
    | {
          kind: "failure";
          failureKind: "failed" | "malformed" | "timeout";
          reason: string;
      };

type PendingCall = {
    reject(error: Error): void;
    cleanup(): void;
};

type CompletionSubscription = {
    handler(data: unknown): void;
    unsubscribe(): void;
};

function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function text(value: unknown, field: string): string {
    if (typeof value !== "string" || !value.trim())
        throw new Error(`Malformed subagent RPC reply: ${field} is required.`);
    return value;
}

function strings(value: unknown, pattern?: RegExp): value is readonly string[] {
    return (
        Array.isArray(value) &&
        value.every(
            (item) =>
                typeof item === "string" &&
                item.trim().length > 0 &&
                (pattern === undefined || pattern.test(item)),
        )
    );
}

function unique(values: readonly string[]): boolean {
    return new Set(values).size === values.length;
}

const ASYNC_RUNS_DIRNAME = "async-subagent-runs";
const TEMP_SCOPE_PATTERN = /^pi-subagents-[A-Za-z0-9._-]+$/;

function hasTrustedAsyncDirShape(asyncDir: string, runId: string): boolean {
    if (
        !isAbsolute(asyncDir) ||
        asyncDir.split(sep).includes("..") ||
        basename(asyncDir) !== runId
    )
        return false;
    const asyncRoot = dirname(resolvePath(asyncDir));
    const scopeRoot = dirname(asyncRoot);
    return (
        basename(asyncRoot) === ASYNC_RUNS_DIRNAME &&
        TEMP_SCOPE_PATTERN.test(basename(scopeRoot)) &&
        dirname(scopeRoot) === resolvePath(tmpdir())
    );
}

function canonicalNonSymlinkDirectory(path: string): string | undefined {
    const directory = lstatSync(path);
    return directory.isDirectory() && !directory.isSymbolicLink()
        ? realpathSync(path)
        : undefined;
}

function stableJson(value: unknown): string {
    if (Array.isArray(value))
        return `[${value.map((item) => stableJson(item)).join(",")}]`;
    const object = record(value);
    if (object)
        return `{${Object.entries(object)
            .toSorted(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
            .join(",")}}`;
    return JSON.stringify(value);
}

export function isPendingVerificationRun(
    value: unknown,
): value is PendingVerificationRun {
    const pending = record(value);
    if (
        !pending ||
        typeof pending.runId !== "string" ||
        !pending.runId.trim() ||
        typeof pending.asyncDir !== "string" ||
        !hasTrustedAsyncDirShape(pending.asyncDir, pending.runId) ||
        typeof pending.ownerSessionId !== "string" ||
        !pending.ownerSessionId.trim() ||
        typeof pending.brainstormRunId !== "string" ||
        !pending.brainstormRunId.trim() ||
        typeof pending.startedAt !== "string" ||
        !pending.startedAt.trim() ||
        !strings(pending.claimIds, /^CL-\d+$/) ||
        pending.claimIds.length === 0 ||
        !unique(pending.claimIds) ||
        !Array.isArray(pending.expectedSteps) ||
        pending.expectedSteps.length === 0
    )
        return false;

    const outputNames = new Set<string>();
    const pendingClaimIds = pending.claimIds as readonly string[];
    let architectCount = 0;
    for (const [stepPosition, rawStep] of pending.expectedSteps.entries()) {
        const step = record(rawStep);
        if (
            !step ||
            typeof step.outputName !== "string" ||
            !step.outputName.trim() ||
            outputNames.has(step.outputName) ||
            !strings(step.claimIds, /^CL-\d+$/) ||
            step.claimIds.length === 0 ||
            !unique(step.claimIds) ||
            !step.claimIds.every((id) => pendingClaimIds.includes(id)) ||
            !strings(step.evidenceIds, /^EV-\d+$/) ||
            !unique(step.evidenceIds) ||
            step.resultIndex !== stepPosition ||
            !Number.isSafeInteger(step.chainStepIndex) ||
            Number(step.chainStepIndex) < 0
        )
            return false;
        outputNames.add(step.outputName);
        if (step.role === "verifier") {
            if (
                typeof step.agent !== "string" ||
                !VERIFIER_AGENT_ALLOWLIST.includes(step.agent) ||
                !VERIFICATION_DOMAINS.includes(
                    step.domain as VerificationDomain,
                ) ||
                !VERIFICATION_OUTCOMES.includes(
                    step.outcome as VerificationOutcome,
                ) ||
                step.chainStepIndex !== 0
            )
                return false;
            continue;
        }
        if (
            step.role !== "architect" ||
            step.agent !== ARCHITECT_AGENT ||
            step.chainStepIndex !== 1
        )
            return false;
        architectCount += 1;
    }
    return architectCount <= 1;
}

function terminalFailure(
    failureKind: "failed" | "malformed" | "timeout",
    reason: string,
): Extract<OwnedTerminalCompletion, { kind: "failure" }> {
    return { kind: "failure", failureKind, reason };
}

export function parseOwnedTerminalCompletion(
    value: unknown,
    pending: PendingVerificationRun,
): OwnedTerminalCompletion {
    const completion = record(value);
    if (!completion || completion.runId !== pending.runId)
        return { kind: "unrelated" };
    if (completion.sessionId !== pending.ownerSessionId)
        return terminalFailure(
            "malformed",
            "Completion owner session does not match the pending run.",
        );
    if (completion.timedOut === true)
        return terminalFailure(
            "timeout",
            typeof completion.error === "string"
                ? completion.error
                : "Verification run timed out.",
        );
    if (
        completion.success !== true ||
        completion.state !== "complete" ||
        completion.exitCode !== 0
    )
        return terminalFailure(
            "failed",
            typeof completion.error === "string"
                ? completion.error
                : "Verification run did not complete successfully.",
        );

    if (
        !Array.isArray(completion.results) ||
        completion.results.length !== pending.expectedSteps.length
    )
        return terminalFailure(
            "malformed",
            "Completion result count does not match the expected verification steps.",
        );
    const outputs = record(completion.outputs);
    if (!outputs)
        return terminalFailure(
            "malformed",
            "Completion named outputs are missing.",
        );
    const expectedOutputNames = pending.expectedSteps.map(
        (step) => step.outputName,
    );
    if (
        stableJson(Object.keys(outputs).toSorted()) !==
        stableJson([...expectedOutputNames].toSorted())
    )
        return terminalFailure(
            "malformed",
            "Completion named output set does not match the expected verification groups.",
        );

    const structuredOutputs: Record<string, unknown> = {};
    for (const expected of pending.expectedSteps) {
        const result = record(completion.results[expected.resultIndex]);
        const output = record(outputs[expected.outputName]);
        if (
            !result ||
            result.agent !== expected.agent ||
            result.context !== "fresh" ||
            result.status !== "completed" ||
            result.success !== true ||
            result.exitCode !== 0 ||
            result.structuredOutput === undefined
        )
            return terminalFailure(
                "malformed",
                `Completion result ${expected.resultIndex} does not match expected agent ${expected.agent}.`,
            );
        if (
            !output ||
            output.agent !== expected.agent ||
            output.stepIndex !== expected.chainStepIndex ||
            output.structured === undefined ||
            stableJson(output.structured) !==
                stableJson(result.structuredOutput)
        )
            return terminalFailure(
                "malformed",
                `Completion named output ${expected.outputName} does not match result ${expected.resultIndex}.`,
            );
        structuredOutputs[expected.outputName] = result.structuredOutput;
    }
    return { kind: "complete", structuredOutputs };
}

export function readOwnedTerminalStatusArtifact(
    pending: PendingVerificationRun,
):
    | Exclude<OwnedTerminalCompletion, { kind: "unrelated" }>
    | { kind: "pending" } {
    const malformed = (reason: string) =>
        terminalFailure(
            "malformed",
            `Invalid verification status artifact: ${reason}`,
        );
    if (!isPendingVerificationRun(pending))
        return malformed("pending ownership metadata is invalid.");

    const expectedDir = resolvePath(pending.asyncDir);
    const asyncRoot = dirname(expectedDir);
    const scopeRoot = dirname(asyncRoot);
    const tempRoot = resolvePath(tmpdir());
    const statusPath = join(expectedDir, "status.json");
    try {
        const canonicalTempRoot = canonicalNonSymlinkDirectory(tempRoot);
        const canonicalScopeRoot = canonicalNonSymlinkDirectory(scopeRoot);
        const canonicalAsyncRoot = canonicalNonSymlinkDirectory(asyncRoot);
        const canonicalDir = canonicalNonSymlinkDirectory(expectedDir);
        if (
            !canonicalTempRoot ||
            !canonicalScopeRoot ||
            !canonicalAsyncRoot ||
            !canonicalDir ||
            dirname(canonicalScopeRoot) !== canonicalTempRoot ||
            dirname(canonicalAsyncRoot) !== canonicalScopeRoot ||
            dirname(canonicalDir) !== canonicalAsyncRoot
        )
            return malformed(
                "asyncDir is outside the trusted package temp hierarchy.",
            );
        const statusFile = lstatSync(statusPath);
        if (
            !statusFile.isFile() ||
            statusFile.isSymbolicLink() ||
            statusFile.size > 2 * 1024 * 1024
        )
            return malformed("status.json is not a bounded regular file.");
        if (dirname(realpathSync(statusPath)) !== canonicalDir)
            return malformed("status.json escapes its asyncDir.");

        const status = record(JSON.parse(readFileSync(statusPath, "utf8")));
        if (
            !status ||
            status.lifecycleArtifactVersion !== 3 ||
            status.runId !== pending.runId ||
            status.sessionId !== pending.ownerSessionId ||
            status.mode !== "chain" ||
            !Array.isArray(status.steps) ||
            status.steps.length !== pending.expectedSteps.length
        )
            return malformed(
                "lifecycle ownership or step metadata does not match.",
            );

        const steps = status.steps.map(record);
        if (
            steps.some((step, index) => {
                const expected = pending.expectedSteps[index];
                return (
                    !step ||
                    !expected ||
                    step.agent !== expected.agent ||
                    step.context !== "fresh" ||
                    step.outputName !== expected.outputName
                );
            })
        )
            return malformed("persisted step identity does not match.");

        if (status.state === "queued" || status.state === "running")
            return { kind: "pending" };
        if (
            !["complete", "failed", "paused", "stopped"].includes(
                String(status.state),
            )
        )
            return malformed("lifecycle state is unsupported.");

        const completion = parseOwnedTerminalCompletion(
            {
                runId: status.runId,
                sessionId: status.sessionId,
                success: status.state === "complete",
                state: status.state,
                exitCode: status.state === "complete" ? 0 : 1,
                ...(status.timedOut === true ? { timedOut: true } : {}),
                ...(typeof status.error === "string"
                    ? { error: status.error }
                    : {}),
                results: steps.map((step) => ({
                    agent: step!.agent,
                    context: step!.context,
                    status:
                        step!.status === "complete"
                            ? "completed"
                            : step!.status,
                    success:
                        step!.exitCode === 0 &&
                        (step!.status === "complete" ||
                            step!.status === "completed"),
                    exitCode: step!.exitCode,
                    structuredOutput: step!.structuredOutput,
                })),
                outputs: status.outputs,
            },
            pending,
        );
        return completion.kind === "unrelated"
            ? malformed("terminal ownership does not match.")
            : completion;
    } catch (error) {
        return malformed(
            error instanceof Error ? error.message : String(error),
        );
    }
}

export function createVerificationRpcClient(events: EventBusLike) {
    const pendingCalls = new Set<PendingCall>();
    const completionSubscriptions = new Set<CompletionSubscription>();
    let completionEvent = SUBAGENT_ASYNC_COMPLETE_EVENT;
    let disposed = false;

    function bindCompletion(subscription: CompletionSubscription): void {
        const registered = events.on(completionEvent, (data) =>
            subscription.handler(data),
        );
        subscription.unsubscribe =
            typeof registered === "function" ? registered : () => undefined;
    }

    function call(
        method: RpcMethod,
        params: unknown,
        timeoutMs: number,
    ): Promise<unknown> {
        if (disposed)
            return Promise.reject(
                new Error("Verification RPC client is disposed."),
            );
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
            return Promise.reject(
                new Error("Verification RPC timeout must be positive."),
            );

        const requestId = randomUUID();
        const replyEvent = `${SUBAGENT_RPC_REPLY_EVENT_PREFIX}${requestId}`;
        return new Promise((resolve, reject) => {
            let unsubscribe: (() => void) | undefined;
            let cancelTimer: () => void = () => undefined;
            const pending: PendingCall = {
                reject,
                cleanup: () => {
                    cancelTimer();
                    unsubscribe?.();
                    pendingCalls.delete(pending);
                },
            };
            const finish = (
                outcome:
                    | { ok: true; value: unknown }
                    | { ok: false; error: Error },
            ) => {
                pending.cleanup();
                if (outcome.ok) resolve(outcome.value);
                else reject(outcome.error);
            };

            const registered = events.on(replyEvent, (raw) => {
                const reply = record(raw);
                if (!reply)
                    return finish({
                        ok: false,
                        error: new Error(
                            "Malformed subagent RPC reply: expected an object.",
                        ),
                    });
                if (reply.version !== SUBAGENT_RPC_PROTOCOL_VERSION)
                    return finish({
                        ok: false,
                        error: new Error(
                            "Malformed subagent RPC reply: unsupported version.",
                        ),
                    });
                if (reply.requestId !== requestId)
                    return finish({
                        ok: false,
                        error: new Error(
                            "Malformed subagent RPC reply: requestId mismatch.",
                        ),
                    });
                if (reply.method !== method)
                    return finish({
                        ok: false,
                        error: new Error(
                            "Malformed subagent RPC reply: method mismatch.",
                        ),
                    });
                if (reply.success === false) {
                    const error = record(reply.error);
                    return finish({
                        ok: false,
                        error: new Error(
                            typeof error?.message === "string"
                                ? error.message
                                : "Subagent RPC request failed.",
                        ),
                    });
                }
                if (reply.success !== true)
                    return finish({
                        ok: false,
                        error: new Error(
                            "Malformed subagent RPC reply: success is required.",
                        ),
                    });
                return finish({ ok: true, value: reply.data });
            });
            unsubscribe =
                typeof registered === "function" ? registered : undefined;
            const timer = setTimeout(
                () =>
                    finish({
                        ok: false,
                        error: new Error(
                            `Subagent RPC ${method} timed out after ${timeoutMs}ms.`,
                        ),
                    }),
                timeoutMs,
            );
            cancelTimer = () => clearTimeout(timer);
            pendingCalls.add(pending);
            events.emit(SUBAGENT_RPC_REQUEST_EVENT, {
                version: SUBAGENT_RPC_PROTOCOL_VERSION,
                requestId,
                method,
                ...(params === undefined ? {} : { params }),
                source: { extension: "brainstorm-forcer" },
            });
        });
    }

    return {
        async ping(timeoutMs: number) {
            const data = record(await call("ping", undefined, timeoutMs));
            const methods = data?.methods;
            const eventNames = record(data?.events);
            if (
                data?.version !== SUBAGENT_RPC_PROTOCOL_VERSION ||
                !Array.isArray(methods) ||
                !methods.every((method) => typeof method === "string") ||
                !["ping", "spawn", "status"].every((method) =>
                    methods.includes(method),
                ) ||
                eventNames?.replyPrefix !== SUBAGENT_RPC_REPLY_EVENT_PREFIX
            )
                throw new Error(
                    "Malformed subagent RPC ping response for protocol v1.",
                );
            const advertisedCompletionEvent = text(
                eventNames.asyncComplete,
                "events.asyncComplete",
            );
            if (advertisedCompletionEvent !== completionEvent) {
                completionEvent = advertisedCompletionEvent;
                for (const subscription of completionSubscriptions) {
                    subscription.unsubscribe();
                    bindCompletion(subscription);
                }
            }
            const session = record(data.session);
            return {
                methods: [...methods] as string[],
                ...(typeof session?.sessionId === "string"
                    ? { sessionId: session.sessionId }
                    : {}),
                asyncCompleteEvent: completionEvent,
            };
        },
        async spawn(input: VerificationSpawnInput, timeoutMs: number) {
            const data = record(
                await call(
                    "spawn",
                    {
                        chain: input.chain,
                        async: true,
                        context: "fresh",
                        clarify: false,
                    },
                    timeoutMs,
                ),
            );
            const details = record(data?.details);
            const runId = text(details?.runId, "details.runId");
            const asyncDir = text(details?.asyncDir, "details.asyncDir");
            return {
                runId,
                asyncDir,
            };
        },
        async status(runId: string, timeoutMs: number) {
            const data = record(
                await call(
                    "status",
                    { runId: text(runId, "runId") },
                    timeoutMs,
                ),
            );
            if (typeof data?.text !== "string" || !record(data.details))
                throw new Error("Malformed subagent RPC status response.");
            return { text: data.text, details: data.details };
        },
        onAsyncComplete(handler: (data: unknown) => void): () => void {
            if (disposed)
                throw new Error("Verification RPC client is disposed.");
            const subscription: CompletionSubscription = {
                handler,
                unsubscribe: () => undefined,
            };
            bindCompletion(subscription);
            completionSubscriptions.add(subscription);
            return () => {
                subscription.unsubscribe();
                completionSubscriptions.delete(subscription);
            };
        },
        dispose(): void {
            if (disposed) return;
            disposed = true;
            for (const pending of pendingCalls) {
                pending.cleanup();
                pending.reject(new Error("Verification RPC client disposed."));
            }
            for (const subscription of completionSubscriptions)
                subscription.unsubscribe();
            completionSubscriptions.clear();
        },
    };
}
