import { expect, mock, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSubagentPackage } from "../../_shared/subagents/index.ts";
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
        const nativeRoot = dirname(realpathSync(fileURLToPath(import.meta.resolve("pi-subagents"))));
        writeFileSync(join(agentDir, "settings.json"), JSON.stringify({packages:[nativeRoot]}));
        const native = await resolveSubagentPackage(cwd, agentDir, false);
        expect(native.agents).toBeDefined();
        writeFileSync(join(agentDir, "settings.json"), "{}");
        writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ packages: [pkg] }));
        writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "pi-subagents", exports: { "./preflight": "./preflight.ts", "./agents":"./agents.ts" }, "pi-subagents":{agents:["agents"]} }));
        writeFileSync(join(pkg, "preflight.ts"), "export {};\n");
        writeFileSync(join(pkg, "agents.ts"), `export {discoverAgents} from ${JSON.stringify(native.agents)};\n`);
        writeFileSync(join(pkg, "agents", "scout.md"), "---\nname: scout\npackage: fixture-owner\ndescription: Configured project owner marker\ntools: read\n---\n");
        let command: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
        const pi = {
            events: { on: () => () => {}, emit: () => {} }, on: () => {}, registerMessageRenderer: () => {},
            registerCommand: (name: string, value: { handler: typeof command }) => { if (name === "subagents-overview") command = value.handler; },
        } as unknown as ExtensionAPI;
        registerOverview(pi);
        await command!("", { cwd, mode: "print", hasUI: false, isProjectTrusted: () => true } as ExtensionCommandContext);
        const rendered = Bun.stripANSI(output.mock.calls.map(call => call[0]).join("\n"));
        expect(rendered).toContain("Configured project owner marker");
        expect(rendered).toContain("fixture-owner.scout");
        expect(rendered).toContain("Tools: read");
        expect(rendered).not.toContain("Unavailable");
    } finally {
        output.mockRestore();
        mock.module("node:os", () => realOs);
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
        rmSync(root, { recursive: true, force: true });
    }
});
