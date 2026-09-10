import { expect, test } from "bun:test";
import { mkdtemp, writeFile, symlink, link, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { protectsCapabilityAuthority } from "./protection.ts";

test("authority protection covers aliases, hard links, archives and missing descendants", async () => {
    const root = await mkdtemp(join(tmpdir(), "capability-protection-"));
    const authority = join(root, "sandbox.capabilities.json");
    try {
        await writeFile(authority, "fixture", { mode: 0o600 });
        await symlink(authority, join(root, "alias"));
        await link(authority, join(root, "hardlink"));
        await symlink(root, join(root, "directory-alias"));
        for (const path of [authority, "alias", "hardlink", "sandbox.capabilities.json.pending", "directory-alias/sandbox.capabilities.json", root]) {
            expect(protectsCapabilityAuthority(path, root, authority)).toBe(true);
        }
        expect(protectsCapabilityAuthority("project.ts", root, authority)).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
});
