import type { Readable } from "node:stream";

import { SandboxExecutionError } from "./contracts.ts";

export const MAX_STATUS_LINE_BYTES = 16_384;
export const MAX_STATUS_EVENTS = 4;

interface Deferred {
    promise: Promise<void>;
    resolve(): void;
    reject(error: unknown): void;
}

function deferred(): Deferred {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
    });
    return { promise, resolve, reject };
}

function protocolError(cause?: unknown): SandboxExecutionError {
    return new SandboxExecutionError("protocol-error", { cause });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function superviseZeroboxStatusStream(stream: Readable): {
    ready: Promise<void>;
    settled: Promise<void>;
} {
    const ready = deferred();
    const settled = deferred();
    let readyState: "pending" | "resolved" | "rejected" = "pending";
    let settledState: "pending" | "resolved" | "rejected" = "pending";
    let buffer = Buffer.alloc(0);
    let eventCount = 0;
    let started = false;
    let terminal = false;
    let setupFailure: SandboxExecutionError | undefined;
    let channelFailure: SandboxExecutionError | undefined;

    const resolveReady = () => {
        if (readyState !== "pending") return;
        readyState = "resolved";
        ready.resolve();
    };
    const rejectReady = (error: SandboxExecutionError) => {
        if (readyState !== "pending") return;
        readyState = "rejected";
        ready.reject(error);
    };
    const rejectSettled = (error: SandboxExecutionError) => {
        if (settledState !== "pending") return;
        settledState = "rejected";
        settled.reject(error);
    };
    const failProtocol = (cause?: unknown) => {
        const error = protocolError(cause);
        rejectReady(error);
        rejectSettled(error);
    };

    const processLine = (line: Buffer) => {
        if (settledState !== "pending") return;
        if (line.byteLength === 0) {
            failProtocol(new Error("Empty status record"));
            return;
        }
        eventCount += 1;
        if (eventCount > MAX_STATUS_EVENTS) {
            failProtocol(new Error("Too many status events"));
            return;
        }
        let value: unknown;
        try {
            value = JSON.parse(line.toString("utf8"));
        } catch (error) {
            failProtocol(error);
            return;
        }
        if (
            !isRecord(value) ||
            value.version !== 1 ||
            typeof value.event !== "string"
        ) {
            failProtocol(new Error("Invalid status record"));
            return;
        }
        if (terminal) {
            failProtocol(new Error("Status event after terminal event"));
            return;
        }

        if (value.event === "setup_error") {
            if (
                started ||
                typeof value.code !== "string" ||
                typeof value.message !== "string"
            ) {
                failProtocol(new Error("Invalid setup_error event"));
                return;
            }
            terminal = true;
            setupFailure = new SandboxExecutionError("setup-failed", {
                cause: new Error(`[${value.code}] ${value.message}`),
            });
            rejectReady(setupFailure);
            return;
        }
        if (value.event === "child_started") {
            if (
                started ||
                !Number.isSafeInteger(value.pid) ||
                (value.pid as number) <= 0 ||
                value.pid_scope !== "supervisor"
            ) {
                failProtocol(new Error("Invalid child_started event"));
                return;
            }
            started = true;
            resolveReady();
            return;
        }
        if (value.event === "child_exit") {
            if (
                !started ||
                !Number.isSafeInteger(value.code) ||
                (value.code as number) < 0 ||
                (value.code as number) > 255 ||
                (value.signal !== undefined &&
                    (!Number.isSafeInteger(value.signal) ||
                        (value.signal as number) <= 0))
            ) {
                failProtocol(new Error("Invalid child_exit event"));
                return;
            }
            terminal = true;
            return;
        }
        failProtocol(new Error("Unknown status event"));
    };

    const onData = (chunk: Buffer | string) => {
        if (settledState !== "pending") return;
        buffer = Buffer.concat([
            buffer,
            typeof chunk === "string" ? Buffer.from(chunk) : chunk,
        ]);
        if (
            buffer.byteLength > MAX_STATUS_LINE_BYTES &&
            !buffer.includes(0x0a)
        ) {
            failProtocol(new Error("Status line exceeds byte limit"));
            return;
        }
        let newline = buffer.indexOf(0x0a);
        while (newline !== -1 && settledState === "pending") {
            const current = buffer.subarray(0, newline);
            buffer = buffer.subarray(newline + 1);
            if (current.byteLength > MAX_STATUS_LINE_BYTES) {
                failProtocol(new Error("Status line exceeds byte limit"));
                return;
            }
            processLine(current);
            newline = buffer.indexOf(0x0a);
        }
    };

    const onEnd = () => {
        if (settledState !== "pending") return;
        if (channelFailure) {
            rejectSettled(channelFailure);
            return;
        }
        if (buffer.byteLength > 0) {
            failProtocol(new Error("Status channel ended mid-record"));
            return;
        }
        if (!terminal) {
            failProtocol(
                new Error("Status channel ended before terminal event"),
            );
            return;
        }
        if (setupFailure) {
            rejectSettled(setupFailure);
            return;
        }
        if (!started) {
            failProtocol(new Error("Terminal event without child start"));
            return;
        }
        settledState = "resolved";
        settled.resolve();
    };
    const onError = (error: Error) => {
        channelFailure = protocolError(error);
        rejectReady(channelFailure);
        // Bun implements extra child-process pipes with a lazily connected
        // Unix socket. A failed connection does not reliably emit `close`
        // until the readable is explicitly destroyed; settled must still
        // represent a fully drained/closed status channel before lease cleanup.
        stream.destroy();
    };
    const onClose = () => {
        if (settledState === "pending" && channelFailure) {
            rejectSettled(channelFailure);
            return;
        }
        if (settledState === "pending" && !stream.readableEnded) {
            failProtocol(new Error("Status channel closed before EOF"));
        }
    };

    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
    stream.once("close", onClose);

    return { ready: ready.promise, settled: settled.promise };
}
