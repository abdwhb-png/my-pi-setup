import { describe, expect, it } from "bun:test";

function createExtensionApi() {
    const commands: string[] = [];

    return {
        api: {
            getActiveTools: () => [],
            on: () => undefined,
            registerCommand: (name: string) => commands.push(name),
            registerTool: () => undefined,
            setActiveTools: () => undefined,
        },
        commands,
    };
}

describe("pi-ghost", () => {
    it("registers ghost overlay command", async () => {
        const { default: ghostExtension } = await import("./pi-ghost.ts");
        const { api, commands } = createExtensionApi();

        ghostExtension(api as never);

        expect(commands).toEqual(["gpi"]);
    }, 15_000);
});
