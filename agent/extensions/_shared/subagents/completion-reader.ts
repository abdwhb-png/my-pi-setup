import {
    closeSync,
    constants,
    fstatSync,
    lstatSync,
    openSync,
    readFileSync,
    realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
    dirname,
    isAbsolute,
    join,
    parse,
    relative,
    resolve,
    sep,
} from "node:path";
import { parseSessionEntries } from "@earendil-works/pi-coding-agent";
import type { RunRef } from "./integration.ts";
import type { SubagentAsyncCompletion } from "./rpc-client.ts";

function record(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** File protocol of pi-subagents 0.73.1. No directory scans, prefix lookup or execution-state reconstruction. */
export function nativeArtifactRoot(): string {
    if (process.env.PI_SUBAGENTS_TEMP_ROOT?.trim())
        return resolve(process.env.PI_SUBAGENTS_TEMP_ROOT.trim());
    if (process.getuid)
        return join(tmpdir(), `pi-subagents-uid-${process.getuid()}`);
    throw new Error(
        "Subagent artifact inspection requires PI_SUBAGENTS_TEMP_ROOT on this platform.",
    );
}

function readText(root: string, path: string): string | undefined {
    const distance = relative(root, resolve(path));
    if (
        isAbsolute(distance) ||
        distance.startsWith(`..${sep}`) ||
        distance === ".." ||
        resolve(path) === root
    )
        throw new Error("Subagent artifact escapes its root.");
    try {
        let cursor = resolve(path);
        while (cursor !== root) {
            if (lstatSync(cursor).isSymbolicLink())
                throw new Error("Subagent artifact uses a symbolic link.");
            cursor = dirname(cursor);
        }
        const physicalDistance = relative(
            realpathSync(root),
            realpathSync(path),
        );
        if (
            isAbsolute(physicalDistance) ||
            physicalDistance === ".." ||
            physicalDistance.startsWith(`..${sep}`)
        )
            throw new Error("Subagent artifact escapes its physical root.");
        const descriptor = openSync(
            path,
            constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        try {
            const stat = fstatSync(descriptor);
            if (!stat.isFile() || stat.size > 1_048_576)
                throw new Error(
                    "Subagent artifact is not a bounded regular file.",
                );
            return readFileSync(descriptor, "utf8");
        } finally {
            closeSync(descriptor);
        }
    } catch (error) {
        if (record(error) && error.code === "ENOENT") return undefined;
        throw error;
    }
}

function readJson(root: string, path: string): unknown {
    const text = readText(root, path);
    return text === undefined ? undefined : JSON.parse(text);
}

/** These paths come only from a run/session-validated engine publication, never a caller-supplied run reference. */
function publishedText(path: string): string {
    if (!isAbsolute(path))
        throw new Error(
            "Published subagent output reference must be absolute.",
        );
    const text = readText(parse(path).root, path);
    if (text === undefined)
        throw new Error("Published subagent output reference is unavailable.");
    return text;
}

export function readOwnedCompletion(
    ref: RunRef,
    artifactRoot: string,
): { state?: string; completion?: SubagentAsyncCompletion } {
    const root = resolve(artifactRoot);
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(ref.runId))
        throw new Error(
            "Subagent artifact lookup requires an exact run identity.",
        );
    const runDir = join(root, "async-subagent-runs", ref.runId);
    const status = readJson(root, join(runDir, "status.json"));
    if (
        status !== undefined &&
        (!record(status) ||
            status.runId !== ref.runId ||
            status.sessionId !== ref.sessionId)
    )
        throw new Error(
            "Subagent status artifact belongs to another run or session.",
        );
    const payload = readJson(
        root,
        join(root, "async-subagent-results", `${ref.runId}.json`),
    );
    let raw: Record<string, unknown> | undefined;
    if (payload !== undefined) {
        if (
            !record(payload) ||
            (payload.runId ?? payload.id) !== ref.runId ||
            payload.sessionId !== ref.sessionId
        )
            throw new Error(
                "Subagent result artifact belongs to another run or session.",
            );
        raw = payload;
    } else {
        const replay = readJson(
            root,
            join(
                root,
                "async-subagent-results",
                "completion-replay",
                `${encodeURIComponent(ref.runId)}.json`,
            ),
        );
        if (replay !== undefined) {
            if (
                !record(replay) ||
                replay.version !== 1 ||
                replay.runId !== ref.runId ||
                replay.sessionId !== ref.sessionId ||
                !record(replay.completion) ||
                replay.completion.runId !== ref.runId ||
                typeof replay.expiresAt !== "number"
            )
                throw new Error(
                    "Subagent completion replay has an unsupported contract or belongs to another session.",
                );
            if (replay.expiresAt > Date.now()) raw = replay.completion;
        }
    }
    const state =
        record(status) && typeof status.state === "string"
            ? status.state
            : undefined;
    if (!raw) return { state };
    if (
        typeof raw.success !== "boolean" ||
        (raw.results !== undefined && !Array.isArray(raw.results))
    )
        throw new Error("Malformed subagent terminal artifact.");
    const children: readonly unknown[] = Array.isArray(raw.results)
        ? raw.results
        : [];
    const results: Record<string, unknown>[] = [];
    for (const child of children) {
        if (!record(child))
            throw new Error("Malformed subagent child artifact.");
        results.push({ ...child });
    }
    for (const child of results) {
        if (
            !Object.hasOwn(child, "structuredOutput") &&
            typeof child.structuredOutputPath === "string"
        )
            child.structuredOutput = JSON.parse(
                publishedText(child.structuredOutputPath),
            );
    }
    const archive = readJson(
        root,
        join(
            root,
            "async-subagent-results",
            "output-archives",
            `${encodeURIComponent(ref.runId)}.json`,
        ),
    );
    if (archive !== undefined) {
        if (
            !record(archive) ||
            archive.version !== 1 ||
            archive.runId !== ref.runId ||
            !Array.isArray(archive.entries)
        )
            throw new Error("Unsupported subagent output archive.");
        const entries: readonly unknown[] = archive.entries;
        for (const entry of entries) {
            if (!record(entry))
                throw new Error("Malformed subagent archive entry.");
            const child =
                typeof entry.resultIndex === "number" &&
                Number.isSafeInteger(entry.resultIndex)
                    ? results[entry.resultIndex]
                    : undefined;
            if (
                !child ||
                Object.hasOwn(child, "structuredOutput") ||
                typeof child.output === "string"
            )
                continue;
            if (
                entry.source === "result-tail" &&
                typeof entry.text === "string"
            )
                child.output = entry.text;
            else if (
                entry.source === "output-artifact" &&
                typeof entry.path === "string"
            )
                child.output = publishedText(entry.path);
            else if (
                entry.source === "session" &&
                typeof entry.path === "string"
            ) {
                for (const message of parseSessionEntries(
                    publishedText(entry.path),
                )) {
                    if (
                        message.type === "message" &&
                        message.message.role === "assistant"
                    ) {
                        const text = message.message.content
                            .filter((block) => block.type === "text")
                            .map((block) => block.text)
                            .join("\n");
                        if (text) child.output = text;
                    }
                }
            } else throw new Error("Unsupported subagent archive reference.");
        }
    }
    const receipt = readJson(root, join(runDir, "workflow-receipt.json"));
    if (receipt !== undefined) {
        if (
            !record(receipt) ||
            receipt.version !== 1 ||
            receipt.workflowRunId !== ref.runId ||
            !record(receipt.entries)
        )
            throw new Error("Unsupported subagent workflow receipt.");
        for (const child of results) {
            const keys = Object.entries(receipt.entries)
                .filter(
                    ([, entry]) =>
                        record(entry) &&
                        typeof child.runId === "string" &&
                        entry.latestRunId === child.runId,
                )
                .map(([key]) => key);
            if (keys.length > 1)
                throw new Error(
                    "Subagent workflow receipt has ambiguous child ownership.",
                );
            if (keys.length === 1 && child.workflowKey === undefined)
                child.workflowKey = keys[0];
        }
    }
    // Native replay omits child outcome fields. Restore only from the owned
    // status step whose run, workflow key or transcript identifies this child.
    const statusSteps: readonly unknown[] =
        record(status) && Array.isArray(status.steps) ? status.steps : [];
    for (const child of results) {
        if (
            child.status !== undefined ||
            child.interrupted === true ||
            child.stopped === true ||
            child.timedOut === true
        )
            continue;
        const matches = statusSteps.filter((step) => {
            if (!record(step)) return false;
            const single =
                record(status) &&
                status.mode === "single" &&
                statusSteps.length === 1 &&
                results.length === 1 &&
                (child.runId === undefined || child.runId === ref.runId) &&
                typeof child.agent === "string" &&
                step.agent === child.agent;
            if (typeof child.runId === "string")
                return (
                    step.runId === child.runId ||
                    step.childId === child.runId ||
                    single
                );
            if (typeof child.workflowKey === "string")
                return step.workflowKey === child.workflowKey;
            if (typeof child.sessionFile === "string")
                return step.sessionFile === child.sessionFile;
            return single;
        });
        if (matches.length > 1)
            throw new Error("Subagent status has ambiguous child ownership.");
        const step = matches[0];
        if (
            record(step) &&
            [
                "complete",
                "completed",
                "failed",
                "partial",
                "paused",
                "stopped",
                "rejected",
            ].includes(String(step.status))
        ) {
            child.status = step.status;
            if (step.timedOut === true) child.timedOut = true;
            if (step.stopped === true) child.stopped = true;
        }
    }
    return {
        state,
        completion: {
            ...raw,
            ...(raw.state === undefined && state ? { state } : {}),
            id: ref.runId,
            sessionId: ref.sessionId,
            results,
        },
    };
}
