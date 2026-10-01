import { expect, test as bunTest } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

const test =
    process.env.PI_CONFIGURATION_AUDIT === "1" ? bunTest : bunTest.skip;

const rolesDir = fileURLToPath(new URL("../../../roles/", import.meta.url));

function frontmatter(roleName: string): Record<string, unknown> {
    const source = readFileSync(join(rolesDir, `${roleName}.md`), "utf8");
    return parseFrontmatter<Record<string, unknown>>(source).frontmatter;
}

test("planning roles opt into their matching programmatic handoff guards", () => {
    expect(frontmatter("plan").handoffGuard).toBe("plan-submission");
    expect(frontmatter("quick-planner").handoffGuard).toBe(
        "session-plan-persistence",
    );
});
