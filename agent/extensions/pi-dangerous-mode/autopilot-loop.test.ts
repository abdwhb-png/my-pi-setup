import { describe, expect, it, mock } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_AUTOPILOT, type DangerousModeConfig } from "./config.ts";
import {
    getRuntimeStatus,
    setAutopilotOverride,
    startRuntimeSession,
} from "./runtime-state.ts";
import type { AutopilotTelemetryEvent } from "./telemetry.ts";
import {
    AUTOPILOT_COMPLETE_TOOL,
    registerAutopilotLoop,
} from "./autopilot-loop.ts";

interface FakeContext {
    hasPendingMessages(): boolean;
}

type Handler = (
    event: Record<string, unknown>,
    ctx: FakeContext,
) => unknown | Promise<unknown>;

interface CompleteTool {
    name: string;
    execute(
        id: string,
        params: {
            outcome: "completed" | "blocked";
            summary: string;
            remainingRisks?: string[];
        },
        signal: AbortSignal | undefined,
        onUpdate: undefined,
        ctx: FakeContext,
    ): Promise<{ content: Array<{ type: string; text: string }> }>;
}

function defaultConfig(): DangerousModeConfig {
    return {
        protectedTools: [],
        protectedExtensions: [],
        autopilot: {
            ...DEFAULT_AUTOPILOT,
            guardedTools: [...DEFAULT_AUTOPILOT.guardedTools],
            guardedCommands: [...DEFAULT_AUTOPILOT.guardedCommands],
        },
    };
}

function setMode(enabled: boolean, config = defaultConfig()): void {
    startRuntimeSession({
        isReload: false,
        dangerousFlag: false,
        autopilotFlag: enabled,
        config,
        now: 1_000,
    });
}

function setup(initialTools = ["read", AUTOPILOT_COMPLETE_TOOL, "bash"]): {
    emit(event: string, payload?: Record<string, unknown>, pending?: boolean): Promise<unknown>;
    tool: CompleteTool;
    activeTools(): string[];
    setActiveTools: ReturnType<typeof mock>;
    sendMessage: ReturnType<typeof mock>;
    telemetry: ReturnType<typeof mock>;
    providerCall: ReturnType<typeof mock>;
} {
    const handlers = new Map<string, Handler[]>();
    let tool: CompleteTool | undefined;
    let activeTools = [...initialTools];
    const setActiveTools = mock((names: string[]) => {
        activeTools = [...names];
    });
    const sendMessage = mock(
        (_message: unknown, _options: Record<string, unknown>) => undefined,
    );
    const providerCall = mock(() => undefined);
    const telemetry = mock((_event: AutopilotTelemetryEvent) => undefined);

    const pi = {
        registerTool(definition: CompleteTool) {
            tool = definition;
        },
        on(event: string, handler: Handler) {
            const eventHandlers = handlers.get(event) ?? [];
            eventHandlers.push(handler);
            handlers.set(event, eventHandlers);
        },
        getActiveTools() {
            return [...activeTools];
        },
        setActiveTools,
        sendMessage,
        getAllTools: providerCall,
        getCommands: providerCall,
    } as unknown as ExtensionAPI;

    registerAutopilotLoop(pi, { now: () => 1_000, telemetry });
    if (!tool) throw new Error("autopilot_complete was not registered");

    return {
        async emit(event, payload = {}, pending = false) {
            let result: unknown;
            const ctx: FakeContext = {
                hasPendingMessages: () => pending,
            };
            for (const handler of handlers.get(event) ?? []) {
                result = await handler({ type: event, ...payload }, ctx);
            }
            return result;
        },
        tool,
        activeTools: () => [...activeTools],
        setActiveTools,
        sendMessage,
        telemetry,
        providerCall,
    };
}

describe("pi-dangerous-mode Autopilot loop", () => {
    it("keeps completion tool hidden while off and preserves other tools", async () => {
        setMode(false);
        const fixture = setup();

        await fixture.emit("session_start", { reason: "startup" });
        expect(fixture.tool.name).toBe(AUTOPILOT_COMPLETE_TOOL);
        expect(fixture.activeTools()).toEqual(["read", "bash"]);

        startRuntimeSession({
            isReload: false,
            dangerousFlag: false,
            autopilotFlag: true,
            config: defaultConfig(),
            now: 1_000,
        });
        await fixture.emit("agent_start");
        expect(fixture.activeTools()).toEqual([
            "read",
            "bash",
            AUTOPILOT_COMPLETE_TOOL,
        ]);

        expect(setAutopilotOverride(false, 1_100)).toBe(true);
        await fixture.emit("agent_settled", {}, true);
        expect(fixture.activeTools()).toEqual(["read", "bash"]);
    });

    it("injects exact remaining budget into Autopilot instruction", async () => {
        setMode(true);
        const fixture = setup(["read"]);

        const result = (await fixture.emit("before_agent_start", {
            systemPrompt: "BASE",
        })) as { systemPrompt: string };

        expect(result.systemPrompt).toContain("BASE\n\nAUTOPILOT ACTIVE.");
        expect(result.systemPrompt).toContain(
            "Remaining budget: 8 turns, 2 error continuations, 600000 ms.",
        );
        expect(result.systemPrompt).toContain(
            "No hidden evaluator will decide for you.",
        );
    });

    it("records turn and retry counters from tool errors", async () => {
        setMode(true);
        const fixture = setup(["read"]);

        await fixture.emit("turn_end", {
            toolResults: [{ isError: false }, { isError: true }],
        });

        expect(getRuntimeStatus().autopilot).toMatchObject({
            turnsUsed: 1,
            retriesUsed: 1,
        });
        expect(fixture.telemetry).toHaveBeenCalledWith({
            event: "turn_recorded",
            turnsUsed: 1,
            retriesUsed: 1,
            hadError: true,
        });
    });

    it("queues one normal continuation after settlement", async () => {
        setMode(true);
        const fixture = setup(["read"]);
        await fixture.emit("agent_start");

        await fixture.emit("agent_settled");
        await fixture.emit("agent_settled");

        expect(fixture.sendMessage).toHaveBeenCalledTimes(1);
        expect(fixture.sendMessage).toHaveBeenCalledWith(
            expect.objectContaining({ customType: "pi:autopilot:continue" }),
            { triggerTurn: true, deliverAs: "nextTurn" },
        );
    });

    it("queues no continuation when messages are pending", async () => {
        setMode(true);
        const fixture = setup(["read"]);
        await fixture.emit("agent_start");

        await fixture.emit("agent_settled", {}, true);

        expect(fixture.sendMessage).toHaveBeenCalledTimes(0);
    });

    it("completion tool stops loop and prevents continuation", async () => {
        setMode(true);
        const fixture = setup(["read"]);
        await fixture.emit("agent_start");

        await fixture.tool.execute(
            "call-id",
            { outcome: "completed", summary: "validated" },
            undefined,
            undefined,
            { hasPendingMessages: () => false },
        );
        await fixture.emit("agent_settled");

        expect(getRuntimeStatus().autopilot.phase).toBe("completed");
        expect(fixture.sendMessage).toHaveBeenCalledTimes(0);
        expect(fixture.telemetry).toHaveBeenCalledWith({
            event: "completed",
            outcome: "completed",
        });
    });

    it("queues nothing after budget exhaustion and calls no provider API", async () => {
        const config = defaultConfig();
        config.autopilot.maxTurns = 1;
        setMode(true, config);
        const fixture = setup(["read"]);
        await fixture.emit("agent_start");

        await fixture.emit("turn_end", { toolResults: [] });
        await fixture.emit("agent_settled");

        expect(getRuntimeStatus().autopilot.phase).toBe("budget_exhausted");
        expect(fixture.sendMessage).toHaveBeenCalledTimes(0);
        expect(fixture.providerCall).toHaveBeenCalledTimes(0);
    });
});
