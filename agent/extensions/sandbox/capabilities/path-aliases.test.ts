import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSandboxConfig } from "../index.ts";

test("legacy read aliases survive canonical ceiling checks without widening a project selection", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-policy-alias-"));
    const agentDir = join(root, "agent");
    const project = join(root, "project");
    const real = join(root, "real");
    const alias = join(root, "alias");
    try {
        mkdirSync(agentDir);
        mkdirSync(join(project, ".pi"), { recursive: true });
        mkdirSync(real);
        writeFileSync(join(real, "loader"), "loader");
        writeFileSync(join(real, "neighbor"), "private");
        symlinkSync(real, alias);
        writeFileSync(join(agentDir, "sandbox.json"), JSON.stringify({ version: 2, machineId: "test", filesystem: { allowRead: [alias] } }));
        writeFileSync(join(project, ".pi/sandbox.json"), JSON.stringify({ filesystem: { allowRead: [join(real, "loader")] } }));
        const { config } = loadSandboxConfig(project, { agentDir, machineId: "test" });
        expect(config.filesystem.allowRead).toContain(join(real, "loader"));
        expect(config.filesystem.allowRead).toContain(join(alias, "loader"));
        expect(config.filesystem.allowRead).not.toContain(real);
        expect(config.filesystem.allowRead).not.toContain(alias);
        expect(config.filesystem.allowRead).not.toContain(join(alias, "neighbor"));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
