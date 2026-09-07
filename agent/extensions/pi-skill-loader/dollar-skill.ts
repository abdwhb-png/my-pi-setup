import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { EventBus } from "@earendil-works/pi-coding-agent";
import { requestMarkdownLinkTransform } from "../_shared/markdown-links.ts";
import { formatRescuedSkillBlock } from "./skill-rescue.ts";
import { findSkill, type SkillEntry } from "./skill-index.ts";

/**
 * Inline `$skill-name` references.
 *
 * Single source for the `$` token shape: `$` followed by a skill name of
 * letters, digits, `-`, `_`, starting with a letter (so shell `$?`, `$$`,
 * and currency `$5` never match). Trailing punctuation (`.`, `,`, `!`, …)
 * falls outside the character set and stays in the surrounding text.
 */
export const DOLLAR_SKILL_NAME_PATTERN = "[A-Za-z][A-Za-z0-9_-]*";

const DOLLAR_TOKEN_PATTERN = /\$([A-Za-z][A-Za-z0-9_-]*)/g;

const DOLLAR_LOOKUP_PATTERN = /(?:^|\s)\$([A-Za-z][A-Za-z0-9_-]*)/;

const DOLLAR_PREFIX_PATTERN = /(?:^|\s)(\$[A-Za-z0-9_-]*)$/;

const normalizeName = (raw: string): string => raw.replace(/[-_]+$/, "");

/** First `$name` token in `text`, or null when absent. */
export function extractDollarSkillName(text: string): string | null {
    const tokenMatch = DOLLAR_LOOKUP_PATTERN.exec(text);
    return tokenMatch?.[1] ? normalizeName(tokenMatch[1]) || null : null;
}

/**
 * `$` prefix under the cursor on `cursorLine`, or null. Multiline-safe:
 * scans only the current line up to `cursorCol` and requires the `$` to
 * start the token (preceded by start-of-line or whitespace) so mid-word
 * uses like `cost$5` never trigger.
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
 * Splice `block` in place of the first `$name` token matching `name`
 * (case-insensitive). All other text — including other `$tokens` — is
 * preserved untouched.
 */
export function spliceSkillBlock(
    text: string,
    name: string,
    block: string,
): string {
    const lower = name.toLowerCase();
    let replaced = false;
    DOLLAR_TOKEN_PATTERN.lastIndex = 0;
    return text.replace(DOLLAR_TOKEN_PATTERN, (token, raw: string) => {
        if (replaced || normalizeName(raw).toLowerCase() !== lower) {
            return token;
        }
        replaced = true;
        return block;
    });
}

export type SkillContentResult =
    | { ok: true; block: string }
    | { ok: false; error: string };

/**
 * Single loader path for `$` expansion: read the skill file and route it
 * through the same markdown link transform load_skill uses, so embedded
 * and slash expansion produce identical blocks.
 */
export async function loadSkillContent(
    events: Pick<EventBus, "emit">,
    skill: SkillEntry,
    cwd: string,
    sourceKind: string,
    args = "",
): Promise<SkillContentResult> {
    let content: string;
    try {
        const buf = await readFile(skill.path);
        const raw = buf.toString("utf-8");
        content = raw.startsWith("\uFEFF") ? raw.slice(1) : raw;
    } catch (err) {
        return {
            ok: false,
            error: `Failed to read skill file at ${skill.path}: ${err instanceof Error ? err.message : String(err)}`,
        };
    }
    return {
        ok: true,
        block: formatRescuedSkillBlock(
            {
                name: skill.name,
                description: skill.description,
                path: skill.path,
                baseDir: dirname(skill.path),
                content: requestMarkdownLinkTransform(events, {
                    sourcePath: skill.path,
                    content,
                    cwd,
                    sourceKind,
                }),
            },
            args,
        ),
    };
}

/**
 * Rewrite `$name` skill references before Pi core expansion.
 * - Sole `$name` with trailing text: rewrites to `/skill:name args` for core skills,
 *   or expands the rescued block for rescued skills.
 * - Embedded `$name`: splices the markdown-link-transformed block inline.
 * - Unknown `$name`: returns undefined (surrounding text untouched).
 */
export async function transformDollarSkillInput(
    text: string,
    skillList: SkillEntry[],
    events: Pick<EventBus, "emit">,
    cwd: string,
): Promise<string | undefined> {
    const name = extractDollarSkillName(text);
    if (!name) return undefined;
    const skill = findSkill(skillList, name);
    if (!skill) return undefined;

    const soleMatch = text.match(/^\$([A-Za-z][A-Za-z0-9_-]*)\s*([\s\S]*)$/);
    if (soleMatch?.[1]?.toLowerCase() === name.toLowerCase()) {
        if (skill.source !== "rescued") {
            return `/skill:${skill.name}${soleMatch[2] ? ` ${soleMatch[2]}` : ""}`;
        }
        const loaded = await loadSkillContent(
            events,
            skill,
            cwd,
            "dollar-skill-input",
            soleMatch[2] ?? "",
        );
        return loaded.ok ? loaded.block : undefined;
    }

    const loaded = await loadSkillContent(
        events,
        skill,
        cwd,
        "dollar-skill-input",
        "",
    );
    if (!loaded.ok) return undefined;
    return spliceSkillBlock(text, name, loaded.block);
}
