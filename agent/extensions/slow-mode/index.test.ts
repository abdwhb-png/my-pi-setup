import { expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import slowMode from "./index.ts";

test("slow-mode loads and starts with the installed MCP adapter", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "slow-mode-extension-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const previousCwd = process.cwd();
    const handlers = new Map<string, (event: object, ctx: object) => unknown>();
    const notify = mock();
    const pi = {
        on: (event: string, handler: (event: object, ctx: object) => unknown) => {
            handlers.set(event, handler);
        },
        registerCommand() {},
        registerTool() {},
        getActiveTools: () => ["write", "edit", "bash", "safe_bash"],
    } as unknown as ExtensionAPI;

    try {
        process.env.PI_CODING_AGENT_DIR = agentDir;
        process.chdir(agentDir);
        slowMode(pi);
        const start = handlers.get("session_start");
        expect(start).toBeDefined();
        await start!({}, {
            cwd: agentDir,
            hasUI: false,
            ui: { notify },
            sessionManager: { getEntries: () => [] },
        });
        expect(notify).not.toHaveBeenCalled();
    } finally {
        process.chdir(previousCwd);
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        rmSync(agentDir, { recursive: true, force: true });
    }
});
