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

test("plan opts into submission guard while quick-planner remains session-plan-only", () => {
    expect(frontmatter("plan").handoffGuard).toBe("plan-submission");
    expect(frontmatter("quick-planner").handoffGuard).toBeUndefined();
});
