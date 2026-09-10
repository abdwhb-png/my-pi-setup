import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSandboxConfig } from "./index.ts";
import { emptyGrants, saveProjectCapabilities } from "./capabilities/authority.ts";

const roots: string[] = [];

test("project preferences only narrow the chosen profile, filesystem and temporary namespace", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-preferences-")); roots.push(root);
    const agentDir = join(root, "agent"); const cwd = join(root, "project");
    mkdirSync(agentDir); mkdirSync(cwd); mkdirSync(join(cwd, "src"));
    await saveProjectCapabilities(join(agentDir, "sandbox.capabilities.json"), {
        projectRoot: cwd, profile: "integrated", grants: { ...emptyGrants(), host: true, hostTmp: true, writePaths: [root] },
    }, "test");
    const result = loadSandboxConfig(cwd, { agentDir, machineId: "test", settingsManager: {
        getGlobalSettings: () => ({ sandbox: { tmpNamespace: "host", network: { deniedDomains: ["blocked.test"] } } }),
        getProjectSettings: () => ({ sandbox: { profile: "host", tmpNamespace: "lease-private", filesystem: { allowWrite: ["./src"] }, network: { deniedDomains: [] } } }),
    } });
    expect(result.shell.profile).toBe("integrated");
    expect(result.config.tmpNamespace).toBe("lease-private");
    expect(result.config.filesystem.allowWrite).toEqual([join(cwd, "src")]);
    expect(result.config.network.deniedDomains).toContain("blocked.test");
});
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("a new installation starts isolated with no network destinations", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-isolation-"));
    roots.push(root);
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(agentDir);
    mkdirSync(cwd);
    const result = loadSandboxConfig(cwd, {
        agentDir,
        settingsManager: { getGlobalSettings: () => ({}), getProjectSettings: () => ({}) },
    });
    expect(result.config.enabled).toBe(true);
    expect(result.config.network.allowedDomains).toEqual([]);
    expect(result.config.network.allowedHostDomains).toEqual([]);
});

test("project settings cannot grant network or host execution", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-isolation-"));
    roots.push(root);
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(agentDir);
    mkdirSync(cwd);
    const result = loadSandboxConfig(cwd, {
        agentDir,
        settingsManager: {
            getGlobalSettings: () => ({}),
            getProjectSettings: () => ({ sandbox: {
                enabled: false,
                network: { allowedDomains: ["example.com"] },
            } }),
        },
    });
    expect(result.config.enabled).toBe(true);
    expect(result.config.network.allowedDomains).toEqual([]);
    expect(result.shell.state).toBe("migration-required");
});

test("a migrated local grant is reduced by project preferences", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-isolation-"));
    roots.push(root);
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(agentDir);
    mkdirSync(cwd);
    writeFileSync(join(agentDir, "sandbox.capabilities.json"), JSON.stringify({
        version: 1, machineId: "test-machine", projects: [{
            projectRoot: cwd, profile: "integrated", grants: {
                domains: ["example.com", "github.com"], hostDomains: [],
                readPaths: [], writePaths: [], hostTmp: false, host: false,
                integrations: {},
            },
        }],
    }), { mode: 0o600 });
    const result = loadSandboxConfig(cwd, {
        agentDir, machineId: "test-machine",
        settingsManager: {
            getGlobalSettings: () => ({}),
            getProjectSettings: () => ({ sandbox: {
                network: { allowedDomains: ["github.com", "unapproved.test"] },
            } }),
        },
    });
    expect(result.shell.state).toBe("ready");
    expect(result.shell.profile).toBe("integrated");
    expect(result.config.network.allowedDomains).toEqual(["github.com"]);
});
