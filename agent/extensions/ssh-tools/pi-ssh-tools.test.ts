import { describe, expect, it } from "bun:test";

function createExtensionApi() {
    const tools: string[] = [];

    return {
        api: {
            getActiveTools: () => [],
            on: () => undefined,
            registerCommand: () => undefined,
            registerTool: ({ name }: { name: string }) => tools.push(name),
            setActiveTools: () => undefined,
        },
        tools,
    };
}

describe("pi-ssh-tools", () => {
    it("registers SSH tools", async () => {
        const { default: sshToolsExtension } = await import("./pi-ssh-tools.ts");
        const { api, tools } = createExtensionApi();

        sshToolsExtension(api as never);

        expect(tools).toEqual(["ssh_read", "ssh_write", "ssh_edit", "ssh_bash"]);
    }, 15_000);
});
