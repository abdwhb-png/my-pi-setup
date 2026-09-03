import { describe, expect, it } from "bun:test";
import {
    SUBAGENT_ASYNC_COMPLETE_EVENT,
    SUBAGENT_RPC_REPLY_EVENT_PREFIX,
    SUBAGENT_RPC_REQUEST_EVENT,
} from "../_shared/subagents/rpc-client";
import { createResearchRunner } from "./research-runner";

function createEvents() {
    const listeners = new Map<string, Set<(value: unknown) => void>>();
    const emitted: Array<{ event: string; data: unknown }> = [];
    return {
        emitted,
        on(event: string, handler: (value: unknown) => void) {
            const handlers = listeners.get(event) ?? new Set();
            handlers.add(handler);
            listeners.set(event, handlers);
            return () => handlers.delete(handler);
        },
        emit(event: string, data: unknown) {
            emitted.push({ event, data });
            for (const handler of listeners.get(event) ?? []) handler(data);
        },
    };
}

function installRpc(events: ReturnType<typeof createEvents>): void {
    let nextRun = 0;
    events.on(SUBAGENT_RPC_REQUEST_EVENT, (value) => {
        const request = value as {
            requestId: string;
            method: string;
        };
        nextRun += 1;
        queueMicrotask(() =>
            events.emit(`${SUBAGENT_RPC_REPLY_EVENT_PREFIX}${request.requestId}`, {
                version: 1,
                requestId: request.requestId,
                method: request.method,
                success: true,
                data: {
                    text: `started native-research-${nextRun}`,
                    details: { asyncId: `native-research-${nextRun}` },
                },
            }),
        );
    });
}

const validResult = {
    summary: "Found root selection.",
    findings: [
        {
            finding: "Discovery topic selects root.",
            sourceRefs: ["index.ts:700"],
        },
    ],
    gaps: [],
};

describe("brainstorm research runner", () => {
    it("spawns routed research through native async pi-subagents", async () => {
        const events = createEvents();
        installRpc(events);
        const runner = createResearchRunner(events);

        const receipt = await runner.start({
            ownerRunId: "brainstorm-1",
            cwd: "/tmp/project",
            input: {
                domain: "local-code",
                question: "Where is root selected?",
                sources: ["index.ts"],
            },
        });

        const rpcRequest = events.emitted.find(
            ({ event }) => event === SUBAGENT_RPC_REQUEST_EVENT,
        )!.data as Record<string, any>;
        expect(rpcRequest).toMatchObject({
            method: "spawn",
            source: { extension: "brainstorm-forcer" },
            params: {
                agent: "brainstorm-scout",
                context: "fresh",
                cwd: "/tmp/project",
                artifacts: false,
                outputSchema: expect.any(Object),
            },
        });
        expect(rpcRequest.params.task).toContain("Where is root selected?");
        expect(receipt).toEqual({
            runId: "native-research-1",
            agent: "brainstorm-scout",
        });
        runner.dispose();
    });

    it("emits one correlated validated terminal result", async () => {
        const events = createEvents();
        installRpc(events);
        const runner = createResearchRunner(events);
        const completions: unknown[] = [];
        runner.onComplete((completion) => completions.push(completion));
        const receipt = await runner.start({
            ownerRunId: "brainstorm-1",
            cwd: "/tmp/project",
            input: {
                domain: "local-code",
                question: "Where is root selected?",
                sources: ["index.ts"],
            },
        });

        events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
            id: "other-run",
            success: true,
            results: [{ agent: "brainstorm-scout", structuredOutput: validResult }],
        });
        events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
            id: receipt.runId,
            success: true,
            results: [
                {
                    agent: "brainstorm-scout",
                    status: "completed",
                    success: true,
                    structuredOutput: validResult,
                },
            ],
        });
        events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
            id: receipt.runId,
            success: true,
            results: [{ agent: "brainstorm-scout", structuredOutput: validResult }],
        });

        expect(completions).toEqual([
            {
                runId: receipt.runId,
                terminal: { kind: "complete", result: validResult },
            },
        ]);
        runner.dispose();
    });

    it("turns malformed structured output into a terminal failure", async () => {
        const events = createEvents();
        installRpc(events);
        const runner = createResearchRunner(events);
        const completions: any[] = [];
        runner.onComplete((completion) => completions.push(completion));
        const receipt = await runner.start({
            ownerRunId: "brainstorm-2",
            cwd: "/tmp/project",
            input: {
                domain: "external",
                question: "What is guaranteed?",
                sources: [],
            },
        });

        events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
            id: receipt.runId,
            success: true,
            results: [
                {
                    agent: "factual-researcher",
                    structuredOutput: {
                        summary: "No sources.",
                        findings: [{ finding: "Unsupported", sourceRefs: [] }],
                        gaps: [],
                    },
                },
            ],
        });

        expect(completions).toHaveLength(1);
        expect(completions[0]).toMatchObject({
            runId: receipt.runId,
            terminal: { kind: "failure" },
        });
        expect(completions[0].terminal.reason).toContain("source reference");
        runner.dispose();
    });

    it("stops native research through RPC", async () => {
        const events = createEvents();
        installRpc(events);
        const runner = createResearchRunner(events);

        await runner.stop("native-research-1");

        const stop = events.emitted.find(
            ({ event, data }) =>
                event === SUBAGENT_RPC_REQUEST_EVENT &&
                (data as { method?: string }).method === "stop",
        )!.data;
        expect(stop).toMatchObject({
            method: "stop",
            params: { id: "native-research-1" },
        });
        runner.dispose();
    });
});
