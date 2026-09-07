import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import {
    parseFrontmatter,
    stripFrontmatter,
} from "@earendil-works/pi-coding-agent";

/* oxlint-disable eslint/no-await-in-loop -- discovery order defines deterministic skill precedence. */

export interface RescuedSkill {
    name: string;
    description: string;
    path: string;
    baseDir: string;
    content: string;
}

export interface SkillDiagnostic {
    type: "bom" | "invalid-frontmatter";
    path: string;
    message: string;
}

export interface SkillDiscoveryResult {
    skills: RescuedSkill[];
    diagnostics: SkillDiagnostic[];
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

export async function getSkillRoots(
    cwd: string,
    isProjectTrusted: boolean,
    home = homedir(),
): Promise<string[]> {
    const roots = [
        join(home, ".pi", "agent", "skills"),
        join(home, ".agents", "skills"),
    ];
    if (!isProjectTrusted) return roots;

    let directory = resolve(cwd);
    while (true) {
        roots.push(join(directory, ".pi", "skills"));
        roots.push(join(directory, ".agents", "skills"));
        if (await pathExists(join(directory, ".git"))) break;

        const parent = dirname(directory);
        if (parent === directory) break;
        directory = parent;
    }

    return roots;
}

async function findSkillFiles(root: string): Promise<string[]> {
    const entries = await readdir(root, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
        const path = join(root, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await findSkillFiles(path)));
        } else if (entry.isFile() && entry.name === "SKILL.md") {
            files.push(path);
        }
    }

    return files;
}

export function formatRescuedSkillBlock(
    skill: RescuedSkill,
    args: string,
): string {
    const body = stripFrontmatter(skill.content).trim();
    const block = `<skill name="${skill.name}" location="${skill.path}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
    return args ? `${block}\n\n${args}` : block;
}

export async function discoverSkillFallbacks(
    roots: string[],
): Promise<SkillDiscoveryResult> {
    const skills: RescuedSkill[] = [];
    const diagnostics: SkillDiagnostic[] = [];

    for (const root of roots) {
        let files: string[];
        try {
            files = await findSkillFiles(root);
        } catch {
            continue;
        }

        for (const path of files) {
            const rawContent = (await readFile(path)).toString("utf8");
            if (!rawContent.startsWith("\uFEFF")) continue;

            // Pi core requires frontmatter to begin at byte zero; retain a safe in-memory fallback.
            const content = rawContent.slice(1);
            const { frontmatter } = parseFrontmatter(content);
            if (
                typeof frontmatter.name !== "string" ||
                typeof frontmatter.description !== "string" ||
                !frontmatter.description.trim()
            ) {
                diagnostics.push({
                    type: "invalid-frontmatter",
                    path,
                    message: "Missing non-empty skill description.",
                });
                continue;
            }

            skills.push({
                name: frontmatter.name || basename(dirname(path)),
                description: frontmatter.description,
                path,
                baseDir: dirname(path),
                content,
            });
            diagnostics.push({
                type: "bom",
                path,
                message: "UTF-8 BOM normalized in memory.",
            });
        }
    }

    return { skills, diagnostics };
}
