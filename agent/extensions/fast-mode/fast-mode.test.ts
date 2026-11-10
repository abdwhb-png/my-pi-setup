import { afterEach, beforeEach, expect, test } from "bun:test";
import {
    createTestSession,
    type TestSession,
} from "@abdwhb-png/pi-test-harness";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import {
    FANCY_FOOTER_DISCOVER_WIDGETS_EVENT,
    type FancyFooterWidgetContribution,
} from "pi-fancy-footer/api";
import { useIsolatedAgentDir } from "../_shared/testing/config-fixture.ts";

useIsolatedAgentDir();
let t: TestSession;
let bus: ExtensionAPI["events"];

beforeEach(async () => {
    t = await createTestSession({
        extensions: [import.meta.dir + "/index.ts"],
        extensionFactories: [
            (pi: ExtensionAPI) => {
                bus = pi.events;
            },
        ],
    });
});
afterEach(async () => {
    await t?.close();
});

function runner() {
    const value = t.session.extensionRunner;
    if (!value) throw new Error("Missing real Pi extension runner");
    return value;
}

async function selectModel(
    provider = "openai-codex",
    api: Api = "openai-codex-responses",
) {
    const previousModel = t.session.agent.state.model;
    const model: Model<Api> = {
        ...previousModel,
        provider,
        api,
        id: "fixture",
    };
    t.session.agent.state.model = model;
    await runner().emit({
        type: "model_select",
        model,
        previousModel,
        source: "set",
    });
}

function discoverWidget() {
    const widgets: FancyFooterWidgetContribution[] = [];
    bus.emit(FANCY_FOOTER_DISCOVER_WIDGETS_EVENT, {
        registerWidget: (widget: FancyFooterWidgetContribution) =>
            widgets.push(widget),
    });
    expect(widgets).toHaveLength(1);
    return widgets[0]!;
}

function render(
    widget: FancyFooterWidgetContribution,
    theme: Pick<Theme, "fg"> = { fg: (_role, text) => text },
) {
    return widget.render({ theme } as Parameters<typeof widget.render>[0]);
}

const payload = {
    model: "fixture",
    input: [],
    stream: true,
    service_tier: "auto",
};

test("names and styles the active fast-mode provider through the shared color roles", async () => {
    await selectModel();
    const widget = discoverWidget();
    await t.session.prompt("/fast-mode on");
    const roles: Array<[string, string]> = [];
    const theme = {
        fg: (role: Parameters<Theme["fg"]>[0], text: string) => {
            roles.push([role, text]);
            return text;
        },
    };
    expect(render(widget, theme)).toBe("fast-mode:openai");
    expect(roles).toEqual([
        ["muted", "fast-mode"],
        ["dim", ":"],
        ["success", "openai"],
    ]);
    expect(widget.styled).toBe(true);
    await t.session.prompt("/fast-mode off");
    roles.length = 0;
    expect(render(widget, theme)).toBe("fast-mode:off");
    expect(roles).toEqual([
        ["muted", "fast-mode"],
        ["dim", ":"],
        ["dim", "off"],
    ]);
});

test("contributes a footer widget instead of an extension status", async () => {
    await selectModel();
    const widget = discoverWidget();
    expect(widget.id).toBe("fast-mode");
    expect(widget.placement).toBe("belowEditor");
    expect(render(widget)).toContain("off");
    expect(t.events.uiCallsFor("setStatus")).toHaveLength(0);
});

test("fast mode is off by default and on/off commands control priority without mutating input", async () => {
    await selectModel();
    const widget = discoverWidget();
    expect(await runner().emitBeforeProviderRequest(payload)).toEqual(payload);
    await t.session.prompt("/fast-mode on");
    expect(render(widget)).toBe("fast-mode:openai");
    expect(await runner().emitBeforeProviderRequest(payload)).toEqual({
        ...payload,
        service_tier: "priority",
    });
    expect(payload.service_tier).toBe("auto");
    await t.session.prompt("/fast-mode off");
    expect(render(widget)).toContain("off");
    expect(await runner().emitBeforeProviderRequest(payload)).toEqual(payload);
});

test.each(["openai-responses", "openai-completions"] as const)(
    "preserves priority support for native OpenAI %s",
    async (api) => {
        await selectModel("openai", api);
        await t.session.prompt("/fast-mode on");
        const request = { messages: [], extra: "preserved" };
        expect(await runner().emitBeforeProviderRequest(request)).toEqual({
            ...request,
            service_tier: "priority",
        });
    },
);

test.each([
    ["cpa", "openai-responses"],
    ["zai", "openai-completions"],
    ["anthropic", "anthropic-messages"],
    ["openai", "anthropic-messages"],
] as const)(
    "hides the widget and leaves unsupported %s/%s requests intact",
    async (provider, api) => {
        await selectModel();
        await t.session.prompt("/fast-mode on");
        const widget = discoverWidget();
        await selectModel(provider, api);
        expect(render(widget)).toBeNull();
        expect(await runner().emitBeforeProviderRequest(payload)).toEqual(
            payload,
        );
        await t.session.prompt("/fast-mode status");
        expect(t.events.uiCallsFor("notify").at(-1)?.args[0]).toContain(
            "unavailable",
        );
        await selectModel();
        expect(render(widget)).toBe("fast-mode:openai");
    },
);

test("retains the Codex command alias and validates arguments without changing state", async () => {
    await selectModel();
    await t.session.prompt("/codex-fast-mode on");
    const widget = discoverWidget();
    expect(render(widget)).toBe("fast-mode:openai");
    await t.session.prompt("/fast-mode invalid");
    expect(t.events.uiCallsFor("notify").at(-1)?.args).toEqual([
        expect.stringContaining("Usage: /fast-mode"),
        "warning",
    ]);
    expect(render(widget)).toBe("fast-mode:openai");
    await t.session.prompt("/fast-mode status");
    expect(t.events.uiCallsFor("notify").at(-1)?.args[0]).toContain("enabled");
    await t.session.prompt("/fast-mode");
    expect(render(widget)).toBe("fast-mode:openai");
});

test("offers command completions and clears its widget on shutdown", async () => {
    await selectModel();
    const command = runner().getCommand("fast-mode");
    expect(command?.getArgumentCompletions?.("o")).toEqual([
        { value: "on", label: "on" },
        { value: "off", label: "off" },
    ]);
    expect(command?.getArgumentCompletions?.("bad")).toBeNull();
    const widget = discoverWidget();
    await runner().emit({ type: "session_shutdown", reason: "quit" });
    expect(render(widget)).toBeNull();
});

test("updates its widget on session start and ignores non-object payloads", async () => {
    await selectModel();
    await runner().emit({ type: "session_start", reason: "reload" });
    expect(render(discoverWidget())).toContain("off");
    await t.session.prompt("/fast-mode on");
    for (const value of [null, [], "payload"]) {
        expect(await runner().emitBeforeProviderRequest(value)).toEqual(value);
    }
});
