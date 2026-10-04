import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { createTestSession } from "@abdwhb-png/pi-test-harness";
import sandboxExtension, { loadSandboxConfig, persistProjectDockerPreference } from "./index.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
    const root = mkdtempSync(join(tmpdir(), "sandbox-config-boundary-"));
    roots.push(root);
    const agentDir = join(root, "agent"), cwd = join(root, "project");
    mkdirSync(join(agentDir, "config"), { recursive: true });
    mkdirSync(join(cwd, ".pi/config"), { recursive: true });
    return { agentDir, cwd, projectPath: join(cwd, ".pi/config/sandbox.json") };
}

test.each([null, false])("sandbox does not read or write project config without saved trust (%s)", async (decision) => {
    const { agentDir, cwd, projectPath } = fixture();
    new ProjectTrustStore(agentDir).set(cwd, decision);
    writeFileSync(projectPath, "malformed and untrusted");
    expect(loadSandboxConfig(cwd, { agentDir, projectTrusted: true }).source).toBe("default");
    await expect(persistProjectDockerPreference(cwd, "off", agentDir)).rejects.toThrow("saved project trust");
    expect(readFileSync(projectPath, "utf8")).toBe("malformed and untrusted");
    new ProjectTrustStore(agentDir).set(cwd, true);
    expect(() => loadSandboxConfig(cwd, { agentDir, projectTrusted: true })).toThrow();
    expect(loadSandboxConfig(cwd, { agentDir, projectTrusted: false }).source).toBe("default");
});

test.each(["global-legacy", "project-legacy", "global-marker", "canonical-marker"])("Docker preference refuses %s before creating canonical state", async (kind) => {
    const { agentDir, cwd, projectPath } = fixture();
    new ProjectTrustStore(agentDir).set(cwd, true);
    const path = kind === "project-legacy" ? join(cwd, ".pi/sandbox.json") : kind === "canonical-marker" ? join(agentDir, "config/sandbox.json.migration") : join(agentDir, kind === "global-legacy" ? "sandbox.json" : "sandbox.json.migration");
    writeFileSync(path, "{}");
    await expect(persistProjectDockerPreference(cwd, "off", agentDir)).rejects.toThrow();
    expect(existsSync(projectPath)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("{}");
});

test.each(["sandbox.json", "sandbox.json.migration", "config/sandbox.json.migration"])("installation UI refuses pending %s before offering writes", async (legacy) => {
    const { agentDir, cwd } = fixture();
    new ProjectTrustStore(agentDir).set(cwd, true);
    writeFileSync(join(agentDir, legacy), "{}");
    const previous = process.env.PI_CODING_AGENT_DIR;
    try {
        process.env.PI_CODING_AGENT_DIR = agentDir;
        const session = await createTestSession({ cwd, extensionFactories: [sandboxExtension], mockUI: { select: "Global: Add", input: "tools", editor: "[]", confirm: true } });
        try {
            await session.session.prompt("/sandbox installations");
            expect(session.events.uiCallsFor("select")).toHaveLength(0);
            expect(session.events.uiCallsFor("notify").some(call => /migration|migrat/i.test(String(call.args[0])))).toBe(true);
            expect(existsSync(join(agentDir, "config/sandbox.json"))).toBe(false);
        } finally {
            await session.session.extensionRunner!.emit({ type: "session_shutdown", reason: "quit" });
            session.dispose();
        }
    } finally {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
    }
});
