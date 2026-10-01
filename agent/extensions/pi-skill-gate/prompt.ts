import {
    formatSkillsForPrompt,
    type Skill,
} from "@earendil-works/pi-coding-agent";
import {
    loadEffectiveState,
    type SkillGateConfig,
} from "../_shared/skill-visibility.ts";

/** Filter only Pi's catalog entries; preserve other prompt sections and their ordering. */
export function skillCatalogFilter(
    skills: Skill[],
    config: SkillGateConfig,
    projectPath?: string,
): ((prompt: string) => string) | undefined {
    const hidden = new Set(
        skills
            .filter(
                (skill) =>
                    skill.disableModelInvocation ||
                    loadEffectiveState(skill.name, config, projectPath)
                        .state === "disabled",
            )
            .map((skill) => {
                // Let Pi own XML escaping, including names supplied by configured packages.
                return formatSkillsForPrompt([
                    { ...skill, disableModelInvocation: false },
                ]).match(/<name>[\s\S]*?<\/name>/)?.[0];
            }),
    );
    if (hidden.size === 0) return undefined;
    return (prompt) =>
        prompt.replace(
            /<available_skills>[\s\S]*?<\/available_skills>/g,
            (catalog) => {
                const filtered = catalog.replace(
                    /<skill>[\s\S]*?<\/skill>/g,
                    (entry) =>
                        hidden.has(entry.match(/<name>[\s\S]*?<\/name>/)?.[0])
                            ? ""
                            : entry,
                );
                return filtered.includes("<skill>") ? filtered : "";
            },
        );
}
