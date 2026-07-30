import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Review } from "./prompts.ts";
import type { TaskState } from "./state-machine.ts";
import type { Profile } from "./types.ts";

type Theme = ExtensionContext["ui"]["theme"];

const PROFILE_SEVERITY: Record<Profile, "error" | "warning" | "muted" | "dim"> =
    {
        critical: "error",
        standard: "warning",
        light: "muted",
        direct: "dim",
    };

/**
 * Color the profile label by severity. When `theme` is undefined (print/json
 * mode), returns the plain label so piped output stays ANSI-free.
 */
export function profileSeverity(
    theme: Theme | undefined,
    profile: Profile,
): string {
    const label = profile;
    return theme ? theme.fg(PROFILE_SEVERITY[profile], label) : label;
}

const TASK_STATE_GLYPH: Record<
    TaskState,
    {
        glyph: string;
        color: "muted" | "accent" | "success" | "warning" | "error";
    }
> = {
    pending: { glyph: "◦", color: "muted" },
    awaiting_direct_agent: { glyph: "◦", color: "muted" },
    implementing: { glyph: "●", color: "accent" },
    reviewing: { glyph: "●", color: "accent" },
    fixing: { glyph: "●", color: "accent" },
    verified: { glyph: "✓", color: "success" },
    needs_input: { glyph: "■", color: "warning" },
    failed: { glyph: "✗", color: "error" },
    cancelled: { glyph: "✗", color: "error" },
};

/**
 * Glyph + color for a task state. Plain glyph when `theme` is undefined.
 */
export function taskStateGlyph(
    theme: Theme | undefined,
    state: TaskState,
): string {
    const { glyph, color } = TASK_STATE_GLYPH[state];
    return theme ? theme.fg(color, glyph) : glyph;
}

const VERDICT_COLOR: Record<
    Review["verdict"],
    "success" | "warning" | "error"
> = {
    pass: "success",
    changes_required: "warning",
    blocked: "error",
};

/**
 * Color the verdict text. Plain `text` when `theme` is undefined.
 */
export function verdictColor(
    theme: Theme | undefined,
    verdict: Review["verdict"],
    text: string,
): string {
    return theme ? theme.fg(VERDICT_COLOR[verdict], text) : text;
}
