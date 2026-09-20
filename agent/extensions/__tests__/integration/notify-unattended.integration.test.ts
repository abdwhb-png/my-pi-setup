import { afterEach, expect, test } from "bun:test";
import {
    calls,
    createTestSession,
    says,
    type TestSession,
    when,
} from "@abdwhb-png/pi-test-harness";
import type {
    ExtensionAPI,
    ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { publicExtensionEntrypoints } from "./public-extension-session.ts";

let session: TestSession | undefined;

afterEach(() => {
    session?.dispose();
    session = undefined;
});

function registerPromptFixture(pi: ExtensionAPI): void {
    pi.registerTool({
        name: "prompt_select",
        label: "Prompt select",
        description: "Open generic selection UI.",
        parameters: Type.Object({}),
        async execute(_id, _params, _signal, _onUpdate, ctx) {
            const answer = await ctx.ui.select("Choose", ["choice"]);
            return {
                content: [{ type: "text", text: String(answer) }],
                details: {},
            };
        },
    });
}

function registerCustomPromptFixture(pi: ExtensionAPI): void {
    pi.registerTool({
        name: "prompt_custom",
        label: "Prompt custom",
        description: "Open generic custom UI.",
        parameters: Type.Object({}),
        async execute(_id, _params, _signal, _onUpdate, ctx) {
            await ctx.ui.custom(() => ({ render: () => [], invalidate() {} }));
            return {
                content: [{ type: "text", text: "custom UI completed" }],
                details: {},
            };
        },
    });
}

function installCustomUiFixture(current: TestSession): string[] {
    const interactions: string[] = [];
    const runner = current.session.extensionRunner;
    const custom: ExtensionUIContext["custom"] = async () => {
        interactions.push("ui:custom");
        return undefined as never;
    };
    runner.setUIContext({ ...runner.getUIContext(), custom }, "tui");
    return interactions;
}

async function enableUnattended(current: TestSession): Promise<void> {
    const command = current.session.extensionRunner.getCommand("unattended");
    if (!command) throw new Error("Missing /unattended command");
    await command.handler(
        "on",
        current.session.extensionRunner.createCommandContext(),
    );
}

test("Unattended suppresses a selection before Notify observes it", async () => {
    session = await createTestSession({
        extensions: publicExtensionEntrypoints("notify", "pi-dangerous-mode"),
        extensionFactories: [registerPromptFixture],
        mockUI: { select: () => "choice" },
        propagateErrors: false,
    });
    await enableUnattended(session);

    await session.run(
        when("Open blocked selection", [
            calls("prompt_select"),
            says("Used a non-interactive path."),
        ]),
    );

    expect(session.events.uiCallsFor("select")).toHaveLength(0);
});

test("Unattended suppresses a custom UI before Notify observes it", async () => {
    session = await createTestSession({
        extensions: publicExtensionEntrypoints("notify", "pi-dangerous-mode"),
        extensionFactories: [registerCustomPromptFixture],
        propagateErrors: false,
    });
    const interactions = installCustomUiFixture(session);
    await enableUnattended(session);

    await session.run(
        when("Open blocked custom UI", [
            calls("prompt_custom"),
            says("Used a non-interactive path."),
        ]),
    );

    expect(interactions).not.toContain("ui:custom");
});
