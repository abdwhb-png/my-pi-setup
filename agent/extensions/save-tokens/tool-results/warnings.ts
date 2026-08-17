// ---------------------------------------------------------------------------
// Per-session warning deduplication for compression failures.
//
// Warnings are deduplicated by a stable backend/reason key so a recurring
// failure class notifies the user at most once per session. The dedupe state
// is reset on `session_start` (see local-tool-result-compressor.ts).
// ---------------------------------------------------------------------------

/**
 * Stable dedupe key for a compression warning.
 *
 * Uses the selected backend id and the exact failure reason; when the backend
 * is unknown (policy/cap-only paths) it falls back to `policy`, and missing
 * reasons fall back to `unknown`.
 */
export function warningKeyFor(event: {
    backend?: string;
    reason?: string;
}): string {
    const backend = event.backend ?? "policy";
    const reason = event.reason ?? "unknown";
    return `${backend}/${reason}`;
}

/** Tracks which warning keys were already surfaced this session. */
export function createWarningDeduplicator() {
    const seen = new Set<string>();

    return {
        /** True the first time a key is seen; false for repeats. */
        shouldWarn(key: string): boolean {
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        },
        /** Clears all seen keys — call on session start. */
        reset(): void {
            seen.clear();
        },
    };
}
