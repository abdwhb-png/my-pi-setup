import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGlobalSandboxConfig, readProjectSandboxConfig } from "./authority.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { force: true, recursive: true })));

test("reads only a versioned global authority and rejects global fields from a project", () => {
    const root = mkdtempSync(join(tmpdir(), "sandbox-active-authority-"));
    roots.push(root);
    const agent = join(root, "agent");
    const project = join(root, "project");
    mkdirSync(agent); mkdirSync(join(project, ".pi"), { recursive: true });
    const globalPath = join(agent, "sandbox.json");
    writeFileSync(globalPath, JSON.stringify({ version: 2, machineId: "machine", network: { allowedDomains: ["example.com"] } }), { mode: 0o600 });
    chmodSync(globalPath, 0o600);
    writeFileSync(join(project, ".pi", "sandbox.json"), JSON.stringify({ machineId: "machine", network: { allowedDomains: [] } }), { mode: 0o600 });

    expect(readGlobalSandboxConfig(globalPath, "machine")?.network).toEqual({ allowedDomains: ["example.com"] });
    expect(() => readProjectSandboxConfig(join(project, ".pi", "sandbox.json"))).toThrow("reserved to global");
});

test("rejects unknown and malformed nested active settings", () => {
    const root = mkdtempSync(join(tmpdir(), "sandbox-active-authority-"));
    roots.push(root);
    const agent = join(root, "agent");
    const project = join(root, "project");
    mkdirSync(agent);
    mkdirSync(project);
    const globalPath = join(agent, "sandbox.json");
    writeFileSync(
        globalPath,
        JSON.stringify({
            version: 2,
            machineId: "machine",
            environment: { variables: { LANG: false } },
        }),
        { mode: 0o600 },
    );

    expect(() => readGlobalSandboxConfig(globalPath, "machine")).toThrow(
        "Sandbox policy is invalid",
    );
    writeFileSync(
        join(project, "sandbox.json"),
        JSON.stringify({ network: { allowLocalBnding: false } }),
        { mode: 0o600 },
    );
    expect(() => readProjectSandboxConfig(join(project, "sandbox.json"))).toThrow(
        "Unknown project.network field",
    );
});
