import { describe, expect, it } from "bun:test";
import {
    getPlanReviewState,
    listPlanReviewStates,
    nextPlanRevision,
    normalizeSubmittedPlanPath,
    normalizeWrittenPlanPath,
    PLAN_REVIEW_ABANDONED_ENTRY,
    PLAN_REVIEW_REVISION_ENTRY,
    PLAN_REVIEW_SUBMITTED_ENTRY,
} from "./plan-submission-lifecycle.ts";

type Entry = {
    type: "custom";
    customType: string;
    data: Record<string, unknown>;
    id: string;
};

function entry(
    customType: string,
    data: Record<string, unknown>,
    id: string,
): Entry {
    return { type: "custom", customType, data, id };
}

const cwd = "/workspace";
const planDir = "pi-plans";
const path = "pi-plans/feature.md";

describe("plan submission lifecycle", () => {
    it("normalizes write and submit paths to the same cwd-relative identity", () => {
        expect(normalizeWrittenPlanPath("feature.md", cwd, planDir)).toBe(path);
        expect(normalizeSubmittedPlanPath(path, cwd, planDir)).toBe(path);
    });

    it("rejects a submitted path outside the configured plan directory", () => {
        expect(normalizeSubmittedPlanPath("README.md", cwd, planDir)).toBeNull();
    });

    it("marks a matching approved submission as approved", () => {
        const entries = [
            entry(PLAN_REVIEW_REVISION_ENTRY, { path, revision: 1 }, "write-1"),
            entry(
                PLAN_REVIEW_SUBMITTED_ENTRY,
                { path, revision: 1, approved: true },
                "submit-1",
            ),
        ];

        expect(getPlanReviewState(entries, path)).toEqual({
            path,
            revision: 1,
            status: "approved",
        });
    });

    it("invalidates approval when a later write creates a new revision", () => {
        const entries = [
            entry(PLAN_REVIEW_REVISION_ENTRY, { path, revision: 1 }, "write-1"),
            entry(
                PLAN_REVIEW_SUBMITTED_ENTRY,
                { path, revision: 1, approved: true },
                "submit-1",
            ),
            entry(PLAN_REVIEW_REVISION_ENTRY, { path, revision: 2 }, "write-2"),
        ];

        expect(nextPlanRevision(entries, path)).toBe(3);
        expect(getPlanReviewState(entries, path)).toEqual({
            path,
            revision: 2,
            status: "draft",
        });
    });

    it("keeps a denied review from authorizing the revision", () => {
        const entries = [
            entry(PLAN_REVIEW_REVISION_ENTRY, { path, revision: 1 }, "write-1"),
            entry(
                PLAN_REVIEW_SUBMITTED_ENTRY,
                { path, revision: 1, approved: false },
                "submit-1",
            ),
        ];

        expect(getPlanReviewState(entries, path)).toEqual({
            path,
            revision: 1,
            status: "submitted-denied",
        });
    });

    it("records an explicit abandonment for the latest revision", () => {
        const entries = [
            entry(PLAN_REVIEW_REVISION_ENTRY, { path, revision: 1 }, "write-1"),
            entry(
                PLAN_REVIEW_ABANDONED_ENTRY,
                { path, revision: 1 },
                "abandon-1",
            ),
        ];

        expect(getPlanReviewState(entries, path)).toEqual({
            path,
            revision: 1,
            status: "abandoned",
        });
    });

    it("returns the latest state for every tracked plan path", () => {
        const otherPath = "pi-plans/other.md";
        const entries = [
            entry(PLAN_REVIEW_REVISION_ENTRY, { path, revision: 1 }, "write-1"),
            entry(
                PLAN_REVIEW_SUBMITTED_ENTRY,
                { path, revision: 1, approved: true },
                "submit-1",
            ),
            entry(
                PLAN_REVIEW_REVISION_ENTRY,
                { path: otherPath, revision: 1 },
                "write-2",
            ),
        ];

        expect(listPlanReviewStates(entries)).toEqual([
            { path, revision: 1, status: "approved" },
            { path: otherPath, revision: 1, status: "draft" },
        ]);
    });
});
