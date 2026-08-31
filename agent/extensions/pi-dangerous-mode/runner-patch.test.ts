/// <reference types="bun" />
import { afterEach, describe, expect, it, mock } from "bun:test";
import {
    createExtensionRuntime,
    ExtensionRunner,
    type Extension,
    type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { installRunnerPatch } from "./runner-patch.ts";
import {
    getMutableRuntimeState,
    setDangerousRuntimeState,
    setUnattendedOverride,
} from "./runtime-state.ts";

function runner(extensions: Extension[] = []): ExtensionRunner {
    return new ExtensionRunner(extensions, createExtensionRuntime(), "/tmp/unattended", {} as never, {} as never);
}

function call(name: string): ToolCallEvent {
    return { type: "tool_call", toolCallId: "id", toolName: name, input: {} };
}

afterEach(() => {
    setDangerousRuntimeState({ enabled: false, config: { protectedTools: [], protectedExtensions: [] } });
});

describe("Unattended runner boundary", () => {
    it("replaces a legacy installed wrapper after reload", async () => {
        const original = ExtensionRunner.prototype.emitToolCall;
        const state = getMutableRuntimeState();
        state.installed = true;
        state.original = original;
        (state as typeof state & { runnerPatchVersion?: number }).runnerPatchVersion = 1;
        ExtensionRunner.prototype.emitToolCall = async () => undefined;

        expect(installRunnerPatch()).toBe(true);
        expect(setUnattendedOverride(true)).toBe(true);

        const result = await runner().emitToolCall(call("ask_user_question"));
        expect(result).toMatchObject({
            block: true,
            reason: expect.stringContaining("UNATTENDED_PROMPT_BLOCKED"),
        });
    });

    it("blocks ask_user_question before extension handlers without enabling Dangerous", async () => {
        const handler = mock(() => ({ block: false }));
        const extension = {
            path: "ask.ts",
            resolvedPath: "ask.ts",
            sourceInfo: {} as never,
            handlers: new Map([["tool_call", [handler]]]),
            tools: new Map(), messageRenderers: new Map(), commands: new Map(), flags: new Map(), shortcuts: new Map(),
        } as unknown as Extension;
        installRunnerPatch();
        expect(setUnattendedOverride(true)).toBe(true);

        const result = await runner([extension]).emitToolCall(call("ask_user_question"));

        expect(result).toMatchObject({ block: true, reason: expect.stringContaining("UNATTENDED_PROMPT_BLOCKED") });
        expect(handler).not.toHaveBeenCalled();
    });
});
