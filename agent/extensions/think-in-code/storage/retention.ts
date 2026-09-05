/**
 * Retention for the per-project Think-in-Code store.
 *
 * Two passes:
 *   1. Delete archive rows/files whose `expires_at` is in the past.
 *   2. If total archive bytes still exceed the project quota, evict the
 *      oldest archives first.
 *
 * Retention never follows symlinks and never deletes files outside the
 * project store. The store's `deleteArchives` enforces that boundary
 * internally.
 */

import type { ThinkInCodeConfig } from "../config.ts";
import type { ThinkStore } from "./store.ts";

export interface RetentionReport {
    expiredDeleted: number;
    quotaEvicted: number;
    bytesReclaimed: number;
    ranAt: number;
}

export interface RetentionOptions {
    /** Override current time (ms since epoch). Default: Date.now. */
    now?: () => number;
}

/**
 * Run a single retention pass. Idempotent and safe to call from `session_start`
 * or after every archive write.
 */
export function runRetention(
    store: ThinkStore,
    config: ThinkInCodeConfig,
    options: RetentionOptions = {},
): RetentionReport {
    const now = options.now ?? Date.now;
    const ranAt = now();
    const expiredIds = store.expiredArchiveIds(ranAt);
    const expiredBytes = store.deleteArchives(expiredIds);
    let quotaEvicted = 0;
    let quotaBytes = 0;
    if (store.archiveBytes() > config.projectQuotaBytes) {
        const evictIds = store.archivesOverQuota(config.projectQuotaBytes);
        quotaBytes = store.deleteArchives(evictIds);
        quotaEvicted = evictIds.length;
    }
    return {
        expiredDeleted: expiredIds.length,
        quotaEvicted,
        bytesReclaimed: expiredBytes + quotaBytes,
        ranAt,
    };
}
