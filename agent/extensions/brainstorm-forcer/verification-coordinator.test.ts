import { describe, expect, it } from "bun:test";
import {
    SUBAGENT_ASYNC_COMPLETE_EVENT,
    SUBAGENT_RPC_REPLY_EVENT_PREFIX,
    SUBAGENT_RPC_REQUEST_EVENT,
} from "../_shared/subagents/rpc-client";
import {
    createVerificationCoordinator,
    type EventBusLike,
    type VerificationDelegationNode,
} from "./verification-runner";

function createEvents() {
    const listeners = new Map<string, Set<(data: unknown) => void>>();
    const emitted: Array<{ event: string; data: unknown }> = [];
    const events: EventBusLike = {
        on(event, handler) {
            const current = listeners.get(event) ?? new Set();
            current.add(handler);
            listeners.set(event, current);
            return () => current.delete(handler);
        },
        emit(event, data) {
            emitted.push({ event, data });
            for (const handler of listeners.get(event) ?? []) handler(data);
        },
    };
    return { events, emitted };
}

const schema = {
    type: "object",
    properties: { outcome: { type: "string" } },
    required: ["outcome"],
    additionalProperties: false,
} as const;

function verifier(
    outputName: string,
    agent = "brainstorm-scout",
): VerificationDelegationNode {
    return {
        role: "verifier",
        outputName,
        agent,
        task: `Verify ${outputName}.`,
        schema,
    };
}

function architect(): VerificationDelegationNode {
    return {
        role: "architect",
        outputName: "architecture_advisory",
        agent: "architect",
        task: "Assess {outputs.first} and {outputs.second}.",
        schema,
    };
}

function installRpc(
    bridge: ReturnType<typeof createEvents>,
    asyncId = "native-verification-1",
    options: {
        stopResult?: { text: string; isError?: boolean };
        onStopRequest?: () => void;
    } = {},
): void {
    bridge.events.on(SUBAGENT_RPC_REQUEST_EVENT, (value) => {
        const request = value as { requestId: string; method: string };
        if (request.method === "stop") options.onStopRequest?.();
        queueMicrotask(() =>
            bridge.events.emit(
                `${SUBAGENT_RPC_REPLY_EVENT_PREFIX}${request.requestId}`,
                {
                    version: 1,
                    requestId: request.requestId,
                    method: request.method,
                    success: true,
                    data:
                        request.method === "stop" && options.stopResult
                            ? options.stopResult
                            : {
                                  text: "started",
                                  details: { asyncId },
                              },
                },
            ),
        );
    });
}

function spawnRequest(bridge: ReturnType<typeof createEvents>) {
    return bridge.emitted.find(
        ({ event, data }) =>
            event === SUBAGENT_RPC_REQUEST_EVENT &&
            (data as { method?: string }).method === "spawn",
    )!.data as Record<string, any>;
}

describe("native verification coordinator", () => {
    it("spawns one native async workflow with parallel verifiers then architect", async () => {
        const bridge = createEvents();
        installRpc(bridge);
        const coordinator = createVerificationCoordinator(bridge.events);

        const receipt = await coordinator.start({
            ownerRunId: "brainstorm-run",
            sessionId: "session-current",
            sessionFile: "/tmp/session-current.jsonl",
            cwd: "/repo",
            label: "Brainstorm verification",
            nodes: [verifier("first"), verifier("second", "pi-expert"), architect()],
        });

        expect(receipt).toEqual({ runId: "native-verification-1" });
        const request = spawnRequest(bridge);
        expect(request).toMatchObject({
            source: { extension: "brainstorm-forcer" },
            method: "spawn",
            params: {
                cwd: "/repo",
                context: "fresh",
                artifacts: true,
                mission: false,
            },
        });
        const workflowScript = request.params.workflowScript as string;
        expect(typeof workflowScript).toBe("string");
        expect(workflowScript).toContain("runs.all");
        expect(workflowScript).toContain("runs.run");
        expect(workflowScript).toContain("brainstorm-scout");
        expect(workflowScript).toContain("pi-expert");
        expect(workflowScript).toContain("architect");
        expect(workflowScript).toContain('"extensionBindings"');
        expect(workflowScript).toContain('"tool-groups.policy/1"');
        expect(workflowScript).toContain('"allowedTools"');
        expect(workflowScript).toContain('"structured_output"');
        expect(workflowScript.indexOf("runs.all")).toBeLessThan(
            workflowScript.indexOf("runs.run"),
        );
        coordinator.dispose();
    });

    it("maps correlated native child outputs to existing terminal contract", async () => {
        const bridge = createEvents();
        installRpc(bridge);
        const coordinator = createVerificationCoordinator(bridge.events);
        const completions: unknown[] = [];
        coordinator.onComplete((completion) => completions.push(completion));
        const receipt = await coordinator.start({
            ownerRunId: "brainstorm-run",
            sessionId: "session-current",
            sessionFile: "/tmp/session-current.jsonl",
            cwd: "/repo",
            label: "Brainstorm verification",
            nodes: [verifier("first"), verifier("second", "pi-expert"), architect()],
        });
        const first = { outcome: "supported" };
        const second = { outcome: "falsified" };
        const advisory = { status: "watch" };

        bridge.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
            id: "unrelated-run",
            success: true,
            results: [],
        });
        bridge.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
            id: receipt.runId,
            success: true,
            results: [
                {
                    workflowKey: "first",
                    agent: "brainstorm-scout",
                    status: "completed",
                    success: true,
                    structuredOutput: first,
                },
                {
                    workflowKey: "second",
                    agent: "pi-expert",
                    status: "completed",
                    success: true,
                    structuredOutput: second,
                },
                {
                    workflowKey: "architecture_advisory",
                    agent: "architect",
                    status: "completed",
                    success: true,
                    structuredOutput: advisory,
                },
            ],
        });

        expect(completions).toEqual([
            {
                runId: receipt.runId,
                terminal: {
                    kind: "complete",
                    structuredOutputs: {
                        first,
                        second,
                        architecture_advisory: advisory,
                    },
                },
            },
        ]);
        expect(coordinator.status(receipt.runId)).toMatchObject({
            state: "completed",
            activeRequests: 0,
        });
        coordinator.dispose();
    });

    it("preserves verifier outputs when only architect fails", async () => {
        const bridge = createEvents();
        installRpc(bridge);
        const coordinator = createVerificationCoordinator(bridge.events);
        const completions: any[] = [];
        coordinator.onComplete((completion) => completions.push(completion));
        const receipt = await coordinator.start({
            ownerRunId: "brainstorm-run",
            sessionId: "session-current",
            sessionFile: "/tmp/session-current.jsonl",
            cwd: "/repo",
            label: "Brainstorm verification",
            nodes: [verifier("first"), architect()],
        });
        const first = { outcome: "supported" };

        bridge.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
            id: receipt.runId,
            success: false,
            summary: "architect failed",
            results: [
                {
                    workflowKey: "first",
                    agent: "brainstorm-scout",
                    status: "completed",
                    success: true,
                    structuredOutput: first,
                },
                {
                    workflowKey: "architecture_advisory",
                    agent: "architect",
                    status: "failed",
                    success: false,
                    output: "architect failed",
                },
            ],
        });

        expect(completions[0]).toEqual({
            runId: receipt.runId,
            terminal: {
                kind: "failure",
                failureKind: "failed",
                reason: "architect failed",
                completedStructuredOutputs: { first },
                failedAdvisoryOutputName: "architecture_advisory",
            },
        });
        coordinator.dispose();
    });

    it("reattaches persisted native workflow ownership after extension reload", () => {
        const bridge = createEvents();
        const coordinator = createVerificationCoordinator(bridge.events);
        const completions: unknown[] = [];
        coordinator.onComplete((completion) => completions.push(completion));

        coordinator.attach("native-restored-1", [
            { role: "verifier", outputName: "first" },
            { role: "architect", outputName: "architecture_advisory" },
        ]);
        bridge.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
            id: "native-restored-1",
            success: true,
            results: [
                {
                    workflowKey: "first",
                    status: "completed",
                    success: true,
                    structuredOutput: { outcome: "supported" },
                },
                {
                    workflowKey: "architecture_advisory",
                    status: "completed",
                    success: true,
                    structuredOutput: { status: "pass" },
                },
            ],
        });

        expect(completions).toEqual([
            {
                runId: "native-restored-1",
                terminal: {
                    kind: "complete",
                    structuredOutputs: {
                        first: { outcome: "supported" },
                        architecture_advisory: { status: "pass" },
                    },
                },
            },
        ]);
        coordinator.dispose();
    });

    it("rejects missing, duplicate, and extra workflow result keys as malformed", async () => {
        const variants = [
            [],
            [
                {
                    workflowKey: "first",
                    status: "completed",
                    success: true,
                    structuredOutput: { outcome: "supported" },
                },
                {
                    workflowKey: "first",
                    status: "completed",
                    success: true,
                    structuredOutput: { outcome: "falsified" },
                },
            ],
            [
                {
                    workflowKey: "first",
                    status: "completed",
                    success: true,
                    structuredOutput: { outcome: "supported" },
                },
                {
                    workflowKey: "unexpected",
                    status: "completed",
                    success: true,
                    structuredOutput: { outcome: "supported" },
                },
            ],
        ];

        for (const [index, results] of variants.entries()) {
            const bridge = createEvents();
            const runId = `native-malformed-${index}`;
            installRpc(bridge, runId);
            const coordinator = createVerificationCoordinator(bridge.events);
            const completions: any[] = [];
            coordinator.onComplete((completion) => completions.push(completion));
            await coordinator.start({
                ownerRunId: "brainstorm-run",
                sessionId: "session-current",
                sessionFile: "/tmp/session-current.jsonl",
                cwd: "/repo",
                label: "Brainstorm verification",
                nodes: [verifier("first")],
            });

            bridge.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
                id: runId,
                success: true,
                results,
            });

            expect(completions[0]?.terminal).toMatchObject({
                kind: "failure",
                failureKind: "malformed",
            });
            coordinator.dispose();
        }
    });

    it("stops a native workflow through pi-subagents RPC", async () => {
        const bridge = createEvents();
        installRpc(bridge);
        const coordinator = createVerificationCoordinator(bridge.events);
        const receipt = await coordinator.start({
            ownerRunId: "brainstorm-run",
            sessionId: "session-current",
            sessionFile: "/tmp/session-current.jsonl",
            cwd: "/repo",
            label: "Brainstorm verification",
            nodes: [verifier("first")],
        });

        await expect(coordinator.stop(receipt.runId)).resolves.toBe(true);
        expect(
            bridge.emitted.find(
                ({ event, data }) =>
                    event === SUBAGENT_RPC_REQUEST_EVENT &&
                    (data as { method?: string }).method === "stop",
            )?.data,
        ).toMatchObject({ method: "stop", params: { id: receipt.runId } });
        expect(coordinator.status(receipt.runId)).toMatchObject({
            state: "stopped",
        });
        coordinator.dispose();
    });

    it("keeps a native workflow running when stop is rejected", async () => {
        const bridge = createEvents();
        installRpc(bridge, "native-verification-1", {
            stopResult: { text: "stop rejected", isError: true },
        });
        const coordinator = createVerificationCoordinator(bridge.events);
        const receipt = await coordinator.start({
            ownerRunId: "brainstorm-run",
            sessionId: "session-current",
            sessionFile: "/tmp/session-current.jsonl",
            cwd: "/repo",
            label: "Brainstorm verification",
            nodes: [verifier("first")],
        });

        await expect(coordinator.stop(receipt.runId)).resolves.toBe(false);
        expect(coordinator.status(receipt.runId)).toMatchObject({
            state: "running",
        });
        coordinator.dispose();
    });

    it("preserves terminal completion when it races with stop", async () => {
        const bridge = createEvents();
        const runId = "native-verification-race";
        installRpc(bridge, runId, {
            onStopRequest: () =>
                bridge.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
                    id: runId,
                    success: true,
                    results: [
                        {
                            workflowKey: "first",
                            status: "completed",
                            success: true,
                            structuredOutput: { outcome: "supported" },
                        },
                    ],
                }),
        });
        const coordinator = createVerificationCoordinator(bridge.events);
        const receipt = await coordinator.start({
            ownerRunId: "brainstorm-run",
            sessionId: "session-current",
            sessionFile: "/tmp/session-current.jsonl",
            cwd: "/repo",
            label: "Brainstorm verification",
            nodes: [verifier("first")],
        });

        await expect(coordinator.stop(receipt.runId)).resolves.toBe(false);
        expect(coordinator.status(receipt.runId)).toMatchObject({
            state: "completed",
        });
        coordinator.dispose();
    });
});
