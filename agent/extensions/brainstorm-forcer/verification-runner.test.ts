import { describe, expect, it, mock } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    SUBAGENT_ASYNC_COMPLETE_EVENT,
    SUBAGENT_RPC_PROTOCOL_VERSION,
    SUBAGENT_RPC_REPLY_EVENT_PREFIX,
    SUBAGENT_RPC_REQUEST_EVENT,
    createVerificationRpcClient,
    isPendingVerificationRun,
    parseOwnedTerminalCompletion,
    readOwnedTerminalStatusArtifact,
    type EventBusLike,
    type PendingVerificationRun,
} from "./verification-runner";

type RpcRequest = {
    version: number;
    requestId: string;
    method: string;
    params?: unknown;
};

function createMockBridge(
    handlers: Partial<Record<string, (request: RpcRequest) => unknown>>,
) {
    const listeners = new Map<string, Set<(data: unknown) => void>>();
    const on = mock((event: string, handler: (data: unknown) => void) => {
        const handlersForEvent = listeners.get(event) ?? new Set();
        handlersForEvent.add(handler);
        listeners.set(event, handlersForEvent);
        return () => {
            handlersForEvent.delete(handler);
            if (handlersForEvent.size === 0) listeners.delete(event);
        };
    });
    const emit = mock((event: string, data: unknown) => {
        if (event !== SUBAGENT_RPC_REQUEST_EVENT) {
            for (const listener of listeners.get(event) ?? []) listener(data);
            return;
        }
        const request = data as RpcRequest;
        const replyEvent = `${SUBAGENT_RPC_REPLY_EVENT_PREFIX}${request.requestId}`;
        try {
            const result = handlers[request.method]?.(request);
            for (const listener of listeners.get(replyEvent) ?? []) {
                listener({
                    version: SUBAGENT_RPC_PROTOCOL_VERSION,
                    requestId: request.requestId,
                    method: request.method,
                    success: true,
                    data: result,
                });
            }
        } catch (error) {
            for (const listener of listeners.get(replyEvent) ?? []) {
                listener({
                    version: SUBAGENT_RPC_PROTOCOL_VERSION,
                    requestId: request.requestId,
                    method: request.method,
                    success: false,
                    error: {
                        code: "execution_failed",
                        message:
                            error instanceof Error
                                ? error.message
                                : String(error),
                    },
                });
            }
        }
    });
    return {
        events: { on, emit } satisfies EventBusLike,
        emit,
        listenerCount: () =>
            [...listeners.values()].reduce(
                (count, handlersForEvent) =>
                    count + handlersForEvent.size,
                0,
            ),
    };
}

describe("verification-runner RPC client", () => {
    it("pings the exact v1 bridge and discovers its completion channel", async () => {
        const bridge = createMockBridge({
            ping: () => ({
                version: 1,
                methods: ["ping", "status", "spawn"],
                events: {
                    replyPrefix: SUBAGENT_RPC_REPLY_EVENT_PREFIX,
                    asyncComplete: SUBAGENT_ASYNC_COMPLETE_EVENT,
                },
                session: { sessionId: "owner-session" },
            }),
        });
        const client = createVerificationRpcClient(bridge.events);

        expect(await client.ping(500)).toEqual({
            methods: ["ping", "status", "spawn"],
            sessionId: "owner-session",
            asyncCompleteEvent: SUBAGENT_ASYNC_COMPLETE_EVENT,
        });
        expect(bridge.listenerCount()).toBe(0);
        client.dispose();
    });

    it("fails closed and removes its listener when the bridge times out", async () => {
        const listeners = new Set<(data: unknown) => void>();
        const events: EventBusLike = {
            on: mock((_event, handler) => {
                listeners.add(handler);
                return () => listeners.delete(handler);
            }),
            emit: mock(() => undefined),
        };
        const client = createVerificationRpcClient(events);

        await expect(client.ping(10)).rejects.toThrow(/timed out/i);
        expect(listeners.size).toBe(0);
        client.dispose();
    });

    it("spawns with required top-level async, fresh, and non-clarifying flags", async () => {
        let captured: RpcRequest | undefined;
        const bridge = createMockBridge({
            spawn: (request) => {
                captured = request;
                return {
                    text: "Spawned async run.",
                    details: {
                        mode: "chain",
                        runId: "async-run-123",
                        asyncDir: "/tmp/run",
                        results: [],
                    },
                };
            },
        });
        const client = createVerificationRpcClient(bridge.events);
        const chain = [{ agent: "pi-expert", task: "Verify." }];

        expect(await client.spawn({ chain }, 500)).toEqual({
            runId: "async-run-123",
            asyncDir: "/tmp/run",
        });
        expect(captured?.params).toEqual({
            chain,
            async: true,
            context: "fresh",
            clarify: false,
        });
        client.dispose();
    });

    it("returns the exact opaque status RPC payload without parsing prose", async () => {
        const bridge = createMockBridge({
            status: (request) => {
                expect(request.params).toEqual({ runId: "async-run-123" });
                return {
                    text: "Run: async-run-123\nState: running",
                    details: { mode: "single", results: [] },
                };
            },
        });
        const client = createVerificationRpcClient(bridge.events);

        expect(await client.status("async-run-123", 500)).toEqual({
            text: "Run: async-run-123\nState: running",
            details: { mode: "single", results: [] },
        });
        client.dispose();
    });

    it("rejects bridge failures and malformed spawn replies", async () => {
        const failed = createVerificationRpcClient(
            createMockBridge({
                spawn: () => {
                    throw new Error("chain validation failed");
                },
            }).events,
        );
        await expect(failed.spawn({ chain: [] }, 500)).rejects.toThrow(
            "chain validation failed",
        );
        failed.dispose();

        const malformed = createVerificationRpcClient(
            createMockBridge({
                spawn: () => ({ text: "ok", details: { results: [] } }),
            }).events,
        );
        await expect(malformed.spawn({ chain: [] }, 500)).rejects.toThrow(
            /runId/i,
        );
        malformed.dispose();
    });

    it("rejects a reply whose correlation fields do not match the request", async () => {
        const listeners = new Map<string, (data: unknown) => void>();
        const events: EventBusLike = {
            on: (event, handler) => {
                listeners.set(event, handler);
                return () => listeners.delete(event);
            },
            emit: (_event, data) => {
                const request = data as RpcRequest;
                listeners.get(
                    `${SUBAGENT_RPC_REPLY_EVENT_PREFIX}${request.requestId}`,
                )?.({
                    version: 1,
                    requestId: "unrelated-request",
                    method: request.method,
                    success: true,
                    data: {},
                });
            },
        };
        const client = createVerificationRpcClient(events);

        await expect(client.ping(500)).rejects.toThrow(/requestId/i);
        expect(listeners.size).toBe(0);
        client.dispose();
    });

    it("subscribes to the exact async completion channel and disposes it", () => {
        const bridge = createMockBridge({});
        const client = createVerificationRpcClient(bridge.events);
        const handler = mock(() => undefined);

        const unsubscribe = client.onAsyncComplete(handler);
        bridge.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
            runId: "owned-run",
        });
        expect(handler).toHaveBeenCalledWith({ runId: "owned-run" });

        unsubscribe();
        expect(bridge.listenerCount()).toBe(0);
        client.dispose();
    });

    it("rebinds an existing completion subscription to the channel advertised by ping", async () => {
        const advertisedEvent = "subagent:custom-async-complete";
        const bridge = createMockBridge({
            ping: () => ({
                version: 1,
                methods: ["ping", "status", "spawn"],
                events: {
                    replyPrefix: SUBAGENT_RPC_REPLY_EVENT_PREFIX,
                    asyncComplete: advertisedEvent,
                },
            }),
        });
        const client = createVerificationRpcClient(bridge.events);
        const handler = mock(() => undefined);
        const unsubscribe = client.onAsyncComplete(handler);

        await client.ping(500);
        bridge.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
            runId: "wrong-channel",
        });
        bridge.events.emit(advertisedEvent, { runId: "owned-run" });

        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledWith({ runId: "owned-run" });
        unsubscribe();
        expect(bridge.listenerCount()).toBe(0);
        client.dispose();
    });
});

const pendingRun: PendingVerificationRun = {
    runId: "owned-run",
    asyncDir: join(
        realpathSync(tmpdir()),
        "pi-subagents-test",
        "async-subagent-runs",
        "owned-run",
    ),
    ownerSessionId: "owner-session",
    brainstormRunId: "brainstorm-1",
    claimIds: ["CL-001"],
    startedAt: "2026-07-29T12:00:00.000Z",
    expectedSteps: [
        {
            role: "verifier",
            outputName: "verify_local_code_supported",
            agent: "scout",
            domain: "local-code",
            claimIds: ["CL-001"],
            evidenceIds: ["EV-001"],
            outcome: "supported",
            resultIndex: 0,
            chainStepIndex: 0,
        },
        {
            role: "architect",
            outputName: "architect_advisory",
            agent: "architect",
            claimIds: ["CL-001"],
            evidenceIds: ["EV-001"],
            resultIndex: 1,
            chainStepIndex: 1,
        },
    ],
};

function validCompletion() {
    const verifier = {
        outcome: "supported",
        claimIds: ["CL-001"],
        evidenceIds: ["EV-001"],
        summary: "Supported.",
    };
    const architect = {
        status: "watch",
        claimIds: ["CL-001"],
        evidenceIds: ["EV-001"],
        risks: ["Keep observing reload behavior."],
        summary: "No blocking architecture issue.",
    };
    return {
        runId: "owned-run",
        sessionId: "owner-session",
        success: true,
        state: "complete",
        exitCode: 0,
        results: [
            {
                agent: "scout",
                context: "fresh",
                status: "completed",
                success: true,
                exitCode: 0,
                structuredOutput: verifier,
            },
            {
                agent: "architect",
                context: "fresh",
                status: "completed",
                success: true,
                exitCode: 0,
                structuredOutput: architect,
            },
        ],
        outputs: {
            "verify_local_code_supported": {
                text: JSON.stringify(verifier),
                structured: verifier,
                agent: "scout",
                stepIndex: 0,
            },
            "architect_advisory": {
                text: JSON.stringify(architect),
                structured: architect,
                agent: "architect",
                stepIndex: 1,
            },
        },
    };
}

describe("verification-runner pending and terminal validation", () => {
    it("restores only complete persisted ownership and scope metadata", () => {
        expect(isPendingVerificationRun(pendingRun)).toBe(true);
        expect(
            isPendingVerificationRun({
                ...pendingRun,
                expectedSteps: pendingRun.expectedSteps.map((step) => {
                    if (step.role === "architect") return step;
                    const { domain: _domain, ...missingDomain } = step;
                    return missingDomain;
                }),
            }),
        ).toBe(false);
        expect(
            isPendingVerificationRun({
                ...pendingRun,
                expectedSteps: [
                    {
                        ...pendingRun.expectedSteps[0],
                        agent: "worker",
                    },
                ],
            }),
        ).toBe(false);
        expect(
            isPendingVerificationRun({
                ...pendingRun,
                claimIds: ["CL-001", "CL-001"],
            }),
        ).toBe(false);
        const { asyncDir: _asyncDir, ...missingAsyncDir } = pendingRun;
        expect(isPendingVerificationRun(missingAsyncDir)).toBe(false);
        expect(
            isPendingVerificationRun({
                ...pendingRun,
                asyncDir: join(
                    realpathSync(tmpdir()),
                    "pi-subagents-test",
                    "wrong-parent",
                    pendingRun.runId,
                ),
            }),
        ).toBe(false);
        expect(
            isPendingVerificationRun({
                ...pendingRun,
                asyncDir: join(
                    realpathSync(tmpdir()),
                    "untrusted-scope",
                    "async-subagent-runs",
                    pendingRun.runId,
                ),
            }),
        ).toBe(false);
        expect(
            isPendingVerificationRun({
                ...pendingRun,
                asyncDir: `${join(
                    realpathSync(tmpdir()),
                    "pi-subagents-test",
                    "async-subagent-runs",
                    "nested",
                )}/../${pendingRun.runId}`,
            }),
        ).toBe(false);
    });

    it("accepts an owned terminal event only when every result and named output matches", () => {
        expect(
            parseOwnedTerminalCompletion(validCompletion(), pendingRun),
        ).toEqual({
            kind: "complete",
            structuredOutputs: {
                "verify_local_code_supported": {
                    outcome: "supported",
                    claimIds: ["CL-001"],
                    evidenceIds: ["EV-001"],
                    summary: "Supported.",
                },
                "architect_advisory": {
                    status: "watch",
                    claimIds: ["CL-001"],
                    evidenceIds: ["EV-001"],
                    risks: ["Keep observing reload behavior."],
                    summary: "No blocking architecture issue.",
                },
            },
        });
    });

    it("correlates flattened parallel results to their shared outer chain step index", () => {
        const pending: PendingVerificationRun = {
            runId: "parallel-owned-run",
            asyncDir: "/tmp/parallel-owned-run",
            ownerSessionId: "owner-session",
            brainstormRunId: "brainstorm-1",
            claimIds: ["CL-001", "CL-002"],
            startedAt: "2026-07-29T12:00:00.000Z",
            expectedSteps: [
                {
                    role: "verifier",
                    outputName: "verify_local_code_supported",
                    agent: "scout",
                    domain: "local-code",
                    outcome: "supported",
                    claimIds: ["CL-001"],
                    evidenceIds: ["EV-001"],
                    resultIndex: 0,
                    chainStepIndex: 0,
                },
                {
                    role: "verifier",
                    outputName: "verify_external_supported",
                    agent: "factual-researcher",
                    domain: "external",
                    outcome: "supported",
                    claimIds: ["CL-002"],
                    evidenceIds: ["EV-002"],
                    resultIndex: 1,
                    chainStepIndex: 0,
                },
                {
                    role: "architect",
                    outputName: "architect_advisory",
                    agent: "architect",
                    claimIds: ["CL-002"],
                    evidenceIds: ["EV-002"],
                    resultIndex: 2,
                    chainStepIndex: 1,
                },
            ],
        };
        const local = {
            outcome: "supported",
            claimIds: ["CL-001"],
            evidenceIds: ["EV-001"],
            summary: "Local claim supported.",
        };
        const external = {
            outcome: "supported",
            claimIds: ["CL-002"],
            evidenceIds: ["EV-002"],
            summary: "External claim supported.",
        };
        const architect = {
            status: "clear",
            claimIds: ["CL-002"],
            evidenceIds: ["EV-002"],
            risks: [],
            summary: "No architecture blocker.",
        };

        expect(
            parseOwnedTerminalCompletion(
                {
                    runId: "parallel-owned-run",
                    sessionId: "owner-session",
                    success: true,
                    state: "complete",
                    exitCode: 0,
                    results: [
                        {
                            agent: "scout",
                            context: "fresh",
                            status: "completed",
                            success: true,
                            exitCode: 0,
                            structuredOutput: local,
                        },
                        {
                            agent: "factual-researcher",
                            context: "fresh",
                            status: "completed",
                            success: true,
                            exitCode: 0,
                            structuredOutput: external,
                        },
                        {
                            agent: "architect",
                            context: "fresh",
                            status: "completed",
                            success: true,
                            exitCode: 0,
                            structuredOutput: architect,
                        },
                    ],
                    outputs: {
                        "verify_local_code_supported": {
                            agent: "scout",
                            stepIndex: 0,
                            structured: local,
                        },
                        "verify_external_supported": {
                            agent: "factual-researcher",
                            stepIndex: 0,
                            structured: external,
                        },
                        "architect_advisory": {
                            agent: "architect",
                            stepIndex: 1,
                            structured: architect,
                        },
                    },
                },
                pending,
            ),
        ).toMatchObject({ kind: "complete" });
    });

    it("ignores unrelated runIds", () => {
        expect(
            parseOwnedTerminalCompletion(
                { ...validCompletion(), runId: "someone-else" },
                pendingRun,
            ),
        ).toEqual({ kind: "unrelated" });
    });

    it("rejects malformed agent, group output, and owner-session correlation", () => {
        const wrongAgent = validCompletion();
        wrongAgent.results[0]!.agent = "worker";
        expect(
            parseOwnedTerminalCompletion(wrongAgent, pendingRun),
        ).toMatchObject({ kind: "failure", failureKind: "malformed" });

        const wrongOutput = validCompletion();
        wrongOutput.outputs["verify_local_code_supported"]!.stepIndex = 1;
        expect(
            parseOwnedTerminalCompletion(wrongOutput, pendingRun),
        ).toMatchObject({ kind: "failure", failureKind: "malformed" });

        expect(
            parseOwnedTerminalCompletion(
                { ...validCompletion(), sessionId: "other-session" },
                pendingRun,
            ),
        ).toMatchObject({ kind: "failure", failureKind: "malformed" });
    });

    it("classifies timeout and non-zero terminal failures without accepting outputs", () => {
        expect(
            parseOwnedTerminalCompletion(
                {
                    ...validCompletion(),
                    success: false,
                    state: "failed",
                    exitCode: 1,
                    timedOut: true,
                    error: "Verification timed out.",
                },
                pendingRun,
            ),
        ).toMatchObject({ kind: "failure", failureKind: "timeout" });

        expect(
            parseOwnedTerminalCompletion(
                {
                    ...validCompletion(),
                    success: false,
                    state: "failed",
                    exitCode: 1,
                    error: "Verifier failed.",
                },
                pendingRun,
            ),
        ).toMatchObject({ kind: "failure", failureKind: "failed" });
    });

    it("reads only the owned lifecycle v3 status artifact and normalizes terminal results", () => {
        const root = mkdtempSync(
            join(realpathSync(tmpdir()), "pi-subagents-test-"),
        );
        const asyncDir = join(
            root,
            "async-subagent-runs",
            pendingRun.runId,
        );
        const pending = { ...pendingRun, asyncDir };
        const completion = validCompletion();
        mkdirSync(asyncDir, { recursive: true });
        try {
            writeFileSync(
                join(asyncDir, "status.json"),
                JSON.stringify({
                    lifecycleArtifactVersion: 3,
                    runId: pending.runId,
                    sessionId: pending.ownerSessionId,
                    mode: "chain",
                    state: "running",
                    startedAt: Date.now(),
                    steps: completion.results.map((result, index) => ({
                        agent: result.agent,
                        context: result.context,
                        outputName: pending.expectedSteps[index]!.outputName,
                        status: "running",
                    })),
                }),
            );
            expect(readOwnedTerminalStatusArtifact(pending)).toEqual({
                kind: "pending",
            });

            writeFileSync(
                join(asyncDir, "status.json"),
                JSON.stringify({
                    lifecycleArtifactVersion: 3,
                    runId: pending.runId,
                    sessionId: pending.ownerSessionId,
                    mode: "chain",
                    state: "complete",
                    startedAt: Date.now(),
                    endedAt: Date.now(),
                    steps: completion.results.map((result, index) => ({
                        agent: result.agent,
                        context: result.context,
                        outputName: pending.expectedSteps[index]!.outputName,
                        status: "completed",
                        exitCode: result.exitCode,
                        structuredOutput: result.structuredOutput,
                    })),
                    outputs: completion.outputs,
                }),
            );
            expect(readOwnedTerminalStatusArtifact(pending)).toMatchObject({
                kind: "complete",
                structuredOutputs: {
                    "verify_local_code_supported":
                        completion.results[0]!.structuredOutput,
                    "architect_advisory":
                        completion.results[1]!.structuredOutput,
                },
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("rejects lifecycle artifacts outside the package temp hierarchy", () => {
        const outsideRoot = mkdtempSync(
            join(process.cwd(), ".brainstorm-status-"),
        );
        const wrongParentScope = mkdtempSync(
            join(realpathSync(tmpdir()), "pi-subagents-test-"),
        );
        const completion = validCompletion();
        const paths = [
            join(outsideRoot, pendingRun.runId),
            join(wrongParentScope, "wrong-parent", pendingRun.runId),
        ];
        try {
            for (const asyncDir of paths) {
                const pending = { ...pendingRun, asyncDir };
                mkdirSync(asyncDir, { recursive: true });
                writeFileSync(
                    join(asyncDir, "status.json"),
                    JSON.stringify({
                        lifecycleArtifactVersion: 3,
                        runId: pending.runId,
                        sessionId: pending.ownerSessionId,
                        mode: "chain",
                        state: "running",
                        steps: completion.results.map((result, index) => ({
                            agent: result.agent,
                            context: result.context,
                            outputName:
                                pending.expectedSteps[index]!.outputName,
                            status: "running",
                        })),
                    }),
                );
                expect(
                    readOwnedTerminalStatusArtifact(pending),
                ).toMatchObject({
                    kind: "failure",
                    failureKind: "malformed",
                });
            }
        } finally {
            rmSync(outsideRoot, { recursive: true, force: true });
            rmSync(wrongParentScope, { recursive: true, force: true });
        }
    });

    it("rejects symlinked scope, async root, run directory, and status paths", () => {
        const tempRoot = realpathSync(tmpdir());
        const completion = validCompletion();
        const fixtures: Array<{ cleanup: string[]; asyncDir: string }> = [];

        const targetScope = mkdtempSync(
            join(tempRoot, "pi-subagents-target-"),
        );
        const linkedScope = mkdtempSync(
            join(tempRoot, "pi-subagents-link-"),
        );
        rmSync(linkedScope, { recursive: true });
        symlinkSync(targetScope, linkedScope, "dir");
        fixtures.push({
            cleanup: [linkedScope, targetScope],
            asyncDir: join(
                linkedScope,
                "async-subagent-runs",
                pendingRun.runId,
            ),
        });

        const rootScope = mkdtempSync(
            join(tempRoot, "pi-subagents-root-"),
        );
        const targetRoot = join(rootScope, "target-runs");
        mkdirSync(targetRoot);
        symlinkSync(
            targetRoot,
            join(rootScope, "async-subagent-runs"),
            "dir",
        );
        fixtures.push({
            cleanup: [rootScope],
            asyncDir: join(
                rootScope,
                "async-subagent-runs",
                pendingRun.runId,
            ),
        });

        const runScope = mkdtempSync(join(tempRoot, "pi-subagents-run-"));
        const runRoot = join(runScope, "async-subagent-runs");
        const targetRun = join(runScope, "target-run");
        mkdirSync(runRoot);
        mkdirSync(targetRun);
        symlinkSync(targetRun, join(runRoot, pendingRun.runId), "dir");
        fixtures.push({
            cleanup: [runScope],
            asyncDir: join(runRoot, pendingRun.runId),
        });

        const statusScope = mkdtempSync(
            join(tempRoot, "pi-subagents-status-"),
        );
        const statusDir = join(
            statusScope,
            "async-subagent-runs",
            pendingRun.runId,
        );
        mkdirSync(statusDir, { recursive: true });
        fixtures.push({ cleanup: [statusScope], asyncDir: statusDir });

        try {
            for (const [index, fixture] of fixtures.entries()) {
                const pending = { ...pendingRun, asyncDir: fixture.asyncDir };
                mkdirSync(fixture.asyncDir, { recursive: true });
                const status = JSON.stringify({
                    lifecycleArtifactVersion: 3,
                    runId: pending.runId,
                    sessionId: pending.ownerSessionId,
                    mode: "chain",
                    state: "running",
                    steps: completion.results.map((result, stepIndex) => ({
                        agent: result.agent,
                        context: result.context,
                        outputName:
                            pending.expectedSteps[stepIndex]!.outputName,
                        status: "running",
                    })),
                });
                if (index === fixtures.length - 1) {
                    const targetStatus = join(
                        statusScope,
                        "target-status.json",
                    );
                    writeFileSync(targetStatus, status);
                    symlinkSync(
                        targetStatus,
                        join(fixture.asyncDir, "status.json"),
                    );
                } else {
                    writeFileSync(join(fixture.asyncDir, "status.json"), status);
                }
                expect(
                    readOwnedTerminalStatusArtifact(pending),
                ).toMatchObject({
                    kind: "failure",
                    failureKind: "malformed",
                });
            }
        } finally {
            for (const fixture of fixtures)
                for (const path of fixture.cleanup)
                    rmSync(path, { recursive: true, force: true });
        }
    });

    it("fails closed when the owned status artifact is missing or malformed", () => {
        const root = mkdtempSync(
            join(realpathSync(tmpdir()), "pi-subagents-test-"),
        );
        const asyncDir = join(
            root,
            "async-subagent-runs",
            pendingRun.runId,
        );
        const pending = { ...pendingRun, asyncDir };
        mkdirSync(asyncDir, { recursive: true });
        try {
            expect(readOwnedTerminalStatusArtifact(pending)).toMatchObject({
                kind: "failure",
                failureKind: "malformed",
            });
            writeFileSync(join(asyncDir, "status.json"), '{"state":"complete"}');
            expect(readOwnedTerminalStatusArtifact(pending)).toMatchObject({
                kind: "failure",
                failureKind: "malformed",
            });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
