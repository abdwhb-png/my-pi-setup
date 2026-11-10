import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerProviderCatalogFinalizer } from "./provider-catalog-finalizer.ts";

function fixture() {
    const hooks = new Map<string, (event: any, ctx: any) => any>();
    const entries: Array<{ type: string; customType: string; data: any }> = [];
    const notices: string[] = [];
    let failWrite = false;
    const pi = {
        on: (name: string, handler: any) => hooks.set(name, handler),
        appendEntry(customType: string, data: unknown) {
            if (failWrite) throw new Error("private persistence error");
            entries.push({ type: "custom", customType, data });
        },
    } as unknown as ExtensionAPI;
    registerProviderCatalogFinalizer(pi);
    const ctx = {
        model: { api: "openai-responses", provider: "fixture", id: "model-a" },
        sessionManager: { getBranch: () => entries },
        ui: { notify: (message: string) => notices.push(message) },
    };
    const observe = (payload: unknown) =>
        hooks.get("before_provider_request")!({ payload }, ctx);
    return {
        hooks,
        entries,
        notices,
        ctx,
        observe,
        failWrites: () => {
            failWrite = true;
        },
    };
}

test("journals each request observation without retaining payload content", () => {
    const f = fixture();
    f.entries.push({
        type: "custom",
        customType: "pi-roles:active-role",
        data: {
            name: "reviewer",
            source: "project",
            path: "fixture",
            appliedAt: 1,
        },
    });
    const payload = {
        input: [],
        instructions: "private prompt",
        tool_choice: "auto",
        tools: [
            {
                type: "function",
                name: "read",
                description: "private description",
                parameters: { private: "schema" },
            },
            { type: "function", name: "later", defer_loading: true },
        ],
    };
    f.observe(payload);
    f.observe(payload);
    const audits = f.entries.filter(
        (e) => e.customType === "tool-policy:provider-request",
    );
    expect(audits).toHaveLength(2);
    expect(audits[0].data).toEqual({
        schemaVersion: 1,
        provider: "fixture",
        modelId: "model-a",
        roleName: "reviewer",
        api: "openai-responses",
        injected: false,
        observation: {
            supported: true,
            tools: [
                { name: "read", deferred: false },
                { name: "later", deferred: true },
            ],
            callableToolNames: ["read"],
            selection: { mode: "auto" },
        },
    });
    expect(JSON.stringify(audits)).not.toContain("private");
    expect(payload.instructions).toBe("private prompt");
});

for (const [choice, callable] of [
    ["none", []],
    [undefined, null],
    ["auto", ["read"]],
] as const) {
    test(`records selection ${choice} without guessing callability`, () => {
        const f = fixture();
        f.observe({
            input: [],
            instructions: "fixture",
            tool_choice: choice,
            tools: [{ type: "function", name: "read" }],
        });
        expect(f.entries.at(-1)?.data.observation.callableToolNames).toEqual(
            callable,
        );
        expect(f.entries.at(-1)?.data.roleName).toBeNull();
        f.ctx.model.id = "model-b";
        f.observe({
            input: [],
            instructions: "fixture",
            tool_choice: "auto",
            tools: [],
        });
        expect(f.entries.at(-1)?.data).toMatchObject({
            modelId: "model-b",
            observation: { tools: [], callableToolNames: [] },
        });
    });
}

test("records unsupported observations instead of a stale catalog", () => {
    const f = fixture();
    f.ctx.model.api = "future-api";
    f.observe({ private: "payload" });
    expect(f.entries.at(-1)?.data.observation).toEqual({
        supported: false,
        reason: "No tools-catalog adapter for future-api",
    });
});

test("warns on persistence failure and preserves custom prompt injection", () => {
    const f = fixture();
    f.hooks.get("before_agent_start")!(
        { systemPromptOptions: { customPrompt: "custom" } },
        f.ctx,
    );
    f.failWrites();
    const result = f.observe({
        input: [],
        instructions: "custom",
        tool_choice: "auto",
        tools: [],
    });
    expect(result.instructions).toContain("<pi-runtime-tools>");
    expect(f.notices).toEqual([
        "Tool catalog observation could not be saved to the session.",
    ]);
});
