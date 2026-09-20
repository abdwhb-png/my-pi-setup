import { afterEach, describe, expect, it, mock } from "bun:test";
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
import { requestPermissionDecisionFromUi } from "../../npm/node_modules/@gotgenes/pi-permission-system/src/authority/permission-dialog.ts";

const notificationEvents: unknown[] = [];
const interactionOrder: string[] = [];

mock.module("./transport.ts", () => ({
    createNotificationTransport: () => ({
        send(event: { type: string }) {
            notificationEvents.push(event);
            interactionOrder.push(`notify:${event.type}`);
        },
    }),
}));

const { default: notifyExtension } = await import("../notify.ts");

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

function registerPermissionPromptFixture(pi: ExtensionAPI): void {
    pi.registerTool({
        name: "permission_prompt",
        label: "Permission prompt",
        description: "Open the installed permission-system approval UI.",
        parameters: Type.Object({}),
        async execute(_id, _params, _signal, _onUpdate, ctx) {
            await requestPermissionDecisionFromUi(
                ctx.ui,
                "Permission required",
                "Allow this test action?",
            );
            return {
                content: [{ type: "text", text: "permission UI completed" }],
                details: {},
            };
        },
    });
}

function installCustomUiFixture(session: TestSession): void {
    const runner = session.session.extensionRunner;
    const custom: ExtensionUIContext["custom"] = async () => {
        interactionOrder.push("ui:custom");
        return undefined as never;
    };
    runner.setUIContext({ ...runner.getUIContext(), custom }, "tui");
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

    it("notifies before a third-party custom UI renders", async () => {
        session = await createTestSession({
            extensionFactories: [registerCustomPromptFixture, notifyExtension],
        });
        installCustomUiFixture(session);

        await session.run(
            when("Open custom UI", [
                calls("prompt_custom"),
                says("Custom UI completed."),
            ]),
        );

        expect(interactionOrder.slice(0, 2)).toEqual([
            "notify:action-required",
            "ui:custom",
        ]);
        expect(actionNotifications()).toHaveLength(1);
    });

    it("observes the installed permission-system approval UI", async () => {
        session = await createTestSession({
            extensionFactories: [registerPermissionPromptFixture, notifyExtension],
            mockUI: {
                select: () => {
                    interactionOrder.push("ui:select");
                    return "Yes";
                },
            },
        });

        await session.run(
            when("Request permission", [
                calls("permission_prompt"),
                says("Permission UI completed."),
            ]),
        );

        expect(interactionOrder.slice(0, 2)).toEqual([
            "notify:action-required",
            "ui:select",
        ]);
        expect(actionNotifications()).toHaveLength(1);
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

});
