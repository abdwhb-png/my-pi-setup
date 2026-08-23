// oxlint-disable typescript/no-restricted-types -- Pi custom session entry data is intentionally unknown at this boundary.
import { isAbsolute, relative, resolve, sep } from "node:path";

export const PLAN_REVIEW_REVISION_ENTRY = "plan-review-guard:revision";
export const PLAN_REVIEW_SUBMITTED_ENTRY = "plan-review-guard:submitted";
export const PLAN_REVIEW_ABANDONED_ENTRY = "plan-review-guard:abandoned";

export type PlanReviewStatus =
    | "draft"
    | "submitted-denied"
    | "approved"
    | "abandoned";

export interface PlanReviewState {
    path: string;
    revision: number;
    status: PlanReviewStatus;
}

interface SessionEntry {
    type: string;
    customType?: string;
    data?: unknown;
}

function isWithin(root: string, target: string): boolean {
    const pathFromRoot = relative(root, target);
    return !pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot);
}

function toCwdRelativePath(target: string, cwd: string): string {
    return relative(resolve(cwd), target).split(sep).join("/");
}

function normalizePlanPath(
    rawPath: string,
    cwd: string,
    planDir: string,
    baseDir: string,
): string | null {
    const trimmed = rawPath.trim();
    if (!trimmed || trimmed.includes("..")) return null;

    const planRoot = resolve(cwd, planDir);
    const target = resolve(baseDir, trimmed);
    if (!isWithin(planRoot, target)) return null;
    return toCwdRelativePath(target, cwd);
}

export function normalizeWrittenPlanPath(
    rawPath: string,
    cwd: string,
    planDir: string,
): string | null {
    return normalizePlanPath(rawPath, cwd, planDir, resolve(cwd, planDir));
}

export function normalizeSubmittedPlanPath(
    rawPath: string,
    cwd: string,
    planDir: string,
): string | null {
    return normalizePlanPath(rawPath, cwd, planDir, resolve(cwd));
}

function readPathAndRevision(
    entry: SessionEntry,
): { path: string; revision: number } | null {
    if (!entry.data || typeof entry.data !== "object") return null;
    const data = entry.data as { path?: unknown; revision?: unknown };
    if (
        typeof data.path !== "string" ||
        typeof data.revision !== "number" ||
        !Number.isSafeInteger(data.revision) ||
        data.revision < 1
    ) {
        return null;
    }
    return { path: data.path, revision: data.revision };
}

export function nextPlanRevision(
    entries: readonly SessionEntry[],
    path: string,
): number {
    let latest = 0;
    for (const entry of entries) {
        if (
            entry.type !== "custom" ||
            entry.customType !== PLAN_REVIEW_REVISION_ENTRY
        ) {
            continue;
        }
        const data = readPathAndRevision(entry);
        if (data?.path === path) latest = Math.max(latest, data.revision);
    }
    return latest + 1;
}

export function listPlanReviewStates(
    entries: readonly SessionEntry[],
): PlanReviewState[] {
    const paths: string[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
        if (
            entry.type !== "custom" ||
            entry.customType !== PLAN_REVIEW_REVISION_ENTRY
        ) {
            continue;
        }
        const data = readPathAndRevision(entry);
        if (data && !seen.has(data.path)) {
            seen.add(data.path);
            paths.push(data.path);
        }
    }
    return paths
        .map((path) => getPlanReviewState(entries, path))
        .filter((state): state is PlanReviewState => state !== null);
}

export function getPlanReviewState(
    entries: readonly SessionEntry[],
    path: string,
): PlanReviewState | null {
    const revision = nextPlanRevision(entries, path) - 1;
    if (revision < 1) return null;

    let submitted: boolean | undefined;
    let abandoned = false;
    for (const entry of entries) {
        if (entry.type !== "custom") continue;
        const data = readPathAndRevision(entry);
        if (!data || data.path !== path || data.revision !== revision) continue;

        if (entry.customType === PLAN_REVIEW_SUBMITTED_ENTRY) {
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- validated custom entry boundary.
            const details = entry.data as { approved?: unknown };
            if (typeof details.approved === "boolean")
                submitted = details.approved;
        }
        if (entry.customType === PLAN_REVIEW_ABANDONED_ENTRY) abandoned = true;
    }

    if (abandoned) return { path, revision, status: "abandoned" };
    if (submitted === true) return { path, revision, status: "approved" };
    if (submitted === false) {
        return { path, revision, status: "submitted-denied" };
    }
    return { path, revision, status: "draft" };
}
