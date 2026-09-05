/**
 * Apply safe-bash mode to the active tool set.
 *
 * Pure helper — takes a minimal slice of ExtensionAPI so it is fully
 * unit-testable without the pi runtime.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SafeBashMode } from "./config.ts";

/** Minimal API surface applyMode needs. */
export type ToolControl = Pick<
    ExtensionAPI,
    "getActiveTools" | "setActiveTools"
>;

/**
 * Apply the safe-bash mode to the active tool list.
 *
 * - "replace": remove built-in `bash` from active tools (safe_bash takes over).
 *   No-op if bash is already absent (idempotent).
 * - "coexist": leave the tool list untouched (both bash + safe_bash available).
 */
export function applyMode(api: ToolControl, mode: SafeBashMode): void {
    if (mode !== "replace") return;

    const active = api.getActiveTools();
    if (!active.includes("bash")) return;

    api.setActiveTools(active.filter((tool) => tool !== "bash"));
}

/**
 * Decide whether a tool_call for the given tool should be blocked.
 *
 * Only built-in `bash` is blocked, and only in `replace` mode. `safe_bash`
 * and every other tool always pass through.
 *
 * This is the hard guarantee that prevents bash execution even when the LLM
 * still references bash from earlier conversation history (setActiveTools only
 * filters the prompt, not execution).
 */
export function shouldBlockBashCall(
    toolName: string,
    mode: SafeBashMode,
): boolean {
    return mode === "replace" && toolName === "bash";
}

/**
 * Restore built-in `bash` to the active tool list if missing.
 *
 * Used when flipping mode back to `coexist` at runtime — `applyMode` only
 * removes bash (replace direction); this handles the reverse.
 *
 * @returns true if the tool list was changed, false if bash was already present.
 */
export function restoreBash(api: ToolControl): boolean {
    const active = api.getActiveTools();
    if (active.includes("bash")) return false;
    api.setActiveTools([...active, "bash"]);
    return true;
}
