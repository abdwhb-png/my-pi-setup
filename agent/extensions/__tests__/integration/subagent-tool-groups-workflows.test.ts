import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestSession, type TestSession } from "@abdwhb-png/pi-test-harness";
import { publicExtensionEntrypoints } from "./public-extension-session.ts";

test("real Brainstorm and SDD factories keep workflow agents hidden and settings unchanged on startup and reload", async () => {
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    const root = mkdtempSync(join(tmpdir(), "subagent-workflow-visibility-"));
    let session: TestSession | undefined;
    try {
        process.env.PI_CODING_AGENT_DIR = root;
        const cwd = join(root,"project"); mkdirSync(cwd);
        const settingsPath = join(root,"settings.json");
        const bytes = JSON.stringify({subagents:{agentOverrides:{fixture:{model:"p/m"}}}});
        writeFileSync(settingsPath,bytes);
        session = await createTestSession({cwd, extensions:publicExtensionEntrypoints("brainstorm-forcer", "sdd-orchestrator", "pi-subagents-addons")});
        for (const name of ["brainstorm-scout", "sdd-worker", "sdd-qa-tester"]) expect(existsSync(join(root,"agents",name+".md"))).toBe(false);
        expect(readFileSync(settingsPath,"utf8")).toBe(bytes);
        await session.session.reload();
        expect(readFileSync(settingsPath,"utf8")).toBe(bytes);
        for (const name of ["brainstorm-scout", "sdd-worker"]) expect(existsSync(join(root,"agents",name+".md"))).toBe(false);
    } finally {
        session?.dispose();
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        rmSync(root,{recursive:true,force:true});
    }
});
