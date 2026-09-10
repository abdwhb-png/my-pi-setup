import { expect, test } from "bun:test";
import { createTestSession } from "@abdwhb-png/pi-test-harness";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import activate from "./quit-and-delete.ts";

test.each([
    ["ctrl+shift+x", "ctrl+shift+x"],
    ["super+alt+f12", "super+alt+f12"],
    ["pageUp", "pageUp"],
    ["ctrl+ctrl+x", "ctrl+shift+x"],
    ["ctrl+unknown", "ctrl+shift+x"],
    ["invalid", "ctrl+shift+x"],
])("validates the configured shortcut %s before registration", async (input, expected) => {
    const previous = process.env.PI_QUIT_AND_DELETE_SHORTCUT;
    process.env.PI_QUIT_AND_DELETE_SHORTCUT = input;
    const shortcuts: string[] = [];
    let session: Awaited<ReturnType<typeof createTestSession>> | undefined;
    try {
        session = await createTestSession({ extensionFactories: [(pi: ExtensionAPI) => {
            const register = pi.registerShortcut.bind(pi);
            pi.registerShortcut = (key, options) => {
                shortcuts.push(key);
                register(key, options);
            };
            activate(pi);
        }] });
        expect(shortcuts).toEqual([expected]);
    } finally {
        session?.dispose();
        if (previous === undefined) delete process.env.PI_QUIT_AND_DELETE_SHORTCUT;
        else process.env.PI_QUIT_AND_DELETE_SHORTCUT = previous;
    }
});
