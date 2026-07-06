import { describe, expect, it } from "bun:test";
import { buildSkillList, searchSkills, findSkill, SkillEntry } from "./skill-index";
import type { SlashCommandInfo, SlashCommandSource, SourceInfo } from "@earendil-works/pi-coding-agent";

function makeSourceInfo(overrides: Partial<SourceInfo> = {}): SourceInfo {
  return {
    path: "/fake/skills/test-skill/SKILL.md",
    source: "user",
    scope: "user",
    origin: "top-level",
    baseDir: "/fake/skills/test-skill",
    ...overrides,
  };
}

function makeCommand(
  name: string,
  source: SlashCommandSource,
  overrides: Partial<SlashCommandInfo> = {},
): SlashCommandInfo {
  return {
    name,
    description: `Description for ${name}`,
    source,
    sourceInfo: makeSourceInfo(overrides.sourceInfo as Partial<SourceInfo> | undefined),
    ...overrides,
  };
}

describe("buildSkillList", () => {
  it("filters only skill commands", () => {
    const commands: SlashCommandInfo[] = [
      makeCommand("skill:foo", "skill"),
      makeCommand("skill:bar", "skill"),
      makeCommand("ext-cmd", "extension"),
      makeCommand("prompt-cmd", "prompt"),
    ];

    const result = buildSkillList(commands);
    expect(result).toHaveLength(2);
    expect(result.map((s: SkillEntry) => s.name)).toEqual(["foo", "bar"]);
  });

  it("strips skill: prefix from names", () => {
    const commands: SlashCommandInfo[] = [
      makeCommand("skill:systematic-debugging", "skill"),
      makeCommand("skill:tdd", "skill"),
    ];

    const result = buildSkillList(commands);
    expect(result[0].name).toBe("systematic-debugging");
    expect(result[1].name).toBe("tdd");
  });

  it("extracts description from command", () => {
    const commands: SlashCommandInfo[] = [
      makeCommand("skill:test", "skill", { description: "A test skill for testing" }),
    ];

    const result = buildSkillList(commands);
    expect(result[0].description).toBe("A test skill for testing");
  });

  it("extracts path from sourceInfo", () => {
    const commands: SlashCommandInfo[] = [
      makeCommand("skill:test", "skill", {
        sourceInfo: makeSourceInfo({ path: "/home/user/.pi/agent/skills/test/SKILL.md" }),
      }),
    ];

    const result = buildSkillList(commands);
    expect(result[0].path).toBe("/home/user/.pi/agent/skills/test/SKILL.md");
  });

  it("extracts source scope from sourceInfo", () => {
    const commands: SlashCommandInfo[] = [
      makeCommand("skill:user-skill", "skill", {
        sourceInfo: makeSourceInfo({ source: "user", scope: "user" }),
      }),
      makeCommand("skill:project-skill", "skill", {
        sourceInfo: makeSourceInfo({ source: "project", scope: "project" }),
      }),
    ];

    const result = buildSkillList(commands);
    expect(result[0].source).toBe("user");
    expect(result[1].source).toBe("project");
  });

  it("returns empty array when no skills", () => {
    const commands: SlashCommandInfo[] = [
      makeCommand("ext-only", "extension"),
    ];

    const result = buildSkillList(commands);
    expect(result).toHaveLength(0);
  });

  it("handles missing description gracefully", () => {
    const commands: SlashCommandInfo[] = [
      makeCommand("skill:no-desc", "skill", { description: undefined }),
    ];

    const result = buildSkillList(commands);
    expect(result[0].description).toBe("");
  });

  it("handles missing sourceInfo path gracefully", () => {
    const src = makeSourceInfo({ path: "" });
    const commands: SlashCommandInfo[] = [
      makeCommand("skill:no-path", "skill", { sourceInfo: src }),
    ];

    const result = buildSkillList(commands);
    expect(result[0].path).toBe("");
  });
});

describe("searchSkills", () => {
  function makeSkill(name: string, description: string, source = "user", path = `/fake/${name}/SKILL.md`) {
    return { name, description, path, source };
  }

  const skills = [
    makeSkill("systematic-debugging", "Debug systematically with reproduction steps"),
    makeSkill("tdd", "Test-driven development with red-green-refactor"),
    makeSkill("bun-test", "Configure Bun test runner with Jest-compatible APIs"),
    makeSkill("frontend-design", "Create distinctive production-grade frontend interfaces"),
    makeSkill("docker-mcp-catalogs", "Create and publish Docker MCP catalogs"),
  ];

  it("returns matching skills by name substring", () => {
    const results = searchSkills(skills, "debug");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].name).toBe("systematic-debugging");
  });

  it("returns matching skills by description substring", () => {
    const results = searchSkills(skills, "frontend");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].name).toBe("frontend-design");
  });

  it("case-insensitive matching", () => {
    const results = searchSkills(skills, "DEBUG");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].name).toBe("systematic-debugging");
  });

  it("ranks name matches higher than description matches", () => {
    // "docker" appears in both name (docker-mcp-catalogs) and description (bun-test has "APIs")
    const results = searchSkills(skills, "docker");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].name).toBe("docker-mcp-catalogs");
  });

  it("returns empty array for no matches", () => {
    const results = searchSkills(skills, "zzz_nonexistent_zzz");
    expect(results).toHaveLength(0);
  });

  it("handles empty query by returning all skills", () => {
    const results = searchSkills(skills, "");
    expect(results.length).toBe(skills.length);
  });

  it("limits results to top 20", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      makeSkill(`skill-${i}`, `Description for skill ${i}`),
    );
    const results = searchSkills(many, "skill");
    expect(results.length).toBeLessThanOrEqual(20);
  });

  it("returns empty array for empty skills list", () => {
    const results = searchSkills([], "test");
    expect(results).toHaveLength(0);
  });
});

describe("findSkill", () => {
  const skills = [
    { name: "tdd", description: "Test-driven development", path: "/skills/tdd/SKILL.md", source: "user" },
    { name: "bun-test", description: "Bun test runner", path: "/skills/bun-test/SKILL.md", source: "user" },
    { name: "frontend-design", description: "Frontend interfaces", path: "/skills/frontend/SKILL.md", source: "user" },
  ];

  it("returns exact match by name", () => {
    const result = findSkill(skills, "tdd");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("tdd");
    expect(result!.path).toBe("/skills/tdd/SKILL.md");
  });

  it("returns null for non-matching name", () => {
    const result = findSkill(skills, "nonexistent");
    expect(result).toBeNull();
  });

  it("matching is case-insensitive", () => {
    const result = findSkill(skills, "TDD");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("tdd");
  });

  it("returns null for empty skills list", () => {
    const result = findSkill([], "tdd");
    expect(result).toBeNull();
  });
});
