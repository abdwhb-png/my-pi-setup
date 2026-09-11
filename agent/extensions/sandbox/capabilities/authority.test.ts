import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalProjectPath, readGlobalSandboxConfig, readProjectSandboxConfig } from "./authority.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { force: true, recursive: true })));
function fixture() { const root = mkdtempSync(join(tmpdir(), "sandbox-authority-")); roots.push(root); const agent = join(root, "agent"); const project = join(root, "project"); mkdirSync(agent); mkdirSync(project); return { root, agent, project }; }

test("refuses a dangling global authority instead of treating it as absent", () => {
    const { agent } = fixture(); const path = join(agent, "sandbox.json"); symlinkSync(join(agent, "missing"), path);
    expect(() => readGlobalSandboxConfig(path, "machine")).toThrow("Untrusted global sandbox.json");
});
test("canonicalizes a project alias before applying a ceiling", () => {
    const { root, project } = fixture(); const outside = join(root, "outside"); mkdirSync(outside); symlinkSync(outside, join(project, "escape"));
    expect(canonicalProjectPath("escape/cache", project)).toBe(join(outside, "cache"));
});
test("requires owner-only versioned global config and rejects reserved project fields", () => {
    const { agent, project } = fixture(); const global = join(agent, "sandbox.json"); writeFileSync(global, JSON.stringify({ version: 2, machineId: "machine" }), { mode: 0o600 }); chmodSync(global, 0o600);
    expect(readGlobalSandboxConfig(global, "machine")?.version).toBe(2);
    const local = join(project, "sandbox.json"); writeFileSync(local, JSON.stringify({ version: 2 }));
    expect(() => readProjectSandboxConfig(local)).toThrow("reserved to global");
});
