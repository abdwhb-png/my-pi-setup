import { describe, test, expect, mock } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerProvidersCommand } from "./providers.ts";

mock.module("../config.ts", () => ({
    loadAiProvidersConfig: mock(),
}));
import { loadAiProvidersConfig } from "../config.ts";

describe("registerProvidersCommand", () => {
    test("shows CPA unavailability separately from configured credentials", async () => {
        let handler:
            | Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]
            | undefined;
        const pi = {
            registerCommand: (
                _name: string,
                config: Parameters<ExtensionAPI["registerCommand"]>[1],
            ) => {
                handler = config.handler;
            },
        } as ExtensionAPI;
        const unavailable = {
            state: "unavailable" as const,
            diagnostic:
                "CPA unavailable (HTTP 401). Check credentials and run /cpa-refresh.",
        };
        registerProvidersCommand(pi, () => unavailable);
        (loadAiProvidersConfig as ReturnType<typeof mock>).mockReturnValue({
            providers: { cpa: { enabled: true } },
            maxVisibleRows: 10,
        });
        let rendered = "";
        await handler!("", {
            mode: "tui",
            modelRegistry: {
                getAll: () => [],
                getProviderDisplayName: () => "CPA",
                getProviderAuthStatus: () => ({ configured: true }),
            },
            ui: {
                custom: async (
                    factory: (
                        tui: unknown,
                        theme: unknown,
                        bindings: unknown,
                        done: () => void,
                    ) => { render(width: number): string[] },
                ) => {
                    const component = factory(
                        { requestRender: () => {} },
                        { fg: (_role: string, text: string) => text },
                        undefined,
                        () => {},
                    );
                    rendered = component.render(140).join("\n");
                },
            },
        } as never);
        expect(rendered).toContain("HTTP 401");
        expect(rendered).toContain("/cpa-refresh");
        expect(rendered).not.toContain("No models registered");
    });
    test("registers the /providers command", () => {
        const registeredCommands: { name: string; options: any }[] = [];
        const pi = {
            registerCommand: (name: string, options: any) => {
                registeredCommands.push({ name, options });
            },
        } as unknown as ExtensionAPI;

        registerProvidersCommand(pi);

        expect(registeredCommands.length).toBe(1);
        expect(registeredCommands[0].name).toBe("providers");
        expect(registeredCommands[0].options.description).toBeDefined();
        expect(typeof registeredCommands[0].options.handler).toBe("function");
    });

    test("handler gracefully handles no providers", async () => {
        let registeredHandler: any;
        const pi = {
            registerCommand: (_name: string, options: any) => {
                registeredHandler = options.handler;
            },
        } as unknown as ExtensionAPI;

        registerProvidersCommand(pi);

        const mockNotify = mock();
        const ctx = {
            mode: "tui",
            modelRegistry: {
                getAll: () => [],
            },
            ui: {
                notify: mockNotify,
            },
        };

        (loadAiProvidersConfig as ReturnType<typeof mock>).mockReturnValue({
            providers: {},
        });

        await registeredHandler("", ctx);
        expect(mockNotify).toHaveBeenCalledWith("No providers found.", "info");
    });

    test("handler displays custom TUI when providers exist", async () => {
        let registeredHandler: any;
        const pi = {
            registerCommand: (_name: string, options: any) => {
                registeredHandler = options.handler;
            },
        } as unknown as ExtensionAPI;

        registerProvidersCommand(pi);

        const mockCustom = mock().mockResolvedValue(null);
        const ctx = {
            mode: "tui",
            modelRegistry: {
                getAll: () => [
                    { provider: "cpa", id: "cpa/model-1", name: "Model 1" },
                    { provider: "openai", id: "openai/gpt-4", name: "GPT 4" },
                ],
                getProviderDisplayName: (p: string) =>
                    p === "openai" ? "OpenAI" : "CPA",
                getProviderAuthStatus: () => ({ configured: true }),
            },
            ui: {
                custom: mockCustom,
            },
        };

        (loadAiProvidersConfig as ReturnType<typeof mock>).mockReturnValue({
            providers: { cpa: { enabled: true } },
        });

        await registeredHandler("", ctx);

        expect(mockCustom).toHaveBeenCalledTimes(1);
        const callArgs = mockCustom.mock.calls[0];
        expect(typeof callArgs[0]).toBe("function");
        expect(callArgs[1].overlay).toBe(true);
    });
});
