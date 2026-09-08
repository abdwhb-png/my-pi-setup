import { beforeEach, describe, expect, it } from "bun:test";
import {
    UIPromptBlockedError,
    type ExtensionAPI,
    type UIPromptBeforeEvent,
    type UIPromptBeforeEventResult,
} from "@earendil-works/pi-coding-agent";
import {
    getMutableRuntimeState,
    getRuntimeStatus,
    setUnattendedOverride,
    startRuntimeSession,
} from "./runtime-state.ts";
import { installUiPromptGuard } from "./ui-prompt-guard.ts";

type PromptHandler = (
    event: UIPromptBeforeEvent,
) => UIPromptBeforeEventResult | void | Promise<UIPromptBeforeEventResult | void>;

const config = { protectedTools: [], protectedExtensions: [] };

function createPiFixture(): {
    pi: ExtensionAPI;
    getHandler(): PromptHandler | undefined;
} {
    let handler: PromptHandler | undefined;
    const pi = {
        on(event: string, candidate: PromptHandler) {
            if (event === "ui_prompt_before") handler = candidate;
        },
    } as unknown as ExtensionAPI;
    return { pi, getHandler: () => handler };
}

beforeEach(() => {
    const state = getMutableRuntimeState();
    state.compatible = true;
    state.uiPromptGuardCompatible = true;
    startRuntimeSession({ isReload: false, dangerousFlag: false, config });
});

describe("Unattended UI prompt guard", () => {
    it("blocks structured prompts and only active custom prompts", async () => {
        let agentActive = true;
        const fixture = createPiFixture();
        expect(
            installUiPromptGuard(fixture.pi, {
                isEnabled: () => getRuntimeStatus().unattended.effective,
                isAgentActive: () => agentActive,
            }),
        ).toBe(true);
        expect(setUnattendedOverride(true)).toBe(true);

        const handler = fixture.getHandler();
        expect(handler).toBeDefined();
        if (!handler) return;

        for (const kind of ["select", "confirm", "input", "editor"] as const) {
            await expect(
                Promise.resolve(
                    handler({ type: "ui_prompt_before", reason: "ui_prompt", kind }),
                ),
            ).resolves.toMatchObject({ block: true });
        }

        await expect(
            Promise.resolve(
                handler({ type: "ui_prompt_before", reason: "ui_prompt", kind: "custom" }),
            ),
        ).resolves.toMatchObject({ block: true });
        agentActive = false;
        await expect(
            Promise.resolve(
                handler({ type: "ui_prompt_before", reason: "ui_prompt", kind: "custom" }),
            ),
        ).resolves.toBeUndefined();
    });

    it("disables Unattended when the public API marker is absent", () => {
        const fixture = createPiFixture();

        expect(
            installUiPromptGuard(
                fixture.pi,
                { isEnabled: () => true, isAgentActive: () => true },
                {},
            ),
        ).toBe(false);
        expect(fixture.getHandler()).toBeUndefined();
        expect(getRuntimeStatus().compatible.uiPromptGuard).toBe(false);
        expect(setUnattendedOverride(true)).toBe(false);
    });

    it("recognizes the public blocked-error marker", () => {
        const fixture = createPiFixture();

        expect(
            installUiPromptGuard(
                fixture.pi,
                { isEnabled: () => false, isAgentActive: () => false },
                { UIPromptBlockedError },
            ),
        ).toBe(true);
        expect(fixture.getHandler()).toBeDefined();
    });
});
