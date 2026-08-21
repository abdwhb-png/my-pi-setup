import { describe, it, expect, mock, afterEach } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const registeredCalls: Array<{
    name: string;
    definition: Record<string, unknown>;
    dispose: () => void;
}> = [];
let disposeCount = 0;

mock.module("pi-subagents/agents", () => ({
    registerAgent: (input: { name: string; definition?: Record<string, unknown> }) => {
        const registration = {
            name: input.name,
            definition: input.definition ?? {},
            dispose: () => {
                disposeCount += 1;
            },
        };
        registeredCalls.push(registration);
        return registration;
    },
}));

const { registerWorkflowAgents, isAgentRuntimeRegistered } = await import(
    "./workflow-agents.ts"
);

function mockPi(): ExtensionAPI {
    return { events: {}, ui: {} } as unknown as ExtensionAPI;
}

afterEach(() => {
    registeredCalls.length = 0;
    disposeCount = 0;
});

describe("registerWorkflowAgents", () => {
    it("registers each entry through the public registerAgent", () => {
        const pi = mockPi();
        const handle = registerWorkflowAgents(pi, [
            { name: "brainstorm-code-scout", definition: { description: "d", systemPrompt: "s" } },
        ]);
        expect(registeredCalls.map((call) => call.name)).toEqual([
            "brainstorm-code-scout",
        ]);
        handle.dispose();
        expect(disposeCount).toBe(1);
    });

    it("marks runtime-registered agents as registered", () => {
        const pi = mockPi();
        const handle = registerWorkflowAgents(pi, [
            { name: "sdd-worker", definition: { description: "d", systemPrompt: "s" } },
        ]);
        expect(isAgentRuntimeRegistered(pi, "sdd-worker")).toBe(true);
        handle.dispose();
    });

    it("unregisters after dispose", () => {
        const pi = mockPi();
        const handle = registerWorkflowAgents(pi, [
            { name: "sdd-spec-reviewer", definition: { description: "d", systemPrompt: "s" } },
        ]);
        expect(isAgentRuntimeRegistered(pi, "sdd-spec-reviewer")).toBe(true);
        handle.dispose();
        expect(isAgentRuntimeRegistered(pi, "sdd-spec-reviewer")).toBe(false);
    });

    it("is idempotent: re-registering does not double-register or double-dispose", () => {
        const pi = mockPi();
        const first = registerWorkflowAgents(pi, [
            { name: "sdd-worker", definition: { description: "d", systemPrompt: "s" } },
        ]);
        const second = registerWorkflowAgents(pi, [
            { name: "sdd-worker", definition: { description: "d", systemPrompt: "s" } },
        ]);
        expect(registeredCalls.filter((call) => call.name === "sdd-worker")).toHaveLength(1);
        first.dispose();
        second.dispose();
    });

    it("tracks per-pi instances independently", () => {
        const piA = mockPi();
        const piB = mockPi();
        const handleA = registerWorkflowAgents(piA, [
            { name: "sdd-worker", definition: { description: "d", systemPrompt: "s" } },
        ]);
        registerWorkflowAgents(piB, [
            { name: "sdd-spec-reviewer", definition: { description: "d", systemPrompt: "s" } },
        ]);
        expect(isAgentRuntimeRegistered(piA, "sdd-worker")).toBe(true);
        expect(isAgentRuntimeRegistered(piA, "sdd-spec-reviewer")).toBe(false);
        expect(isAgentRuntimeRegistered(piB, "sdd-spec-reviewer")).toBe(true);
        handleA.dispose();
        expect(isAgentRuntimeRegistered(piA, "sdd-worker")).toBe(false);
    });

    it("applies settings.json agentOverrides to the runtime definition before register", () => {
        const pi = mockPi();
        const overrides = {
            "sdd-worker": {
                model: "cpa/override-model",
                fallbackModels: ["cpa/ocg/go-deepseek-v4-pro"],
            },
        };
        const handle = registerWorkflowAgents(pi, [
            { name: "sdd-worker", definition: { description: "d", systemPrompt: "s" } },
        ], { overrides });
        const call = registeredCalls.find((c) => c.name === "sdd-worker")!;
        expect(call.definition.model).toBe("cpa/override-model");
        expect(call.definition.fallbackModels).toEqual(["cpa/ocg/go-deepseek-v4-pro"]);
        expect(call.definition.description).toBe("d"); // base kept
        handle.dispose();
    });

    it("keeps base definition intact when the agent has no settings override", () => {
        const pi = mockPi();
        const handle = registerWorkflowAgents(pi, [
            { name: "sdd-worker", definition: { description: "d", systemPrompt: "s" } },
        ], { overrides: {} });
        const call = registeredCalls.find((c) => c.name === "sdd-worker")!;
        expect(call.definition.model).toBeUndefined();
        expect(call.definition.description).toBe("d");
        handle.dispose();
    });

    it("maps settings turnBudget to the runtime defaultTurnBudget field", () => {
        const pi = mockPi();
        const handle = registerWorkflowAgents(pi, [
            { name: "sdd-worker", definition: { description: "d", systemPrompt: "s" } },
        ], {
            overrides: {
                "sdd-worker": {
                    turnBudget: { maxTurns: 20, graceTurns: 2 },
                },
            },
        });
        const call = registeredCalls.find((c) => c.name === "sdd-worker")!;
        expect(call.definition.defaultTurnBudget).toEqual({
            maxTurns: 20,
            graceTurns: 2,
        });
        expect(call.definition).not.toHaveProperty("turnBudget");
        handle.dispose();
    });

    it("does not mutate the caller's base definition object", () => {
        const pi = mockPi();
        const base = { description: "d", systemPrompt: "s" };
        registerWorkflowAgents(pi, [{ name: "sdd-worker", definition: base }], {
            overrides: { "sdd-worker": { model: "cpa/x" } },
        });
        expect(base).toEqual({ description: "d", systemPrompt: "s" });
    });
});
