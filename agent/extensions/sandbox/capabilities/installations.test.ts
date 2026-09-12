import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSandboxConfig } from "../index.ts";
import { readGlobalSandboxConfig } from "./authority.ts";

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
    const root = mkdtempSync(join(tmpdir(), "pi-installations-"));
    roots.push(root);
    const agentDir = join(root, "agent");
    const project = join(root, "project");
    const installation = join(root, "tools");
    mkdirSync(agentDir);
    mkdirSync(join(project, ".pi"), { recursive: true });
    mkdirSync(join(installation, "bin"), { recursive: true });
    const writeGlobal = (value: object) => writeFileSync(join(agentDir, "sandbox.json"), JSON.stringify({ version: 2, machineId: "test-machine", ...value }), { mode: 0o600 });
    const writeProject = (value: object) => writeFileSync(join(project, ".pi", "sandbox.json"), JSON.stringify(value), { mode: 0o600 });
    const load = () => loadSandboxConfig(project, { agentDir, machineId: "test-machine" });
    return { root, agentDir, project, installation, writeGlobal, writeProject, load };
}

test("one global installation supplies read access and PATH without a second activation", () => {
    const f = fixture();
    f.writeGlobal({ environment: { installations: { tools: [{ root: f.installation, path: ["bin"] }] } } });

    const result = f.load();

    expect(result.config.filesystem.allowRead).toEqual([f.project, f.installation]);
    expect(result.config.filesystem.allowWrite).toEqual([f.project]);
    expect(result.config.environment.path).toEqual([join(f.installation, "bin")]);
    expect(result.shell.mode).toBe("sandbox");
    expect(result.shell.profile).toBe("custom");
});

test("an installation remains read-only when its root is inside the writable project",()=>{
    const f=fixture();const local=join(f.project,"tools");mkdirSync(join(local,"bin"),{recursive:true});
    f.writeGlobal({environment:{installations:{local:[{root:local,path:["bin"]}]}}});
    const config=f.load().config;
    expect(config.filesystem.allowWrite).toContain(f.project);
    expect(config.filesystem.denyWrite).toContain(local);
});

test("a project closes inherited installations without disabling its ordinary project access", () => {
    const f = fixture();
    f.writeGlobal({ environment: { installations: { tools: [{ root: f.installation, path: ["bin"] }] } } });
    f.writeProject({ environment: { installations: [] } });
    const result = f.load();
    expect(result.config.filesystem.allowRead).toEqual([f.project]);
    expect(result.config.environment.path).toEqual([]);
    expect(result.shell.profile).toBe("default");
});

test("a project selects global installations and preserves the global PATH order", () => {
    const f = fixture();
    const second = join(f.root, "second");
    mkdirSync(join(second, "commands"), { recursive: true });
    f.writeGlobal({ environment: { path: ["/explicit/legacy/bin"], installations: {
        first: [{ root: f.installation, path: ["bin"] }],
        second: [{ root: second, path: ["commands"] }],
    } } });
    f.writeProject({ environment: { installations: ["second", "first"] } });
    expect(f.load().config.environment.path).toEqual([join(f.installation, "bin"), join(second, "commands"), "/explicit/legacy/bin"]);
    f.writeProject({ environment: { installations: ["second"] } });
    const selected = f.load().config;
    expect(selected.filesystem.allowRead).toEqual([f.project, second]);
    expect(selected.environment.path).toEqual([join(second, "commands"), "/explicit/legacy/bin"]);
    expect(selected.filesystem.allowRead).not.toContain("/explicit/legacy/bin");
});

test("project filesystem restrictions narrow the installation grants before PATH construction", () => {
    const f = fixture();
    f.writeGlobal({ environment: { installations: { tools: [{ root: f.installation, path: ["bin"] }] } } });
    f.writeProject({ filesystem: { allowRead: ["."] } });
    expect(f.load().config.filesystem.allowRead).toEqual([f.project]);
    expect(f.load().config.environment.path).toEqual([]);
});

test("a project cannot define installations or select an unknown global authorization", () => {
    const f = fixture();
    f.writeProject({ environment: { installations: { tools: [{ root: f.installation }] } } });
    expect(() => f.load()).toThrow("list of global installation names");
    f.writeProject({ environment: { installations: ["missing"] } });
    expect(() => f.load()).toThrow("outside the project ceiling");
});

test("a session cannot reopen an installation that the project removed", () => {
    const f = fixture();
    f.writeGlobal({ environment: { installations: { tools: [{ root: f.installation, path: ["bin"] }] } } });
    f.writeProject({ environment: { installations: [] } });
    expect(() => loadSandboxConfig(f.project, { agentDir: f.agentDir, machineId: "test-machine", session: { environment: { installations: ["tools"] } } })).toThrow("outside the session ceiling");
});

test("updates inside an authorized root remain usable but a redirected root is refused", () => {
    const f = fixture();
    f.writeGlobal({ environment: { installations: { tools: [{ root: f.installation, path: ["bin"] }] } } });
    const before = f.load().config;
    writeFileSync(join(f.installation, "version"), "updated");
    expect(f.load().config).toEqual(before);
    renameSync(f.installation, `${f.installation}-moved`);
    symlinkSync(`${f.installation}-moved`, f.installation);
    expect(() => f.load()).toThrow("root was redirected");
});

test("a command directory cannot follow a symlink to an ungranted installation", () => {
    const f = fixture();
    const outside = join(f.root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(f.installation, "escape"));
    f.writeGlobal({ environment: { installations: { tools: [{ root: f.installation, path: ["escape"] }] } } });
    expect(() => f.load()).toThrow("escapes the authorized roots");
});

test("missing roots and escaping relative command paths are explicit configuration errors", () => {
    const f = fixture();
    f.writeGlobal({ environment: { installations: { tools: [{ root: join(f.root, "missing") }] } } });
    expect(() => f.load()).toThrow("root is unavailable");
    f.writeGlobal({ environment: { installations: { tools: [{ root: f.installation, path: ["../"] }] } } });
    expect(() => f.load()).toThrow("relative to its root");
});

test("an unavailable installation can be inspected for revocation while shell admission remains blocked", () => {
    const f = fixture();
    f.writeGlobal({ environment: { installations: { tools: [{ root: f.installation, path: ["bin"] }] } } });
    rmSync(f.installation, { recursive: true });
    expect(readGlobalSandboxConfig(join(f.agentDir, "sandbox.json"), "test-machine")?.environment?.installations).toEqual({ tools: [{ root: f.installation, path: ["bin"] }] });
    expect(() => f.load()).toThrow("root is unavailable");
});
