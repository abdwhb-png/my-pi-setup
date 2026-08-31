import { beforeEach, describe, expect, it, mock } from "bun:test";
import {
    createExtensionRuntime,
    ExtensionRunner,
    type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { installUiBrokerPatches } from "./ui-broker.ts";

let unattended = false;
let agentActive = true;

beforeEach(() => {
    unattended = false;
    agentActive = true;
    expect(installUiBrokerPatches({
        isEnabled: () => unattended,
        isAgentActive: () => agentActive,
    }, { runner: ExtensionRunner, interactiveMode: class {} })).toBe(false);
});

describe("Unattended UI broker", () => {
    it("blocks standard UI before rendering and permits idle custom UI", async () => {
        const select = mock(async () => "choice");
        const custom = mock(async () => "dashboard");
        const ui = { select, custom } as unknown as ExtensionUIContext;
        const runner = new ExtensionRunner([], createExtensionRuntime(), "/tmp/unattended-ui", {} as never, {} as never);
        runner.setUIContext(ui, "tui");
        unattended = true;

        let blocked: unknown;
        try {
            await Promise.resolve(
                runner.createContext().ui.select("Pick", ["choice"]),
            );
        } catch (error) {
            blocked = error;
        }
        expect(blocked).toMatchObject({ code: "UNATTENDED_PROMPT_BLOCKED" });
        expect(select).not.toHaveBeenCalled();

        agentActive = false;
        const result = await Promise.resolve(
            runner.createContext().ui.custom(() => ({}) as never),
        );
        expect(result).toBe("dashboard");
        expect(custom).toHaveBeenCalledTimes(1);
    });
});
