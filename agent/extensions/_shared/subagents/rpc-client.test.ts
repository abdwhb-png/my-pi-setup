import { describe, expect, it } from "bun:test";
import {
    SUBAGENT_ASYNC_COMPLETE_EVENT,
    SUBAGENT_RPC_PROTOCOL_VERSION,
    SUBAGENT_RPC_REPLY_EVENT_PREFIX,
    SUBAGENT_RPC_REQUEST_EVENT,
    SubagentRpcClient,
    SubagentRpcError,
    type SubagentRpcEventBus,
} from "./rpc-client";

class FakeEventBus implements SubagentRpcEventBus {
    readonly emitted: Array<{ event: string; data: unknown }> = [];
    private readonly handlers = new Map<
        string,
        Set<(data: unknown) => void>
    >();

    on(event: string, handler: (data: unknown) => void): () => void {
        const handlers = this.handlers.get(event) ?? new Set();
        handlers.add(handler);
        this.handlers.set(event, handlers);
        return () => handlers.delete(handler);
    }

    emit(event: string, data: unknown): void {
        this.emitted.push({ event, data });
        for (const handler of this.handlers.get(event) ?? []) handler(data);
    }

    listenerCount(event: string): number {
        return this.handlers.get(event)?.size ?? 0;
    }
}

function reply(
    events: FakeEventBus,
    requestId: string,
    method:
        | "ping"
        | "spawn"
        | "status"
        | "manage"
        | "steer"
        | "interrupt"
        | "stop"
        | "resume",
    data: unknown,
): void {
    events.emit(`${SUBAGENT_RPC_REPLY_EVENT_PREFIX}${requestId}`, {
        version: SUBAGENT_RPC_PROTOCOL_VERSION,
        requestId,
        method,
        success: true,
        data,
    });
}

describe("shared pi-subagents RPC client", () => {
    it("sends attributed requests and resolves only exact replies", async () => {
        const events = new FakeEventBus();
        const ids = ["request-1", "request-2"];
        const client = new SubagentRpcClient(events, {
            sourceExtension: "brainstorm-forcer",
            requestId: () => ids.shift()!,
        });

        const spawn = client.spawn({ agent: "brainstorm-scout", task: "Inspect." });
        expect(events.emitted.at(-1)).toEqual({
            event: SUBAGENT_RPC_REQUEST_EVENT,
            data: {
                version: 1,
                requestId: "request-1",
                method: "spawn",
                params: { agent: "brainstorm-scout", task: "Inspect." },
                source: { extension: "brainstorm-forcer" },
            },
        });

        events.emit(`${SUBAGENT_RPC_REPLY_EVENT_PREFIX}request-2`, {
            version: 1,
            requestId: "request-2",
            method: "spawn",
            success: true,
            data: { details: { asyncId: "wrong" } },
        });
        reply(events, "request-1", "spawn", {
            details: { asyncId: "native-run-1" },
        });

        await expect(spawn).resolves.toEqual({
            text: "",
            details: { asyncId: "native-run-1" },
        });
        client.dispose();
    });

    it("exposes ping, status, and stop through the same bounded contract", async () => {
        const events = new FakeEventBus();
        const ids = [
            "ping-1",
            "status-1",
            "manage-1",
            "steer-1",
            "interrupt-1",
            "resume-1",
            "stop-1",
        ];
        const client = new SubagentRpcClient(events, {
            sourceExtension: "test-extension",
            requestId: () => ids.shift()!,
        });

        const ping = client.ping();
        reply(events, "ping-1", "ping", {
            capabilities: { events: { asyncComplete: "subagent:async-complete" } },
        });
        await expect(ping).resolves.toMatchObject({ capabilities: expect.any(Object) });

        const status = client.status({ id: "native-run" });
        reply(events, "status-1", "status", { text: "running" });
        await expect(status).resolves.toEqual({ text: "running" });

        const manage = client.manage({ action: "schedule.list" });
        reply(events, "manage-1", "manage", { text: "scheduled" });
        await expect(manage).resolves.toEqual({ text: "scheduled" });

        const steer = client.steer({ id: "native-run", message: "Continue." });
        reply(events, "steer-1", "steer", { text: "steered" });
        await expect(steer).resolves.toEqual({ text: "steered" });

        const interrupt = client.interrupt({ id: "native-run" });
        reply(events, "interrupt-1", "interrupt", { text: "interrupted" });
        await expect(interrupt).resolves.toEqual({ text: "interrupted" });

        const resume = client.resume({ id: "native-run", message: "Resume." });
        reply(events, "resume-1", "resume", { text: "resumed" });
        await expect(resume).resolves.toEqual({ text: "resumed" });

        const stop = client.stop({ id: "native-run" });
        reply(events, "stop-1", "stop", { text: "stopped" });
        await expect(stop).resolves.toEqual({ text: "stopped" });
        client.dispose();
    });

    it("publishes only valid async completion payloads to subscribers", () => {
        const events = new FakeEventBus();
        const client = new SubagentRpcClient(events, {
            sourceExtension: "brainstorm-forcer",
        });
        const received: unknown[] = [];
        const unsubscribe = client.onAsyncComplete((completion) =>
            received.push(completion),
        );

        events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, { id: "" });
        events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
            id: "native-run-1",
            sessionId: "session-1",
            success: true,
            results: [{ workflowKey: "verify", structuredOutput: { ok: true } }],
        });

        expect(received).toEqual([
            {
                id: "native-run-1",
                sessionId: "session-1",
                success: true,
                results: [
                    {
                        workflowKey: "verify",
                        structuredOutput: { ok: true },
                    },
                ],
            },
        ]);
        unsubscribe();
        client.dispose();
        expect(events.listenerCount(SUBAGENT_ASYNC_COMPLETE_EVENT)).toBe(0);
    });

    it("rejects malformed replies, aborts requests, and disposes pending work", async () => {
        const malformedEvents = new FakeEventBus();
        const malformed = new SubagentRpcClient(malformedEvents, {
            sourceExtension: "test-extension",
            requestId: () => "malformed-1",
        });
        const malformedRequest = malformed.ping();
        malformedEvents.emit(`${SUBAGENT_RPC_REPLY_EVENT_PREFIX}malformed-1`, {
            version: 2,
            requestId: "malformed-1",
            method: "ping",
            success: true,
        });
        await expect(malformedRequest).rejects.toBeInstanceOf(SubagentRpcError);
        malformed.dispose();

        const abortEvents = new FakeEventBus();
        const abortClient = new SubagentRpcClient(abortEvents, {
            sourceExtension: "test-extension",
            requestId: () => "abort-1",
        });
        const controller = new AbortController();
        const aborted = abortClient.status({}, { signal: controller.signal });
        controller.abort();
        await expect(aborted).rejects.toMatchObject({ code: "aborted" });
        abortClient.dispose();

        const disposeEvents = new FakeEventBus();
        const disposeClient = new SubagentRpcClient(disposeEvents, {
            sourceExtension: "test-extension",
            requestId: () => "dispose-1",
        });
        const pending = disposeClient.ping();
        disposeClient.dispose();
        await expect(pending).rejects.toMatchObject({ code: "disposed" });
        await expect(disposeClient.ping()).rejects.toMatchObject({
            code: "disposed",
        });
    });
});
