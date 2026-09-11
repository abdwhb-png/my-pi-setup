import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSandboxConfig } from "./index.ts";
import { sandboxDoctor } from "./doctor.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() {
    const root = mkdtempSync(join(tmpdir(), "doctor-")); roots.push(root);
    const cwd = join(root, "project"); const agentDir = join(root, "agent");
    mkdirSync(cwd); mkdirSync(agentDir);
    const real = join(root, "real-tool"); const link = join(cwd, "Tool");
    writeFileSync(real, "#!/bin/sh\nexit 99\n", { mode: 0o700 }); symlinkSync(real, link);
    return { cwd, real, configure(filesystem: object) {
        writeFileSync(join(agentDir, "sandbox.json"), JSON.stringify({ version: 2, machineId: "fixture", filesystem, environment: { path: [cwd] } }), { mode: 0o600 });
        return loadSandboxConfig(cwd, { agentDir, machineId: "fixture" });
    } };
}
test("doctor reports uncovered symlink targets and precise grants", () => {
    const f = fixture();
    expect(sandboxDoctor(f.configure({ allowRead: ["."] }), "Tool")).toContain("Configured read coverage: missing");
    expect(sandboxDoctor(f.configure({ allowRead: [".", f.real] }), "Tool")).toContain("Configured read coverage: covered");
    expect(sandboxDoctor(f.configure({ allowRead: ["."], denyRead: ["Tool"] }), "Tool")).toContain("Configured read coverage: denied");
    expect(sandboxDoctor(f.configure({}), "missing-probe-tool")).toContain("Executable unavailable on host PATH");
});
test("doctor recognizes an explicitly configured filesystem root", () => {
    const f = fixture();
    expect(sandboxDoctor(f.configure({ allowRead: ["/"] }), "Tool")).toContain("Configured read coverage: covered");
});
