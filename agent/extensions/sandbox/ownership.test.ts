import { expect, test } from "bun:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import sandboxExtension from "./index.ts";

test("sandbox registers no Bash tools or user_bash hook", () => {
    const tools: string[] = [];
    const hooks: string[] = [];
    const pi = {
        registerFlag: () => undefined,
        registerTool: (definition: { name: string }) => {
            tools.push(definition.name);
        },
        registerCommand: () => undefined,
        on: (event: string) => hooks.push(event),
        getFlag: () => false,
    } as unknown as ExtensionAPI;

    sandboxExtension(pi);

    expect(tools).toEqual([]);
    expect(hooks).not.toContain("user_bash");
});
