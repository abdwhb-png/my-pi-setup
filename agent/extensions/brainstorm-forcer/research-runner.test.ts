import { describe, expect, it } from "bun:test";
import { createResearchRunner } from "./research-runner";

const REQUEST = "prompt-template:subagent:request";
const RESPONSE = "prompt-template:subagent:response";

function createEvents() {
    const listeners = new Map<string, Set<(value: unknown) => void>>();
    return {
        on(event: string, handler: (value: unknown) => void) {
            const handlers = listeners.get(event) ?? new Set();
            handlers.add(handler);
            listeners.set(event, handlers);
            return () => handlers.delete(handler);
        },
        emit(event: string, value: unknown) {
            for (const handler of listeners.get(event) ?? []) handler(value);
        },
    };
}

describe("brainstorm research runner", () => {
    it("returns only a correlated structured result from the routed agent", async () => {
        const events = createEvents();
        const requests: Array<Record<string, unknown>> = [];
        events.on(REQUEST, (value) => {
            const request = value as Record<string, unknown>;
            requests.push(request);
            events.emit(RESPONSE, {
                requestId: request.requestId,
                ownerRunId: request.ownerRunId,
                nodeId: request.nodeId,
                status: "completed",
                agent: request.agent,
                exitCode: 0,
                result: {
                    kind: "structured",
                    value: {
                        summary: "Found root selection.",
                        findings: [
                            {
                                finding: "Discovery topic selects root.",
                                sourceRefs: ["index.ts:700"],
                            },
                        ],
                        gaps: [],
                    },
                },
            });
        });
        const runner = createResearchRunner(events);

        const result = await runner.run({
            ownerRunId: "brainstorm-1",
            cwd: "/tmp/project",
            input: {
                domain: "local-code",
                question: "Where is root selected?",
                sources: ["index.ts"],
            },
        });

        const second = await runner.run({
            ownerRunId: "brainstorm-1",
            cwd: "/tmp/project",
            input: {
                domain: "local-code",
                question: "Which topic reaches the store?",
                sources: ["index.ts"],
            },
        });

        expect(requests).toHaveLength(2);
        expect(requests[0]).toMatchObject({
            agent: "brainstorm-scout",
            context: "fresh",
            ownerRunId: "brainstorm-1",
        });
        expect(requests[0]!.nodeId).not.toBe(requests[1]!.nodeId);
        expect(result.summary).toBe("Found root selection.");
        expect(second.summary).toBe("Found root selection.");
        runner.dispose();
    });

    it("rejects malformed structured output", async () => {
        const events = createEvents();
        events.on(REQUEST, (value) => {
            const request = value as Record<string, unknown>;
            events.emit(RESPONSE, {
                requestId: request.requestId,
                ownerRunId: request.ownerRunId,
                nodeId: request.nodeId,
                status: "completed",
                agent: request.agent,
                exitCode: 0,
                result: {
                    kind: "structured",
                    value: {
                        summary: "No sources.",
                        findings: [{ finding: "Unsupported", sourceRefs: [] }],
                        gaps: [],
                    },
                },
            });
        });
        const runner = createResearchRunner(events);

        await expect(
            runner.run({
                ownerRunId: "brainstorm-2",
                cwd: "/tmp/project",
                input: {
                    domain: "external",
                    question: "What is guaranteed?",
                    sources: [],
                },
            }),
        ).rejects.toThrow("source reference");
        runner.dispose();
    });
});
