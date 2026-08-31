import { afterEach, describe, expect, it, mock } from "bun:test";
import {
    calls,
    createTestSession,
    says,
    type TestSession,
    when,
} from "@abdwhb-png/pi-test-harness";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const notificationEvents: unknown[] = [];
const interactionOrder: string[] = [];

mock.module("../notify/transport.ts", () => ({
    createNotificationTransport: () => ({
        send(event: { type: string }) {
            notificationEvents.push(event);
            interactionOrder.push(`notify:${event.type}`);
        },
    }),
}));

const { default: notifyExtension } = await import("../notify.ts");
const { default: dangerousModeExtension } = await import(
    "../pi-dangerous-mode/index.ts"
);

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

async function enableUnattended(session: TestSession): Promise<void> {
    const command = session.session.extensionRunner.getCommand("unattended");
    if (!command) throw new Error("Missing /unattended command");
    await command.handler(
        "on",
        session.session.extensionRunner.createCommandContext(),
    );
}

function actionNotifications(): unknown[] {
    return notificationEvents.filter(
        (event) =>
            typeof event === "object" &&
            event !== null &&
            "type" in event &&
            event.type === "action-required",
    );
}

describe("notify extension real Pi UI boundary", () => {
    let session: TestSession | undefined;

    afterEach(() => {
        session?.dispose();
        session = undefined;
        notificationEvents.length = 0;
        interactionOrder.length = 0;
    });

    it("notifies before real Pi renders an active agent prompt", async () => {
        session = await createTestSession({
            extensionFactories: [registerPromptFixture, notifyExtension],
            mockUI: {
                select: () => {
                    interactionOrder.push("ui:select");
                    return "choice";
                },
            },
        });

        await session.run(
            when("Open selection", [
                calls("prompt_select"),
                says("Selection completed."),
            ]),
        );

        expect(interactionOrder.slice(0, 2)).toEqual([
            "notify:action-required",
            "ui:select",
        ]);
        expect(actionNotifications()).toHaveLength(1);
        expect(session.events.uiCallsFor("select")).toHaveLength(1);
    });

    it("keeps direct idle UI silent", async () => {
        session = await createTestSession({
            extensionFactories: [notifyExtension],
            mockUI: {
                select: () => {
                    interactionOrder.push("ui:select");
                    return "choice";
                },
            },
        });

        await session.session.extensionRunner
            .createCommandContext()
            .ui.select("Idle selection", ["choice"]);

        expect(actionNotifications()).toHaveLength(0);
        expect(interactionOrder).toEqual(["ui:select"]);
    });

    it("lets Unattended suppress a prompt before notification observation", async () => {
        session = await createTestSession({
            extensionFactories: [
                registerPromptFixture,
                notifyExtension,
                dangerousModeExtension,
            ],
            mockUI: {
                select: () => {
                    interactionOrder.push("ui:select");
                    return "choice";
                },
            },
            propagateErrors: false,
        });
        await enableUnattended(session);

        await session.run(
            when("Open blocked selection", [
                calls("prompt_select"),
                says("Used a non-interactive path."),
            ]),
        );

        expect(actionNotifications()).toHaveLength(0);
        expect(session.events.uiCallsFor("select")).toHaveLength(0);
    });
});
