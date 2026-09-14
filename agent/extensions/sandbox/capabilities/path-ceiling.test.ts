import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSandboxConfig } from "../index.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture() {
    const root = mkdtempSync(join(tmpdir(), "pi-path-ceiling-"));
    roots.push(root);
    const agentDir = join(root, "agent");
    const project = join(root, "project");
    const external = join(root, "external");
    mkdirSync(agentDir);
    mkdirSync(join(project, ".pi"), { recursive: true });
    mkdirSync(external);
    const globalPath = join(agentDir, "sandbox.json");
    const projectPath = join(project, ".pi", "sandbox.json");
    writeFileSync(globalPath, JSON.stringify({ version: 2, machineId: "test", filesystem: { allowRead: ["."], allowWrite: ["."] } }));
    return { project, external, globalPath, projectPath, load: () => loadSandboxConfig(project, { agentDir, machineId: "test" }) };
}

test.each(["allowRead", "allowWrite"] as const)("rejects project %s outside the global ceiling with actionable paths", (field) => {
    const f = fixture();
    writeFileSync(f.projectPath, JSON.stringify({ filesystem: { [field]: [".", f.external] } }));
    expect(f.load).toThrow(f.external);
    expect(f.load).toThrow(f.projectPath);
    expect(f.load).toThrow(f.globalPath);
    expect(f.load).toThrow(`filesystem.${field}`);
    expect(f.load).toThrow("outside the global ceiling");
});

test("accepts project descendants within the ceiling and preserves explicit denials", () => {
    const f = fixture();
    const selected = join(f.project, "src");
    const denied = join(selected, "private");
    writeFileSync(f.projectPath, JSON.stringify({ filesystem: { allowRead: [selected], allowWrite: [selected], denyRead: [denied], denyWrite: [denied] } }));
    const { config } = f.load();
    expect(config.filesystem.allowRead).toContain(selected);
    expect(config.filesystem.allowWrite).toContain(selected);
    expect(config.filesystem.denyRead).toContain(denied);
    expect(config.filesystem.denyWrite).toContain(denied);
});

test("a global directory grant covers a project's external descendant selection", () => {
    const f = fixture();
    const selected = join(f.external, "frontend");
    const denied = join(selected, "secret");
    writeFileSync(f.globalPath, JSON.stringify({ version: 2, machineId: "test", filesystem: { allowRead: [".", f.external], denyRead: [denied] } }));
    writeFileSync(f.projectPath, JSON.stringify({ filesystem: { allowRead: [".", selected] } }));
    const { config } = f.load();
    expect(config.filesystem.allowRead).toContain(selected);
    expect(config.filesystem.allowRead).not.toContain(f.external);
    expect(config.filesystem.denyRead).toContain(denied);
    expect(config.filesystem.allowWrite).not.toContain(selected);
});
