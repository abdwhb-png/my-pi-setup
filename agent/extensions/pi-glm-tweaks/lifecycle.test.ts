import { describe, it, expect, mock } from "bun:test";
import glmTweaks from "./index.ts";

describe("pi-glm-tweaks lifecycle", () => {
    it("cleans up timers and stale context on session_shutdown", async () => {
        const handlers: Record<string, Function[]> = {};
        const mockPi = {
            registerFlag: mock(),
            registerProvider: mock(),
            registerCommand: mock(),
            getThinkingLevel: mock().mockReturnValue("high"),
            getFlag: mock().mockReturnValue(true),
            on: mock((event: string, handler: Function) => {
                handlers[event] = handlers[event] || [];
                handlers[event].push(handler);
            }),
            events: {
                on: mock(),
                emit: mock(),
            },
        } as any;

        glmTweaks(mockPi);

        expect(handlers.session_start).toBeDefined();
        expect(handlers.session_shutdown).toBeDefined();

        const mockCtx = {
            hasUI: true,
            modelRegistry: {
                getAll: mock().mockReturnValue([
                    { provider: "zai", id: "glm-5.2" },
                ]),
                getApiKeyForProvider: mock().mockResolvedValue("test-key"),
            },
            model: { provider: "zai", id: "glm-5.2" },
            ui: {
                setWidget: mock(),
                notify: mock(),
            },
        } as any;

        // Start session
        await handlers.session_start[0]({}, mockCtx);

        // Model select
        handlers.model_select[0]({ model: { provider: "zai", id: "glm-5.2" } }, mockCtx);

        // Shutdown session
        await handlers.session_shutdown[0]({}, mockCtx);
    });

    it("handles stale runtime or throwing widget gracefully during session_start and model_select", async () => {
        const handlers: Record<string, Function[]> = {};
        const mockPi = {
            registerFlag: mock(),
            registerProvider: mock(),
            registerCommand: mock(),
            getThinkingLevel: mock().mockReturnValue("high"),
            getFlag: mock().mockReturnValue(true),
            on: mock((event: string, handler: Function) => {
                handlers[event] = handlers[event] || [];
                handlers[event].push(handler);
            }),
            events: {
                on: mock(),
                emit: mock(() => {
                    throw new Error("This extension ctx is stale after session replacement or reload.");
                }),
            },
        } as any;

        glmTweaks(mockPi);

        const mockCtx = {
            hasUI: true,
            modelRegistry: {
                getAll: mock().mockReturnValue([
                    { provider: "zai", id: "glm-5.2" },
                ]),
                getApiKeyForProvider: mock().mockResolvedValue("test-key"),
            },
            model: { provider: "zai", id: "glm-5.2" },
            ui: {
                setWidget: mock(),
                notify: mock(),
            },
        } as any;

        expect(async () => {
            await handlers.session_start[0]({}, mockCtx);
            handlers.model_select[0]({ model: { provider: "zai", id: "glm-5.2" } }, mockCtx);
            await handlers.session_shutdown[0]({}, mockCtx);
        }).not.toThrow();
    });
});
