import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { createTestSession } from "@abdwhb-png/pi-test-harness";
import overrides from "./index.ts";
import { getFileResolverConfig, setFileResolverConfig } from "./config.ts";

test.each([false, true])("project config reports required enrollment or restart when startup saves trust: %s", async (saveDuringStartup) => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    const previousConfig = getFileResolverConfig();
    const previousCwd = process.cwd();
    const root = mkdtempSync(join(tmpdir(), "config-trust-runtime-"));
    try {
        const agentDir = join(root, "agent"), cwd = join(root, "project");
        process.env.PI_CODING_AGENT_DIR = agentDir;
        mkdirSync(join(agentDir, "config"), { recursive: true });
        mkdirSync(join(cwd, ".pi/config"), { recursive: true });
        writeFileSync(join(agentDir, "config/pi-file-resolver.json"), JSON.stringify({ ls: { respectGitignore: true } }));
        writeFileSync(join(cwd, ".pi/config/pi-file-resolver.json"), JSON.stringify({ ls: { respectGitignore: false } }));
        process.chdir(cwd);
        const session = await createTestSession({ cwd, extensionFactories: [(pi) => {
            overrides(pi);
            if (saveDuringStartup) new ProjectTrustStore(agentDir).set(cwd, true);
        }] });
        try {
            expect(getFileResolverConfig().ls.respectGitignore).toBe(!saveDuringStartup);
            expect(session.events.uiCallsFor("notify").some(call => String(call.args[0]).includes(saveDuringStartup ? "Restart Pi" : "/trust"))).toBe(true);
            new ProjectTrustStore(agentDir).set(cwd, true);
            await session.session.extensionRunner!.emit({ type: "session_start", reason: "reload" });
            expect(getFileResolverConfig().ls.respectGitignore).toBe(false);
        } finally { session.dispose(); }
    } finally {
        process.chdir(previousCwd);
        setFileResolverConfig(previousConfig);
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
        rmSync(root, { recursive: true, force: true });
    }
});
