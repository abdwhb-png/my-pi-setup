import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("bundled brainstorm-forcer skill", () => {
    it("ports uncertainty and convergence guidance without weakening workflow boundaries", async () => {
        const skill = await readFile(
            join(import.meta.dir, "skills", "brainstorm-forcer", "SKILL.md"),
            "utf8",
        );

        for (const expected of [
            "canonical topic",
            "destination",
            "Decisions and known facts",
            "Not yet specified",
            "Out of scope",
            "brainstorm_delegate_research",
            "Verified",
            "Falsified",
            "Unresolved",
            "Selected path",
            "Ruled-out paths",
            "Remaining uncertainties",
            "two or three",
        ]) {
            expect(skill).toContain(expected);
        }
        expect(skill).toContain("Never create an implementation plan");
        expect(skill).not.toContain("Commit the design document");
        expect(skill).not.toContain("Ready to set up for implementation?");
    });
});
