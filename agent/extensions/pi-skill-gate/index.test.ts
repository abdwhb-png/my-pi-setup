import { afterEach, expect, test } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
    loadConfig,
    loadEffectiveState,
    persistBulkToggle,
    resetScope,
    loadAnalytics,
    incrementSkillUsage,
    loadActiveSkills,
} from "./index.ts";
import type { SkillGateConfig } from "./types.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
    for (const dispose of cleanup.splice(0).reverse()) dispose();
});
function fixture() {
    const old = process.env.PI_CODING_AGENT_DIR;
    cleanup.push(() => {
        if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = old;
    });
    const dir = mkdtempSync(join(tmpdir(), "skill-gate-config-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    process.env.PI_CODING_AGENT_DIR = dir;
    mkdirSync(join(dir, "config"));
    return dir;
}

test("unspecified and newly added skills default to enabled", () => {
    expect(
        loadEffectiveState("new-skill", { skills: {}, projects: {} }),
    ).toEqual({ state: "enabled", source: "default" });
});

test("saved project choices win over globals and portable paths match old absolute keys", () => {
    const cwd = join(homedir(), "engineering", "skill-fixture");
    const config: SkillGateConfig = {
        skills: { tdd: "disabled" },
        projects: { [cwd]: { skills: { tdd: "enabled" } } },
    };
    expect(loadEffectiveState("tdd", config)).toEqual({
        state: "disabled",
        source: "global",
    });
    expect(
        loadEffectiveState("tdd", config, "~/engineering/skill-fixture"),
    ).toEqual({ state: "enabled", source: "project" });
});

test("global enables prune defaults and project toggles store only differences", () => {
    fixture();
    const config: SkillGateConfig = {
        skills: { tdd: "disabled" },
        projects: {},
    };
    expect(persistBulkToggle(["tdd", "tdd"], "enabled", config, "global")).toBe(
        1,
    );
    expect(config.skills).toEqual({});
    const cwd = join(homedir(), "engineering", "skill-fixture");
    expect(persistBulkToggle(["tdd"], "disabled", config, "project", cwd)).toBe(
        1,
    );
    expect(config.projects["~/engineering/skill-fixture"]?.skills).toEqual({
        tdd: "disabled",
    });
    expect(loadEffectiveState("tdd", config, cwd).state).toBe("disabled");
    expect(persistBulkToggle(["tdd"], "enabled", config, "project", cwd)).toBe(
        1,
    );
    expect(config.projects).toEqual({});
    expect(persistBulkToggle(["new"], "enabled", config, "global")).toBe(0);
});

test("reset preserves other scopes and saved choices survive a fresh read", () => {
    fixture();
    const config: SkillGateConfig = {
        skills: { tdd: "disabled" },
        projects: {
            "/tmp/one": { skills: { tdd: "enabled" } },
            "/tmp/two": { skills: { new: "disabled" } },
        },
    };
    expect(resetScope(config, "project", "/tmp/one")).toBe(1);
    expect(loadConfig()).toEqual(config);
    expect(config.projects["/tmp/two"]?.skills).toEqual({ new: "disabled" });
    expect(resetScope(config, "global")).toBe(1);
    expect(loadEffectiveState("tdd", loadConfig()).state).toBe("enabled");
    expect(config.projects["/tmp/two"]?.skills).toEqual({ new: "disabled" });
});

test("malformed configuration is reported and left byte-identical", () => {
    const dir = fixture();
    const path = join(dir, "config/skill-gate.json");
    writeFileSync(path, "{broken");
    expect(() => loadConfig()).toThrow("Invalid configuration");
    expect(readFileSync(path, "utf8")).toBe("{broken");
});

test("a failed save does not change the active choices", () => {
    const dir = fixture();
    mkdirSync(join(dir, "config/skill-gate.json"));
    const config: SkillGateConfig = { skills: {}, projects: {} };
    expect(() =>
        persistBulkToggle(["tdd"], "disabled", config, "global"),
    ).toThrow();
    expect(config).toEqual({ skills: {}, projects: {} });
    expect(() =>
        persistBulkToggle(["tdd"], "disabled", config, "project"),
    ).toThrow("project path");
});

test("analytics failures remain visible instead of silently replacing counts", () => {
    const dir = fixture();
    const path = join(dir, "config/skill-gate-analytics.json");
    writeFileSync(path, "{broken");
    expect(() => loadAnalytics()).toThrow();
    expect(readFileSync(path, "utf8")).toBe("{broken");
});

test("usage counts once per name and reflects later external edits", () => {
    const dir = fixture();
    expect(incrementSkillUsage(["tdd", "tdd", "bun"])).toBe(2);
    expect(loadAnalytics()).toEqual({ counts: { tdd: 1, bun: 1 } });
    writeFileSync(
        join(dir, "config/skill-gate-analytics.json"),
        JSON.stringify({ counts: { tdd: 10 } }),
    );
    expect(loadAnalytics()).toEqual({ counts: { tdd: 10 } });
});

test("metadata loads only actual skill command paths and respects native manual invocation", () => {
    const dir = fixture();
    const path = join(dir, "manual.md");
    writeFileSync(
        path,
        "---\nname: manual\ndescription: Manual fixture\ndisable-model-invocation: true\n---\nBody",
    );
    const skills = loadActiveSkills(
        {
            getCommands: () => [
                {
                    name: "skill:manual",
                    source: "skill",
                    sourceInfo: {
                        path,
                        source: "user",
                        scope: "user",
                        origin: "top-level",
                    },
                },
            ],
        },
        dir,
    );
    expect(
        skills.map((skill) => ({
            name: skill.name,
            manual: skill.disableModelInvocation,
        })),
    ).toEqual([{ name: "manual", manual: true }]);
});

test("stores a disable under the configured agent directory", () => {
    const old = process.env.PI_CODING_AGENT_DIR;
    cleanup.push(() => {
        if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = old;
    });
    const dir = mkdtempSync(join(tmpdir(), "skill-gate-test-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    process.env.PI_CODING_AGENT_DIR = dir;
    const config = { skills: {}, projects: {} };
    expect(persistBulkToggle(["tdd"], "disabled", config, "global")).toBe(1);
    expect(
        JSON.parse(readFileSync(join(dir, "config/skill-gate.json"), "utf8")),
    ).toEqual({ skills: { tdd: "disabled" }, projects: {} });
});
