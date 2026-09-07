import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import type { RescuedSkill } from "./skill-rescue.ts";

export interface SkillEntry {
    /** Skill name without the "skill:" prefix */
    name: string;
    /** Description from SKILL.md frontmatter */
    description: string;
    /** Absolute path to the SKILL.md file */
    path: string;
    /** Source scope: "user" | "project" | "rescued" */
    source: string;
}

/**
 * Build a skill list from pi's slash commands plus BOM-normalized rescued skills.
 * Filters commands with source === "skill" and strips the "skill:" prefix.
 * Core skills take precedence; rescued skills with conflicting names are excluded.
 */
export function buildSkillList(
    commands: SlashCommandInfo[],
    rescuedSkills: readonly RescuedSkill[] = [],
): SkillEntry[] {
    const core = commands
        .filter((c) => c.source === "skill")
        .map((c) => ({
            name: c.name.startsWith("skill:")
                ? c.name.slice("skill:".length)
                : c.name,
            description: c.description ?? "",
            path: c.sourceInfo?.path ?? "",
            source: c.sourceInfo?.source ?? "unknown",
        }));

    const coreNames = new Set(core.map((s) => s.name.toLowerCase()));
    const rescued = rescuedSkills
        .filter((s) => !coreNames.has(s.name.toLowerCase()))
        .map((s) => ({
            name: s.name,
            description: s.description,
            path: s.path,
            source: "rescued",
        }));

    return [...core, ...rescued];
}

/**
 * Search skills by name or description.
 * Case-insensitive substring match. Ranks name matches above description matches.
 * Returns top 20 results.
 */
export function searchSkills(
    skills: SkillEntry[],
    query: string,
): SkillEntry[] {
    if (!query.trim()) {
        return skills.slice(0, 20);
    }

    const lowerQuery = query.toLowerCase();

    const scored = skills
        .map((skill) => {
            const nameLower = skill.name.toLowerCase();
            const descLower = skill.description.toLowerCase();

            // Score: 2 points for name match, 1 point for description match
            let score = 0;
            if (nameLower.includes(lowerQuery)) score += 2;
            if (descLower.includes(lowerQuery)) score += 1;

            return { skill, score };
        })
        .filter(({ score }) => score > 0)
        .toSorted((a, b) => b.score - a.score)
        .map(({ skill }) => skill);

    return scored.slice(0, 20);
}

/**
 * Find a skill by exact name (case-insensitive).
 * Returns null if not found.
 */
export function findSkill(
    skills: SkillEntry[],
    name: string,
): SkillEntry | null {
    const lowerName = name.toLowerCase();
    return skills.find((s) => s.name.toLowerCase() === lowerName) ?? null;
}
