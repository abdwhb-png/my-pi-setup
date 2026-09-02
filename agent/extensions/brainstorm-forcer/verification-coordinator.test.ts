import { randomUUID } from "node:crypto";
import { describe, expect, it } from "bun:test";
import {
    SUBAGENT_DELEGATION_CANCEL_EVENT,
    SUBAGENT_DELEGATION_REQUEST_EVENT,
    SUBAGENT_DELEGATION_RESPONSE_EVENT,
    type SubagentDelegationRequest,
} from "pi-subagents/delegation";
import {
    snapshotExternalRuns,
    unregisterExternalRun,
} from "pi-subagents/external-runs";
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

function requests(
    emitted: readonly { event: string; data: unknown }[],
): SubagentDelegationRequest[] {
    return emitted
        .filter(({ event }) => event === SUBAGENT_DELEGATION_REQUEST_EVENT)
        .map(({ data }) => data as SubagentDelegationRequest);
}

async function eventually(predicate: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 32; attempt += 1) {
        if (predicate()) return;
        await Promise.resolve();
    }
    throw new Error("Expected asynchronous coordinator work to settle.");
}

function respond(
    events: EventBusLike,
    request: SubagentDelegationRequest,
    value: unknown,
): void {
    events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, {
        requestId: request.requestId,
        ownerRunId: request.ownerRunId,
        nodeId: request.nodeId,
        status: "completed",
        result: { kind: "structured", value },
    });
}

describe("verification coordinator 0.50", () => {
    it("projects exactly one complete Fleet run under its session file, never the Brainstorm UUID", () => {
        const bridge = createEvents();
        const coordinator = createVerificationCoordinator(bridge.events);
        const uuid = `brainstorm-${randomUUID()}`;
        const sessionFile = `/tmp/${randomUUID()}.jsonl`;

        try {
            const receipt = coordinator.start({
                ownerRunId: "brainstorm-run",
                sessionId: uuid,
                sessionFile,
                cwd: "/repo",
                label: "Brainstorm verification",
                nodes: [verifier("first")],
            });

            const snapshot = snapshotExternalRuns(sessionFile);
            expect(snapshot).toHaveLength(1);
            expect(snapshot[0]).toEqual(
                expect.objectContaining({
                    id: receipt.runId,
                    sessionId: sessionFile,
                    source: "brainstorm-forcer",
                    label: "Brainstorm verification",
                    state: "running",
                    currentAction: "Running 1 verification node(s)",
                    startedAt: expect.any(Number),
                }),
            );
            expect(Object.keys(snapshot[0]!).toSorted()).toEqual([
                "currentAction",
                "id",
                "label",
                "sessionId",
                "source",
                "startedAt",
                "state",
            ]);
            expect(snapshotExternalRuns(uuid)).toEqual([]);
        } finally {
            coordinator.dispose();
        }
    });

    it("requires an absolute persisted session file instead of using the session UUID", () => {
        const bridge = createEvents();
        const coordinator = createVerificationCoordinator(bridge.events);
        const sessionId = `brainstorm-${randomUUID()}`;

        try {
            expect(() =>
                coordinator.start({
                    ownerRunId: "brainstorm-run",
                    sessionId,
                    sessionFile: "relative-session.jsonl",
                    cwd: "/repo",
                    label: "Brainstorm verification",
                    nodes: [verifier("first")],
                }),
            ).toThrow("absolute persisted session file");
            expect(snapshotExternalRuns(sessionId)).toEqual([]);
            expect(requests(bridge.emitted)).toEqual([]);
        } finally {
            coordinator.dispose();
        }
    });

    it("emits both verifiers before responses, then gives the architect both structured outputs", async () => {
        const bridge = createEvents();
        const coordinator = createVerificationCoordinator(bridge.events);
        const sessionFile = `/tmp/${randomUUID()}.jsonl`;

        try {
            coordinator.start({
                ownerRunId: "brainstorm-run",
                sessionId: `brainstorm-${randomUUID()}`,
                sessionFile,
                cwd: "/repo",
                label: "Brainstorm verification",
                nodes: [
                    verifier("first"),
                    verifier("second", "pi-expert"),
                    architect(),
                ],
            });

            const verifierRequests = requests(bridge.emitted);
            expect(verifierRequests).toHaveLength(2);
            expect(verifierRequests.map((request) => request.nodeId)).toEqual([
                "first",
                "second",
            ]);

            respond(bridge.events, verifierRequests[0]!, { verdict: "one" });
            respond(bridge.events, verifierRequests[1]!, { verdict: "two" });
            await eventually(() => requests(bridge.emitted).length === 3);

            const architectRequest = requests(bridge.emitted)[2]!;
            expect(architectRequest).toMatchObject({
                nodeId: "architecture_advisory",
                agent: "architect",
            });
            expect(architectRequest.task).toContain('{"verdict":"one"}');
            expect(architectRequest.task).toContain('{"verdict":"two"}');

            respond(bridge.events, architectRequest, { status: "clear" });
            await eventually(() =>
                coordinator.status(architectRequest.ownerRunId)?.state ===
                "completed",
            );
        } finally {
            coordinator.dispose();
        }
    });

    it("stops every active child using its exact delegation tuple", () => {
        const bridge = createEvents();
        const coordinator = createVerificationCoordinator(bridge.events);

        try {
            const receipt = coordinator.start({
                ownerRunId: "brainstorm-run",
                sessionId: `brainstorm-${randomUUID()}`,
                sessionFile: `/tmp/${randomUUID()}.jsonl`,
                cwd: "/repo",
                label: "Brainstorm verification",
                nodes: [verifier("first"), verifier("second", "pi-expert")],
            });
            const active = requests(bridge.emitted);
            expect(active).toHaveLength(2);

            expect(coordinator.stop(receipt.runId)).toBe(true);
            const cancellations = bridge.emitted
                .filter(({ event }) => event === SUBAGENT_DELEGATION_CANCEL_EVENT)
                .map(({ data }) => data);
            expect(cancellations).toEqual(
                active.map((request) => ({
                    requestId: request.requestId,
                    ownerRunId: receipt.runId,
                    nodeId: request.nodeId,
                })),
            );
        } finally {
            coordinator.dispose();
        }
    });

    it("times out silent verifier children, cancels their exact tuples, and never launches the architect", async () => {
        const bridge = createEvents();
        const deadlineControllers: AbortController[] = [];
        const deadlineMs: number[] = [];
        const unregisterCalls: Array<readonly [string, string]> = [];
        const sessionFile = `/tmp/${randomUUID()}.jsonl`;
        const coordinator = createVerificationCoordinator(bridge.events, {
            childTimeoutMs: 8,
            deadlineGraceMs: 2,
            createDeadlineSignal(milliseconds) {
                deadlineMs.push(milliseconds);
                const controller = new AbortController();
                deadlineControllers.push(controller);
                return controller.signal;
            },
            unregisterExternalRun(sessionId, runId) {
                unregisterCalls.push([sessionId, runId]);
                return unregisterExternalRun(sessionId, runId);
            },
        });

        try {
            const receipt = coordinator.start({
                ownerRunId: "brainstorm-run",
                sessionId: `brainstorm-${randomUUID()}`,
                sessionFile,
                cwd: "/repo",
                label: "Brainstorm verification",
                nodes: [verifier("first"), verifier("second", "pi-expert"), architect()],
            });
            const active = requests(bridge.emitted);
            expect(active).toHaveLength(2);
            expect(active.map((request) => request.timeoutMs)).toEqual([8, 8]);
            expect(deadlineMs).toEqual([10, 10]);

            for (const controller of deadlineControllers) controller.abort();
            await eventually(() =>
                coordinator.status(receipt.runId)?.state === "failed",
            );

            expect(coordinator.status(receipt.runId)).toEqual({
                state: "failed",
                activeRequests: 0,
                terminal: expect.objectContaining({
                    kind: "failure",
                    failureKind: "timeout",
                }),
            });
            expect(requests(bridge.emitted)).toHaveLength(2);
            expect(
                bridge.emitted
                    .filter(({ event }) => event === SUBAGENT_DELEGATION_CANCEL_EVENT)
                    .map(({ data }) => data),
            ).toEqual(
                active.map((request) => ({
                    requestId: request.requestId,
                    ownerRunId: receipt.runId,
                    nodeId: request.nodeId,
                })),
            );
            expect(unregisterCalls).toEqual([[sessionFile, receipt.runId]]);
            expect(snapshotExternalRuns(sessionFile)).toEqual([]);
        } finally {
            coordinator.dispose();
        }
    });

    it("does not retain completed Fleet projections beyond the registry limit", async () => {
        const bridge = createEvents();
        const coordinator = createVerificationCoordinator(bridge.events);
        const sessionFile = `/tmp/${randomUUID()}.jsonl`;
        const receiptIds: string[] = [];

        try {
            for (let index = 0; index <= 100; index += 1) {
                const receipt = coordinator.start({
                    ownerRunId: "brainstorm-run",
                    sessionId: `brainstorm-${randomUUID()}`,
                    sessionFile,
                    cwd: "/repo",
                    label: "Brainstorm verification",
                    nodes: [verifier(`verification_${index}`)],
                });
                receiptIds.push(receipt.runId);
                const request = requests(bridge.emitted).at(-1)!;
                respond(bridge.events, request, { index });
                await eventually(() =>
                    coordinator.status(receipt.runId)?.state === "completed",
                );
            }

            expect(snapshotExternalRuns(sessionFile)).toEqual([]);
            expect(
                receiptIds.slice(0, 69).map((runId) => coordinator.status(runId)),
            ).toEqual(Array.from({ length: 69 }, () => undefined));
            expect(
                receiptIds.slice(69).map((runId) => coordinator.status(runId)),
            ).toEqual(
                Array.from({ length: 32 }, () =>
                    expect.objectContaining({
                        state: "completed",
                        activeRequests: 0,
                    }),
                ),
            );
        } finally {
            coordinator.dispose();
            for (const runId of receiptIds) unregisterExternalRun(sessionFile, runId);
        }
    });

    it("leaves no local run or delegation when Fleet registration rejects", () => {
        const bridge = createEvents();
        let rejectedRunId: string | undefined;
        const coordinator = createVerificationCoordinator(bridge.events, {
            registerExternalRun(input) {
                rejectedRunId = input.id;
                throw new Error("Injected Fleet registration failure.");
            },
        });

        expect(() =>
            coordinator.start({
                ownerRunId: "brainstorm-run",
                sessionId: `brainstorm-${randomUUID()}`,
                sessionFile: `/tmp/${randomUUID()}.jsonl`,
                cwd: "/repo",
                label: "Brainstorm verification",
                nodes: [verifier("first")],
            }),
        ).toThrow("Injected Fleet registration failure.");
        expect(rejectedRunId).toBeDefined();
        expect(coordinator.status(rejectedRunId!)).toBeUndefined();
        expect(coordinator.stop(rejectedRunId!)).toBe(false);
        expect(() => coordinator.dispose()).not.toThrow();
        expect(
            bridge.emitted.filter(
                ({ event }) => event === SUBAGENT_DELEGATION_REQUEST_EVENT,
            ),
        ).toEqual([]);
    });

    it("dispose cancels every child and removes Fleet projection without leaving later work active", () => {
        const bridge = createEvents();
        const coordinator = createVerificationCoordinator(bridge.events);
        const sessionFile = `/tmp/${randomUUID()}.jsonl`;
        const receipt = coordinator.start({
            ownerRunId: "brainstorm-run",
            sessionId: `brainstorm-${randomUUID()}`,
            sessionFile,
            cwd: "/repo",
            label: "Brainstorm verification",
            nodes: [verifier("first"), verifier("second", "pi-expert")],
        });
        const active = requests(bridge.emitted);

        coordinator.dispose();

        expect(
            bridge.emitted.filter(
                ({ event }) => event === SUBAGENT_DELEGATION_CANCEL_EVENT,
            ),
        ).toHaveLength(active.length);
        expect(snapshotExternalRuns(sessionFile)).toEqual([]);
        expect(coordinator.stop(receipt.runId)).toBe(false);
    });

    it("detaches stopped children even when no terminal response arrives", async () => {
        const bridge = createEvents();
        const coordinator = createVerificationCoordinator(bridge.events);
        const receipt = coordinator.start({
            ownerRunId: "brainstorm-run",
            sessionId: `brainstorm-${randomUUID()}`,
            sessionFile: `/tmp/${randomUUID()}.jsonl`,
            cwd: "/repo",
            label: "Brainstorm verification",
            nodes: [verifier("first"), verifier("second", "pi-expert")],
        });
        const active = requests(bridge.emitted);

        expect(coordinator.stop(receipt.runId)).toBe(true);
        expect(coordinator.status(receipt.runId)).toMatchObject({
            state: "stopped",
            activeRequests: 0,
        });
        await Promise.resolve();
        expect(coordinator.status(receipt.runId)).toMatchObject({
            state: "stopped",
            activeRequests: 0,
        });
        expect(
            bridge.emitted.filter(
                ({ event }) => event === SUBAGENT_DELEGATION_CANCEL_EVENT,
            ),
        ).toHaveLength(active.length);
        coordinator.dispose();
    });
});
