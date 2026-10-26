import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFixtureFile as writeFileSync } from "../../_shared/testing/config-fixture.ts";
import { loadSandboxConfig } from "../index.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture() {
    const root = mkdtempSync(join(tmpdir(), "pi-write-exceptions-"));
    roots.push(root);
    const agentDir = join(root, "agent");
    const project = join(root, "project");
    mkdirSync(project);
    mkdirSync(agentDir);
    new ProjectTrustStore(agentDir).set(project, true);
    const globalPath = join(agentDir, "config", "sandbox.json");
    writeFileSync(globalPath, JSON.stringify({
        version: 2,
        machineId: "test",
        filesystem: {
            allowRead: ["."], allowWrite: ["."], denyWrite: ["node_modules/*"],
            denyWriteExceptions: [{ pattern: "node_modules/*", paths: ["node_modules/.vite-temp", "node_modules/.vite"] }],
        },
    }));
    return { project, agentDir, globalPath, projectPath: join(project, ".pi", "config", "sandbox.json"), load: () => loadSandboxConfig(project, { agentDir, machineId: "test" }) };
}

test("inherits globally authorized cache exceptions in the resolved sandbox policy", () => {
    const f = fixture();
    expect(f.load().config.filesystem.denyWriteExceptions).toEqual([{
        pattern: join(f.project, "node_modules/*"),
        paths: [join(f.project, "node_modules/.vite-temp"), join(f.project, "node_modules/.vite")],
    }]);
});

test("projects can disable or select authorized exceptions but cannot add rights", () => {
    const f = fixture();
    writeFileSync(f.projectPath, JSON.stringify({ filesystem: { denyWriteExceptions: [] } }));
    expect(f.load().config.filesystem.denyWriteExceptions ?? []).toEqual([]);
    writeFileSync(f.projectPath, JSON.stringify({ filesystem: { denyWriteExceptions: [{ pattern: "node_modules/*", paths: ["node_modules/.vite"] }] } }));
    expect(f.load().config.filesystem.denyWriteExceptions?.[0]?.paths).toEqual([join(f.project, "node_modules/.vite")]);
    writeFileSync(f.projectPath, JSON.stringify({ filesystem: { denyWriteExceptions: [{ pattern: "node_modules/*", paths: ["node_modules/.bin"] }] } }));
    expect(f.load).toThrow("ceiling");
});

test.each(["../outside", "node_modules/*", "node_modules/../.cache"])("rejects ambiguous exception path %s", path => {
    const f = fixture();
    const global = JSON.parse(readFileSync(f.globalPath, "utf8"));
    global.filesystem.denyWriteExceptions[0].paths = [path];
    writeFileSync(f.globalPath, JSON.stringify(global));
    expect(f.load).toThrow("denyWriteExceptions");
});

test("rejects a cache directory redirected into installed dependencies", () => {
    const f = fixture();
    mkdirSync(join(f.project, "node_modules/.pnpm"), { recursive: true });
    symlinkSync(".pnpm", join(f.project, "node_modules/.vite"));
    expect(f.load).toThrow("redirected");
});

test("exceptions require existing write authority and a referenced denial", () => {
    const f = fixture();
    const global = JSON.parse(readFileSync(f.globalPath, "utf8"));
    global.filesystem.allowWrite = [];
    writeFileSync(f.globalPath, JSON.stringify(global));
    expect(f.load).toThrow("write grant");
    global.filesystem.allowWrite = ["."];
    global.filesystem.denyWrite = [];
    writeFileSync(f.globalPath, JSON.stringify(global));
    expect(f.load).toThrow("existing denial");
});

test("basename denial globs retain their documented recursive scope around cache exceptions", () => {
    const f = fixture();
    const global = JSON.parse(readFileSync(f.globalPath, "utf8"));
    global.filesystem.denyWrite.push("*.key", ".env.*");
    writeFileSync(f.globalPath, JSON.stringify(global));
    expect(f.load().config.filesystem.denyWrite).toContain(join(f.project, "**/*.key"));
    expect(f.load().config.filesystem.denyWrite).toContain(join(f.project, "**/.env.*"));
});
