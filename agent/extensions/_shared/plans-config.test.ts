import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { loadPlansConfig, resolvePlanFileDir } from "./plans-config.ts";

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0))
        rmSync(dir, { recursive: true, force: true });
});

function fixture() {
    const root = mkdtempSync(join(tmpdir(), "plans-config-"));
    dirs.push(root);
    const agentDir = join(root, "agent");
    const cwd = join(root, "project");
    mkdirSync(agentDir);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    return { agentDir, cwd };
}

test("new plans fields override legacy individually; untrusted project is ignored", () => {
    const { agentDir, cwd } = fixture();
    writeFileSync(
        join(agentDir, "plannotator.json"),
        JSON.stringify({
            planFileDir: "old",
            browserCommand: "browser",
            autoExecute: true,
        }),
    );
    writeFileSync(
        join(agentDir, "settings.json"),
        JSON.stringify({ plans: { planFileDir: "new" } }),
    );
    writeFileSync(
        join(cwd, ".pi/settings.json"),
        JSON.stringify({ plans: { browserCommand: "project-browser" } }),
    );
    expect(loadPlansConfig(cwd, false, agentDir)).toEqual({
        planFileDir: "new",
        browserCommand: "browser",
    });
    expect(loadPlansConfig(cwd, true, agentDir)).toEqual({
        planFileDir: "new",
        browserCommand: "project-browser",
    });
    expect(resolvePlanFileDir({ planFileDir: "~/plans" })).toBe(
        join(homedir(), "plans"),
    );
});

test("invalid configuration reports an explicit error", () => {
    const { agentDir, cwd } = fixture();
    writeFileSync(
        join(agentDir, "settings.json"),
        '{"plans":{"browserCommand":42}}',
    );
    expect(() => loadPlansConfig(cwd, false, agentDir)).toThrow(
        "browserCommand",
    );
});
