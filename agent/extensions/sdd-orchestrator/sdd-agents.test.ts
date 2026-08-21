import { describe, expect, it, mock, afterEach } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const registeredNames: string[] = [];
let disposeCount = 0;

mock.module("pi-subagents/agents", () => ({
    registerAgent: (input: { name: string }) => {
        registeredNames.push(input.name);
        return { dispose: () => (disposeCount += 1) };
    },
}));

const { createSddAgentGate, getSddAgentEntry, getSddAgentEntries } =
    await import("./sdd-agents.ts");

function mockPi(): ExtensionAPI {
    return { events: {}, ui: {} } as unknown as ExtensionAPI;
}

afterEach(() => {
    registeredNames.length = 0;
    disposeCount = 0;
});

describe("sdd-agents", () => {
    it("defines exactly the five task-execution agents, not assessor/orchestrator", () => {
        const names = getSddAgentEntries().map((entry) => entry.name).sort();
        expect(names).toEqual([
            "sdd-combined-reviewer",
            "sdd-qa-tester",
            "sdd-quality-reviewer",
            "sdd-spec-reviewer",
            "sdd-worker",
        ]);
        expect(getSddAgentEntry("orchestration-assessor")).toBeUndefined();
        expect(getSddAgentEntry("sdd-orchestrator")).toBeUndefined();
    });

    it("registers all five on acquire and disposes on matching release", () => {
        const gate = createSddAgentGate(mockPi());
        gate.acquire();
        expect(registeredNames).toHaveLength(5);
        gate.release();
        expect(disposeCount).toBe(5);
    });

    it("holds registration across overlapping runs (refcount)", () => {
        const gate = createSddAgentGate(mockPi());
        gate.acquire();
        gate.acquire();
        gate.release();
        expect(disposeCount).toBe(0);
        gate.release();
        expect(disposeCount).toBe(5);
    });
});
