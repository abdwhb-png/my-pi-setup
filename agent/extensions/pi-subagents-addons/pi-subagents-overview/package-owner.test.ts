import { expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as os from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
const realOs = { ...os };

test("overview acquires builtins from the configured trusted project owner", async () => {
    const root = mkdtempSync(join(tmpdir(), "overview-package-owner-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    const output = spyOn(console, "log").mockImplementation(() => {});
    try {
        const agentDir = join(root, "agent"), cwd = join(root, "project"), pkg = join(root, "package");
        mkdirSync(agentDir); mkdirSync(join(cwd, ".pi"), { recursive: true }); mkdirSync(join(pkg, "agents"), { recursive: true });
        process.env.PI_CODING_AGENT_DIR = agentDir;
        mock.module("node:os", () => ({ ...realOs, homedir: () => root }));
        const { default: registerOverview } = await import("./index.ts");
        writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ packages: [pkg] }));
        writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "pi-subagents", exports: { "./preflight": "./preflight.ts" } }));
        writeFileSync(join(pkg, "preflight.ts"), "export {};\n");
        writeFileSync(join(pkg, "agents", "scout.md"), "---\nname: scout\ndescription: Configured project owner marker\ntools: read\n---\n");
        let command: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
        const pi = {
            events: { on: () => () => {}, emit: () => {} }, on: () => {}, registerMessageRenderer: () => {},
            registerCommand: (name: string, value: { handler: typeof command }) => { if (name === "subagents-overview") command = value.handler; },
        } as unknown as ExtensionAPI;
        registerOverview(pi);
        await command!("", { cwd, mode: "print", hasUI: false, isProjectTrusted: () => true } as ExtensionCommandContext);
        expect(output.mock.calls.map(call => call[0]).join("\n")).toContain("Configured project owner marker");
    } finally {
        output.mockRestore();
        mock.module("node:os", () => realOs);
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
        rmSync(root, { recursive: true, force: true });
    }
});
