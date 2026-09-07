import { findSkill, type SkillEntry } from "./skill-index.ts";
import { formatRescuedSkillBlock } from "./skill-rescue.ts";

/**
 * Inline `$skill-name` references.
 *
 * Single source for the `$` token shape: `$` followed by a skill name of
 * letters, digits, `-`, `_`, starting with a letter (so shell `$?`, `$$`,
 * and currency `$5` never match). Trailing punctuation (`.`, `,`, `!`, …)
 * falls outside the character set and stays in the surrounding text.
 */
export const DOLLAR_SKILL_NAME_PATTERN = "[A-Za-z][A-Za-z0-9_-]*";

const DOLLAR_BOUNDARY = String.raw`(?<![\p{L}\p{N}_/$\\])`;
const DOLLAR_TOKEN_PATTERN = new RegExp(
    `${DOLLAR_BOUNDARY}\\$(${DOLLAR_SKILL_NAME_PATTERN})`,
    "gu",
);

const DOLLAR_LOOKUP_PATTERN = new RegExp(DOLLAR_TOKEN_PATTERN.source, "u");

const DOLLAR_PREFIX_PATTERN = new RegExp(
    `${DOLLAR_BOUNDARY}(\\$[A-Za-z0-9_-]*)$`,
    "u",
);

const normalizeName = (raw: string): string => raw.replace(/[-_]+$/, "");

/** First `$name` token in `text`, or null when absent. */
export function extractDollarSkillName(text: string): string | null {
    const tokenMatch = DOLLAR_LOOKUP_PATTERN.exec(text);
    return tokenMatch?.[1] ? normalizeName(tokenMatch[1]) || null : null;
}

/** Resolve every reference once, in mention order. Do not re-expand skill bodies. */
export function findDollarSkills(
    text: string,
    skillList: SkillEntry[],
): SkillEntry[] {
    if (text.trimStart().startsWith("<skill ")) return [];
    const found = new Map<string, SkillEntry>();
    for (const match of text.matchAll(DOLLAR_TOKEN_PATTERN)) {
        const skill = findSkill(skillList, normalizeName(match[1]));
        if (skill) found.set(skill.name.toLowerCase(), skill);
    }
    return [...found.values()];
}

/**
 * `$` prefix under the cursor on `cursorLine`, or null. Multiline-safe:
 * scans only the current line up to `cursorCol` and requires the `$` to
 * start the token (including after punctuation) so escaped, shell, and
 * mid-word uses never trigger.
 */
export function extractDollarPrefix(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
): string | null {
    const match = DOLLAR_PREFIX_PATTERN.exec(
        (lines[cursorLine] ?? "").slice(0, cursorCol),
    );
    return match?.[1] ?? null;
}

/**
 * Rewrite every occurrence of `$name` (case-insensitive) in `text` to `skill:${name}`.
 * Preserves the trace in the user's prompt so the LLM explicitly sees the skill reference.
 */
export function rewriteDollarTokenToSkillRef(
    text: string,
    name: string,
): string {
    const lower = name.toLowerCase();
    return text.replace(DOLLAR_TOKEN_PATTERN, (token, raw: string) => {
        if (normalizeName(raw).toLowerCase() !== lower) {
            return token;
        }
        return `skill:${name}`;
    });
}

/**
 * Rewrite references to one unique skill to a native Pi `/skill:name` command.
 * The input handler delivers multiple skills through a batched custom message.
 * - Any position in input: rewrites every token to `skill:${name}` in the user prompt,
 *   and prepends `/skill:name`.
 * - Pi core expands this at prompt time and collapses it into `[skill] name (ctrl+o to expand)`.
 * - For rescued skills: formats the `<skill>` block at byte 0 directly so Pi TUI collapses it.
 * - Unknown `$name`: returns undefined (text untouched).
 */
export function transformDollarSkillInput(
    text: string,
    skillList: SkillEntry[],
): string | undefined {
    const skills = findDollarSkills(text, skillList);
    if (skills.length !== 1) return undefined;
    const skill = skills[0];
    const name = skill.name;

    const trimmed = text.trim();
    const isLoneToken = trimmed.toLowerCase() === `$${name.toLowerCase()}`;
    const userPrompt = isLoneToken
        ? ""
        : rewriteDollarTokenToSkillRef(trimmed, skill.name);

    if (skill.source === "rescued" && skill.content && skill.baseDir) {
        return formatRescuedSkillBlock(
            {
                name: skill.name,
                description: skill.description,
                path: skill.path,
                baseDir: skill.baseDir,
                content: skill.content,
            },
            userPrompt,
        );
    }

    return `/skill:${skill.name}${userPrompt ? ` ${userPrompt}` : ""}`;
}
