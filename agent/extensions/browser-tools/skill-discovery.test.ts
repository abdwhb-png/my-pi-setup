import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { isolateSkillHome } from "../_shared/testing/skill-home.ts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
    for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

test("Pi excludes the shared CLI skill by name without excluding its native tool skill", async () => {
    const root = mkdtempSync(join(tmpdir(), "browser-skill-exclusion-"));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    await isolateSkillHome(root, cleanup);
    for (const name of ["agent-browser", "pi-browser-tool", "unrelated"]) {
        const dir = join(root, "skills", name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Isolated fixture skill\n---\nFixture body\n`);
    }
    const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: SettingsManager.inMemory({ skills: ["!agent-browser"] }), noExtensions: true, noContextFiles: true, noThemes: true, noPromptTemplates: true });
    await loader.reload();
    expect(loader.getSkills().skills.map(skill => skill.name).sort()).toEqual(["pi-browser-tool", "unrelated"]);
    expect(loader.getSkills().diagnostics).toEqual([]);
});
