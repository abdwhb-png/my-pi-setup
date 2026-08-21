import { describe, it, expect, mock, afterEach } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const registeredCalls: Array<{ name: string; dispose: () => void }> = [];
let disposeCount = 0;

mock.module("pi-subagents/agents", () => ({
    registerAgent: (input: { name: string }) => {
        const registration = {
            name: input.name,
            dispose: () => {
                disposeCount += 1;
            },
        };
        registeredCalls.push(registration);
        return registration;
    },
}));

const { createWorkflowAgentGate } = await import("./workflow-agents.ts");

function mockPi(): ExtensionAPI {
    return { events: {}, ui: {} } as unknown as ExtensionAPI;
}

afterEach(() => {
    registeredCalls.length = 0;
    disposeCount = 0;
});

const ENTRY = { name: "sdd-worker", definition: { description: "d", systemPrompt: "s" } };
const ENTRY_2 = { name: "sdd-spec-reviewer", definition: { description: "d", systemPrompt: "s" } };

describe("createWorkflowAgentGate", () => {
    it("registers on first acquire and disposes on matching release", () => {
        const pi = mockPi();
        const gate = createWorkflowAgentGate(pi, [ENTRY]);
        gate.acquire();
        expect(registeredCalls.map((call) => call.name)).toEqual(["sdd-worker"]);
        gate.release();
        expect(disposeCount).toBe(1);
    });

    it("holds registration while any run is active (refcount)", () => {
        const pi = mockPi();
        const gate = createWorkflowAgentGate(pi, [ENTRY, ENTRY_2]);
        gate.acquire();
        gate.acquire();
        expect(registeredCalls.map((call) => call.name)).toEqual([
            "sdd-worker",
            "sdd-spec-reviewer",
        ]);
        gate.release();
        expect(disposeCount).toBe(0); // one run still active
        gate.release();
        expect(disposeCount).toBe(2);
    });

    it("does not re-register on overlapping acquire", () => {
        const pi = mockPi();
        const gate = createWorkflowAgentGate(pi, [ENTRY]);
        gate.acquire();
        gate.acquire();
        expect(registeredCalls.filter((call) => call.name === "sdd-worker")).toHaveLength(1);
        gate.release();
        gate.release();
        expect(disposeCount).toBe(1);
    });

    it("is a no-op when no run has ever acquired", () => {
        const pi = mockPi();
        const gate = createWorkflowAgentGate(pi, [ENTRY]);
        gate.release();
        expect(registeredCalls).toHaveLength(0);
        expect(disposeCount).toBe(0);
    });

    it("tracks per-pi instances independently", () => {
        const gateA = createWorkflowAgentGate(mockPi(), [ENTRY]);
        const gateB = createWorkflowAgentGate(mockPi(), [ENTRY_2]);
        gateA.acquire();
        gateB.acquire();
        gateA.release();
        expect(disposeCount).toBe(1); // only gateA's agent disposed
        gateB.release();
        expect(disposeCount).toBe(2);
    });
});
