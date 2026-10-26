import { SandboxExecutionError } from "./errors.ts";
import type { SandboxWriteException } from "./policy-contracts.ts";

function invalid(): never {
    throw new SandboxExecutionError("invalid-policy", {
        diagnostic:
            "filesystem.denyWriteExceptions must contain a denial glob and non-empty literal paths without parent traversal",
    });
}

export function parseWriteExceptions(value: unknown): SandboxWriteException[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) return invalid();
    const rules = value.map((entry: unknown) => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry))
            return invalid();
        const rule = entry as Record<string, unknown>;
        if (
            Object.keys(rule).some(
                (key) => key !== "pattern" && key !== "paths",
            ) ||
            typeof rule.pattern !== "string" ||
            !/[*?[\]{}]/.test(rule.pattern) ||
            /[\x00-\x1f\x7f]/.test(rule.pattern) ||
            rule.pattern.split("/").includes("..") ||
            !Array.isArray(rule.paths) ||
            rule.paths.length === 0
        )
            return invalid();
        const paths = rule.paths.map((path: unknown) => {
            if (
                typeof path !== "string" ||
                !path ||
                /[*?[\]{}\x00-\x1f\x7f]/.test(path) ||
                path.split("/").includes("..")
            )
                return invalid();
            return path;
        });
        return { pattern: rule.pattern, paths: [...new Set(paths)] };
    });
    if (new Set(rules.map((rule) => rule.pattern)).size !== rules.length)
        return invalid();
    return rules;
}
