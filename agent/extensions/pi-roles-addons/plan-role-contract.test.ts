import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

const rolesDir = fileURLToPath(new URL("../../roles/", import.meta.url));

function frontmatter(roleName: string): Record<string, unknown> {
    const source = readFileSync(join(rolesDir, `${roleName}.md`), "utf8");
    return parseFrontmatter<Record<string, unknown>>(source).frontmatter;
}

function tools(roleName: string): string[] {
    const value = frontmatter(roleName).tools;
    if (typeof value !== "string") return [];
    return value
        .split(",")
        .map((tool) => tool.trim())
        .filter(Boolean);
}

test("planning roles opt into their matching programmatic handoff guards", () => {
    expect(frontmatter("plan").handoffGuard).toBe("plan-submission");
    expect(frontmatter("quick-planner").handoffGuard).toBe(
        "session-plan-persistence",
    );
});

test("planning roles exclude generic and executable context-mode access", () => {
    expect(tools("planning-base")).not.toContain("mcp");
    expect(tools("plan")).toContain("@think-inspect");
    expect(tools("plan")).not.toContain("@think");
    expect(tools("plan")).not.toContain("@ctx-inspect");
    expect(tools("plan")).not.toContain("@ctx");
    expect(tools("quick-planner")).not.toContain("@think-inspect");
    expect(tools("quick-planner")).not.toContain("@ctx-inspect");
});

test("planning roles do not gain executable think groups (least-privilege)", () => {
    // @think-exec must never be added to a planning/research role — it would
    // let planning agents execute commands and run analyzers, violating
    // least-privilege. The granular @think-inspect remains the ceiling.
    expect(tools("plan")).not.toContain("@think-exec");
    expect(tools("quick-planner")).not.toContain("@think-exec");
    expect(tools("brainstorm")).not.toContain("@think-exec");
    expect(tools("ask")).not.toContain("@think-exec");
    expect(tools("plan")).not.toContain("think_execute");
});
