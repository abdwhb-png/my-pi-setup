import { describe, it, expect, mock } from "bun:test";
import glmTweaks from "./index.ts";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { ZAI_MODELS } from "@earendil-works/pi-ai/providers/zai.models";
import { FANCY_FOOTER_REQUEST_WIDGET_REFRESH_EVENT } from "pi-fancy-footer/api";

function unauthenticatedGlmSession() {
    const handlers: Record<string, Function[]> = {};
    const emit = mock();
    const notify = mock();
    const registerProvider = mock();
    glmTweaks({
        registerFlag: mock(),
        registerProvider,
        registerCommand: mock(),
        getThinkingLevel: mock().mockReturnValue("high"),
        on: mock((event: string, handler: Function) => {
            (handlers[event] ??= []).push(handler);
        }),
        events: { on: mock(), emit },
    } as unknown as Parameters<typeof glmTweaks>[0]);

    const ctx = {
        model: { provider: "cpa", id: "zai-coding/glm-5.2" },
        modelRegistry: {
            getAll: mock().mockReturnValue([
                { provider: "cpa", id: "zai-coding/glm-5.2" },
                { provider: "zai", id: "glm-5.2" },
            ]),
            getApiKeyForProvider: mock().mockResolvedValue(undefined),
        },
        ui: { notify, setWidget: mock() },
        hasUI: true,
    };
    return { handlers, ctx, emit, notify, registerProvider };
}

describe("pi-glm-tweaks lifecycle", () => {
    it("preserves the built-in GLM-5.2 thinking levels when direct z.ai auth exists", async () => {
        const { handlers, ctx, registerProvider } = unauthenticatedGlmSession();
        const nativeModel = ZAI_MODELS["glm-5.2"];
        ctx.model = nativeModel;
        ctx.modelRegistry.getAll.mockReturnValue([nativeModel, ZAI_MODELS["glm-5.3"]]);
        ctx.modelRegistry.getApiKeyForProvider.mockResolvedValue("test-key");
        try {
            await handlers.session_start[0]({}, ctx);
            expect(getSupportedThinkingLevels(nativeModel)).toEqual(["off", "high", "max"]);
            expect(registerProvider).not.toHaveBeenCalled();
        } finally {
            await handlers.session_shutdown[0]({}, ctx);
        }
    });

    it("patches only an incomplete custom GLM-5.2 model and preserves its metadata", async () => {
        const { handlers, ctx, registerProvider } = unauthenticatedGlmSession();
        const native = ZAI_MODELS["glm-5.2"];
        const custom = {
            ...native,
            baseUrl: "https://custom-zai.example/v4",
            contextWindow: 123_456,
            cost: { ...native.cost, input: 42 },
            headers: { "X-Custom": "preserved" },
            thinkingLevelMap: undefined,
        };
        const glm53 = ZAI_MODELS["glm-5.3"];
        ctx.model = custom;
        ctx.modelRegistry.getAll.mockReturnValue([custom, glm53]);
        ctx.modelRegistry.getApiKeyForProvider.mockResolvedValue("test-key");
        try {
            await handlers.session_start[0]({}, ctx);
            expect(registerProvider).toHaveBeenCalledWith(
                "zai",
                expect.objectContaining({
                    models: [
                        expect.objectContaining({
                            baseUrl: custom.baseUrl,
                            contextWindow: custom.contextWindow,
                            cost: custom.cost,
                            headers: custom.headers,
                            thinkingLevelMap: expect.objectContaining({
                                off: "none",
                                minimal: null,
                                low: null,
                                medium: null,
                                high: "high",
                                xhigh: null,
                                max: "max",
                            }),
                        }),
                        glm53,
                    ],
                }),
            );
        } finally {
            await handlers.session_shutdown[0]({}, ctx);
        }
    });

    it("keeps the CPA GLM widget available without direct z.ai auth", async () => {
        const { handlers, ctx, emit, notify, registerProvider } = unauthenticatedGlmSession();
        try {
            await handlers.session_start[0]({}, ctx);
            expect(notify).not.toHaveBeenCalled();
            expect(registerProvider).not.toHaveBeenCalled();
            expect(emit).toHaveBeenCalledWith(FANCY_FOOTER_REQUEST_WIDGET_REFRESH_EVENT, {});
        } finally {
            await handlers.session_shutdown[0]({}, ctx);
        }
    });

    it("keeps the CPA GLM widget available when no z.ai model is registered", async () => {
        const { handlers, ctx, emit, notify } = unauthenticatedGlmSession();
        ctx.modelRegistry.getAll.mockReturnValue([{ provider: "cpa", id: "zai-coding/glm-5.2" }]);
        try {
            await handlers.session_start[0]({}, ctx);
            expect(notify).not.toHaveBeenCalled();
            expect(ctx.modelRegistry.getApiKeyForProvider).not.toHaveBeenCalled();
            expect(emit).toHaveBeenCalledWith(FANCY_FOOTER_REQUEST_WIDGET_REFRESH_EVENT, {});
        } finally {
            await handlers.session_shutdown[0]({}, ctx);
        }
    });

    it("does not warn about direct z.ai auth when OpenRouter GLM is selected", async () => {
        const { handlers, ctx, notify } = unauthenticatedGlmSession();
        ctx.model = { provider: "openrouter", id: "z-ai/glm-5.2" };
        try {
            await handlers.session_start[0]({}, ctx);
            expect(notify).not.toHaveBeenCalled();
        } finally {
            await handlers.session_shutdown[0]({}, ctx);
        }
    });

    it("warns when switching from CPA to unauthenticated direct z.ai GLM", async () => {
        const { handlers, ctx, notify } = unauthenticatedGlmSession();
        try {
            await handlers.session_start[0]({}, ctx);
            expect(notify).not.toHaveBeenCalled();
            ctx.model = { provider: "zai", id: "glm-5.2" };
            handlers.model_select[0]({ model: ctx.model }, ctx);
            expect(notify).toHaveBeenCalledWith(expect.stringContaining("ZAI auth not configured"), "warning");
        } finally {
            await handlers.session_shutdown[0]({}, ctx);
        }
    });

    it("warns for unauthenticated direct z.ai GLM-5-Turbo", async () => {
        const { handlers, ctx, notify } = unauthenticatedGlmSession();
        ctx.model = { provider: "zai", id: "glm-5-turbo" };
        try {
            await handlers.session_start[0]({}, ctx);
            expect(notify).toHaveBeenCalledWith(expect.stringContaining("ZAI auth not configured"), "warning");
        } finally {
            await handlers.session_shutdown[0]({}, ctx);
        }
    });

    it("warns for direct z.ai GLM-4.7 without auth even when GLM-5.2 is absent", async () => {
        const { handlers, ctx, notify, registerProvider } = unauthenticatedGlmSession();
        ctx.model = { provider: "zai", id: "glm-4.7" };
        ctx.modelRegistry.getAll.mockReturnValue([{ provider: "zai", id: "glm-4.7" }]);
        try {
            await handlers.session_start[0]({}, ctx);
            expect(notify).toHaveBeenCalledWith(expect.stringContaining("ZAI auth not configured"), "warning");
            expect(registerProvider).not.toHaveBeenCalled();
        } finally {
            await handlers.session_shutdown[0]({}, ctx);
        }
    });

    it("warns only once when starting on unauthenticated direct z.ai GLM", async () => {
        const { handlers, ctx, notify } = unauthenticatedGlmSession();
        ctx.model = { provider: "zai", id: "glm-5.2" };
        try {
            await handlers.session_start[0]({}, ctx);
            handlers.model_select[0]({ model: ctx.model }, ctx);
            expect(notify).toHaveBeenCalledTimes(1);
            expect(notify).toHaveBeenCalledWith(expect.stringContaining("ZAI auth not configured"), "warning");
        } finally {
            await handlers.session_shutdown[0]({}, ctx);
        }
    });

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
