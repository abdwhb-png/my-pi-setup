import { describe, expect, it } from "bun:test";
import {
    isPendingVerificationRun,
    type PendingVerificationRun,
} from "./verification-runner";

const pendingRun: PendingVerificationRun = {
    runId: "verification-1",
    ownerSessionId: "owner-session",
    ownerSessionFile: "/tmp/owner-session.jsonl",
    brainstormRunId: "brainstorm-1",
    claimIds: ["CL-001"],
    startedAt: "2026-08-18T12:00:00.000Z",
    expectedSteps: [
        {
            role: "verifier",
            outputName: "verify_local_code_supported",
            agent: "brainstorm-scout",
            domain: "local-code",
            outcome: "supported",
            claimIds: ["CL-001"],
            evidenceIds: ["EV-001"],
        },
    ],
};

describe("structured verification ownership", () => {
    it("accepts 0.50 coordinator metadata without an async artifact path", () => {
        expect(isPendingVerificationRun(pendingRun)).toBe(true);
    });

    it("rejects duplicate outputs and claims outside the owned run", () => {
        expect(
            isPendingVerificationRun({
                ...pendingRun,
                expectedSteps: [
                    ...pendingRun.expectedSteps,
                    {
                        ...pendingRun.expectedSteps[0],
                        claimIds: ["CL-999"],
                    },
                ],
            }),
        ).toBe(false);
    });
});
