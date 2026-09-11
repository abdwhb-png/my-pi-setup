import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadSandboxConfig } from "../index.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

function fixture(global: Record<string, unknown>, project: Record<string, unknown> = {}) {
    const root = mkdtempSync(join(tmpdir(), "host-authorization-"));
    roots.push(root);
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(agentDir);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(agentDir, "sandbox.json"), JSON.stringify({ version: 2, machineId: "machine", ...global }), { mode: 0o600 });
    writeFileSync(join(cwd, ".pi/sandbox.json"), JSON.stringify(project), { mode: 0o600 });
    return { cwd, options: { agentDir, machineId: "machine" } };
}

test("host authorization permits explicit selection without selecting host on startup", () => {
    const { cwd, options } = fixture({ host: { allowed: true } });
    expect(loadSandboxConfig(cwd, options).shell.mode).toBe("sandbox");
    expect(loadSandboxConfig(cwd, { ...options, session: { mode: "host" } }).shell.mode).toBe("host");
});

test("explicit denial wins over the legacy host field and projects cannot grant host", () => {
    const { cwd, options } = fixture({ mode: "host", host: { allowed: false } });
    expect(loadSandboxConfig(cwd, options).shell.diagnostic).toContain("Deprecated global mode");
    expect(() => loadSandboxConfig(cwd, { ...options, session: { mode: "host" } })).toThrow("outside the global ceiling");
    const projectGrant = fixture({ host: { allowed: true } }, { host: { allowed: true } });
    expect(() => loadSandboxConfig(projectGrant.cwd, projectGrant.options)).toThrow("Unknown project sandbox config field: host");
});

test.each([{}, { mode: "sandbox" }])("host remains denied by default: %j", global => {
    const { cwd, options } = fixture(global);
    expect(() => loadSandboxConfig(cwd, { ...options, session: { mode: "host" } })).toThrow("outside the global ceiling");
});

test("configured home-relative environment paths expand without expanding shell expressions or filesystem grants", () => {
    const { cwd, options } = fixture({ environment: { variables: { DATA_ROOT: "~/data", LITERAL: "$HOME/data", COMMAND: "$(id)" } } });
    const { config } = loadSandboxConfig(cwd, options);
    expect(config.environment.variables).toEqual({ DATA_ROOT: join(homedir(), "data"), LITERAL: "$HOME/data", COMMAND: "$(id)" });
    expect(config.filesystem.allowRead).not.toContain(join(homedir(), "data"));
});
