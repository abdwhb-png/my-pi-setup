import type { SafeBashMode } from "./config.ts";

/** Keep the execution gate even when an external extension re-exposes bash. */
export function shouldBlockBashCall(
    toolName: string,
    mode: SafeBashMode,
): boolean {
    return mode === "replace" && toolName === "bash";
}
