export const PI_SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";
export const SAVE_TOKENS_CAVEMAN_DEFAULT_LEVEL_ENV =
    "PI_SAVE_TOKENS_CAVEMAN_DEFAULT_LEVEL";
export const SAVE_TOKENS_PONYTAIL_DEFAULT_MODE_ENV =
    "PI_SAVE_TOKENS_PONYTAIL_DEFAULT_MODE";

/**
 * Apply the shared ultra profile only to a process spawned by pi-subagents.
 * The profile variables are consumed by save-tokens; it never writes the
 * upstream PONYTAIL_DEFAULT_MODE escape hatch directly.
 */
export function applyUltraSubagentProfile(
    env: NodeJS.ProcessEnv = process.env,
): void {
    if (env[PI_SUBAGENT_CHILD_ENV] !== "1") return;

    env[SAVE_TOKENS_CAVEMAN_DEFAULT_LEVEL_ENV] = "ultra";
    env[SAVE_TOKENS_PONYTAIL_DEFAULT_MODE_ENV] = "ultra";
}
