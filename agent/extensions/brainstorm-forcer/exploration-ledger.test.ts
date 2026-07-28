import { describe, expect, it } from "bun:test";
import { createExplorationLedger } from "./exploration-ledger";

describe("exploration ledger", () => {
    it("captures bounded evidence metadata without persisting raw tool data", () => {
        const ledger = createExplorationLedger({
            runId: "brainstorm-test",
            now: () => "2026-07-28T12:00:00.000Z",
            homeDir: "/home/test",
        });

        const evidence = ledger.captureEvidence({
            toolCallId: "call-1",
            toolName: "read",
            input: {
                path: "/home/test/project/README.md",
                token: "must-not-persist",
            },
            content: [{ type: "text", text: "private output" }],
            details: undefined,
            isError: false,
        });

        expect(evidence).toMatchObject({
            id: "EV-001",
            kind: "evidence",
            runId: "brainstorm-test",
            phase: "exploring",
            toolName: "read",
            status: "success",
            timestamp: "2026-07-28T12:00:00.000Z",
            sourceRefs: ["~/project/README.md"],
            nativeRef: "session:tool-result:call-1",
            sourceKind: "direct",
            staleness: "fresh",
        });
        expect(evidence.inputHash).toMatch(/^[a-f0-9]{64}$/);
        expect(evidence.outputHash).toMatch(/^[a-f0-9]{64}$/);
        expect(JSON.stringify(evidence)).not.toContain("must-not-persist");
        expect(JSON.stringify(evidence)).not.toContain("private output");
    });

    it("classifies failed, indexed, and fresh reviewer evidence", () => {
        const ledger = createExplorationLedger({ runId: "brainstorm-test" });

        const failed = ledger.captureEvidence({
            toolCallId: "call-1",
            toolName: "read",
            input: { path: "missing.md" },
            content: [{ type: "text", text: "ENOENT" }],
            details: undefined,
            isError: true,
        });
        const indexed = ledger.captureEvidence({
            toolCallId: "call-2",
            toolName: "ctx_search",
            input: { queries: ["claim"], source: "ADR-007" },
            content: [{ type: "text", text: "Indexed result" }],
            details: {},
            isError: false,
        });
        const reviewer = ledger.captureEvidence({
            toolCallId: "call-3",
            toolName: "subagent",
            input: {
                agent: "reviewer",
                context: "fresh",
                task: "Review CL-001 against EV-001.",
            },
            content: [
                {
                    type: "text",
                    text: "CL-001 is supported by EV-001.",
                },
            ],
            details: {
                mode: "single",
                context: "fresh",
                results: [
                    {
                        agent: "reviewer",
                        exitCode: 0,
                        sessionFile: "/tmp/reviewer.jsonl",
                    },
                ],
            },
            isError: false,
        });

        expect(failed).toMatchObject({ status: "error", sourceKind: "direct" });
        expect(indexed).toMatchObject({
            status: "success",
            sourceKind: "indexed",
            staleness: "unknown",
        });
        expect(reviewer).toMatchObject({
            sourceKind: "reviewer",
            reviewer: {
                agent: "reviewer",
                context: "fresh",
                exitCode: 0,
                referencedClaimIds: ["CL-001"],
                referencedEvidenceIds: ["EV-001"],
            },
        });
        expect(JSON.stringify(reviewer)).not.toContain("Review CL-001");
        expect(JSON.stringify(reviewer)).not.toContain("supported by");
    });

    it("records an empirical claim against same-run evidence", () => {
        const ledger = createExplorationLedger({ runId: "brainstorm-test" });
        const evidence = ledger.captureEvidence({
            toolCallId: "call-1",
            toolName: "read",
            input: { path: "README.md" },
            content: [{ type: "text", text: "observable result" }],
            details: undefined,
            isError: false,
        });

        const claim = ledger.recordClaim({
            assertion: "The extension restores session state.",
            classification: "empirical",
            critical: true,
            verdict: "verified",
            evidenceIds: [evidence.id],
            contradictoryEvidenceIds: [],
            impact: "Determines reload safety.",
            mitigation: "Block transition if restoration fails.",
        });

        expect(claim).toMatchObject({
            id: "CL-001",
            kind: "claim",
            runId: "brainstorm-test",
            evidenceIds: ["EV-001"],
            classification: "empirical",
            verdict: "verified",
        });
        expect(ledger.getActiveClaims()).toEqual([claim]);
    });

    it("requires direct corroboration for critical indexed evidence", () => {
        const ledger = createExplorationLedger({ runId: "brainstorm-test" });
        const indexed = ledger.captureEvidence({
            toolCallId: "call-1",
            toolName: "ctx_search",
            input: { queries: ["claim"], source: "ADR-007" },
            content: [{ type: "text", text: "Indexed result" }],
            details: {},
            isError: false,
        });

        expect(() =>
            ledger.recordClaim({
                assertion: "Indexed result is current.",
                classification: "empirical",
                critical: true,
                verdict: "verified",
                evidenceIds: [indexed.id],
                contradictoryEvidenceIds: [],
                impact: "Could change the recommendation.",
                mitigation: "Inspect the primary source.",
            }),
        ).toThrow("direct corroborating evidence");
    });

    it("rejects a verified claim supported only by a failed result", () => {
        const ledger = createExplorationLedger({ runId: "brainstorm-test" });
        const failed = ledger.captureEvidence({
            toolCallId: "call-1",
            toolName: "read",
            input: { path: "missing.md" },
            content: [{ type: "text", text: "ENOENT" }],
            details: undefined,
            isError: true,
        });

        expect(() =>
            ledger.recordClaim({
                assertion: "The file exists.",
                classification: "empirical",
                critical: false,
                verdict: "verified",
                evidenceIds: [failed.id],
                contradictoryEvidenceIds: [],
                impact: "Would change implementation scope.",
                mitigation: "Retry direct inspection.",
            }),
        ).toThrow("successful eligible evidence");
    });

    it("supersedes claims without mutating ledger history", () => {
        const ledger = createExplorationLedger({ runId: "brainstorm-test" });
        const original = ledger.recordClaim({
            assertion: "Use a dedicated database.",
            classification: "design-choice",
            critical: false,
            verdict: "unresolved",
            evidenceIds: [],
            contradictoryEvidenceIds: [],
            impact: "Adds operational cost.",
            mitigation: "Prefer session entries.",
        });
        const replacement = ledger.recordClaim({
            assertion: "Use append-only session entries.",
            classification: "design-choice",
            critical: false,
            verdict: "unresolved",
            evidenceIds: [],
            contradictoryEvidenceIds: [],
            impact: "Keeps state branch-local.",
            mitigation: "Bound stored metadata.",
            supersedesClaimId: original.id,
        });

        expect(ledger.getActiveClaims()).toEqual([replacement]);
        expect(original).not.toHaveProperty("supersededBy");
    });

    it("records explicit review only from fresh reviewer evidence", () => {
        const ledger = createExplorationLedger({ runId: "brainstorm-test" });
        const primary = ledger.captureEvidence({
            toolCallId: "call-1",
            toolName: "read",
            input: { path: "index.ts" },
            content: [{ type: "text", text: "observable result" }],
            details: undefined,
            isError: false,
        });
        const claim = ledger.recordClaim({
            assertion: "The gate is enforced in one function.",
            classification: "empirical",
            critical: true,
            verdict: "verified",
            evidenceIds: [primary.id],
            contradictoryEvidenceIds: [],
            impact: "Controls all forward transitions.",
            mitigation: "Keep one shared blocker.",
        });
        const reviewer = ledger.captureEvidence({
            toolCallId: "call-2",
            toolName: "subagent",
            input: {
                agent: "reviewer",
                context: "fresh",
                task: `Review ${claim.id}.`,
            },
            content: [
                {
                    type: "text",
                    text: `Reviewed ${claim.id}; direct proof: ${primary.id}.`,
                },
            ],
            details: {
                mode: "single",
                context: "fresh",
                results: [{ agent: "reviewer", exitCode: 0 }],
            },
            isError: false,
        });

        const review = ledger.recordReview({
            reviewerEvidenceId: reviewer.id,
            claimIds: [claim.id],
            primaryEvidenceIds: [primary.id],
            summary: "Critical gate claim is supported.",
        });

        expect(review).toMatchObject({
            id: "RV-001",
            reviewerEvidenceId: "EV-002",
            claimIds: ["CL-001"],
            primaryEvidenceIds: ["EV-001"],
        });
    });

    it("requires a waiver and later review for unresolved critical claims", () => {
        const ledger = createExplorationLedger({ runId: "brainstorm-test" });
        const failed = ledger.captureEvidence({
            toolCallId: "call-1",
            toolName: "read",
            input: { path: "missing.md" },
            content: [{ type: "text", text: "ENOENT" }],
            details: undefined,
            isError: true,
        });
        const unresolved = ledger.recordClaim({
            assertion: "The missing file defines runtime behavior.",
            classification: "empirical",
            critical: true,
            verdict: "unresolved",
            evidenceIds: [failed.id],
            contradictoryEvidenceIds: [],
            impact: "Could invalidate the recommendation.",
            mitigation: "Re-evaluate when the file is available.",
        });
        const choice = ledger.recordClaim({
            assertion: "Use append-only session entries.",
            classification: "design-choice",
            critical: false,
            verdict: "unresolved",
            evidenceIds: [],
            contradictoryEvidenceIds: [],
            impact: "Avoids a second persistence layer.",
            mitigation: "Keep records bounded.",
        });
        const submission = {
            approachClaimIds: [[unresolved.id, choice.id]],
            recommendationClaimIds: [choice.id],
            userChoice: "Append-only session entries",
        };

        expect(ledger.getGateBlockers(submission)).toContain(
            `${unresolved.id} requires a user-approved waiver.`,
        );

        ledger.recordWaiver({
            claimId: unresolved.id,
            reason: "Primary source is temporarily unavailable.",
            impact: "Recommendation retains uncertainty.",
            mitigation: "Do not treat the claim as verified.",
            reevaluateWhen: "The source becomes available.",
        });
        expect(ledger.getGateBlockers(submission)).toContain(
            `${unresolved.id} requires a fresh completed review.`,
        );

        const reviewer = ledger.captureEvidence({
            toolCallId: "call-2",
            toolName: "subagent",
            input: {
                agent: "reviewer",
                context: "fresh",
                task: `Review ${unresolved.id}.`,
            },
            content: [
                {
                    type: "text",
                    text: `Reviewed ${unresolved.id}; attempt: ${failed.id}.`,
                },
            ],
            details: {
                mode: "single",
                context: "fresh",
                results: [{ agent: "reviewer", exitCode: 0 }],
            },
            isError: false,
        });
        ledger.recordReview({
            reviewerEvidenceId: reviewer.id,
            claimIds: [unresolved.id],
            primaryEvidenceIds: [failed.id],
            summary: "Waiver is bounded and must be revisited.",
        });

        expect(ledger.getGateBlockers(submission)).toEqual([]);
    });

    it("records confirmed user gate overrides without mutating prior records", () => {
        const ledger = createExplorationLedger({ runId: "brainstorm-test" });

        const override = ledger.recordOverride({
            command: "/brainstorm next --force",
            blockers: ["CL-001 requires a fresh completed review."],
            reason: "Urgent design review must proceed with known uncertainty.",
            fromPhase: "exploring",
            toPhase: "presenting",
        });

        expect(override).toMatchObject({
            id: "OV-001",
            kind: "override",
            runId: "brainstorm-test",
            fromPhase: "exploring",
            toPhase: "presenting",
        });
        expect(ledger.getRecords()).toEqual([override]);
    });

    it("restores immutable records and continues each ID sequence", () => {
        const first = createExplorationLedger({ runId: "brainstorm-test" });
        first.captureEvidence({
            toolCallId: "call-1",
            toolName: "read",
            input: { path: "README.md" },
            content: [{ type: "text", text: "result" }],
            details: undefined,
            isError: false,
        });
        first.recordClaim({
            assertion: "Use session entries.",
            classification: "design-choice",
            critical: false,
            verdict: "unresolved",
            evidenceIds: [],
            contradictoryEvidenceIds: [],
            impact: "Avoids duplicate persistence.",
            mitigation: "Bound records.",
        });

        const restored = createExplorationLedger({
            runId: "brainstorm-test",
            initialRecords: first.getRecords(),
        });
        const evidence = restored.captureEvidence({
            toolCallId: "call-2",
            toolName: "grep",
            input: { pattern: "appendEntry", path: "index.ts" },
            content: [{ type: "text", text: "match" }],
            details: undefined,
            isError: false,
        });
        const claim = restored.recordClaim({
            assertion: "Use one ledger entry type.",
            classification: "design-choice",
            critical: false,
            verdict: "unresolved",
            evidenceIds: [],
            contradictoryEvidenceIds: [],
            impact: "Simplifies restoration.",
            mitigation: "Keep record kinds explicit.",
        });

        expect(evidence.id).toBe("EV-002");
        expect(claim.id).toBe("CL-002");
        expect(restored.getRecords()).toHaveLength(4);
    });

    it("keeps design choices and future contingencies unresolved", () => {
        const ledger = createExplorationLedger({ runId: "brainstorm-test" });

        expect(() =>
            ledger.recordClaim({
                assertion: "Choose session entries.",
                classification: "design-choice",
                critical: false,
                verdict: "verified",
                evidenceIds: [],
                contradictoryEvidenceIds: [],
                impact: "Sets persistence architecture.",
                mitigation: "Document the trade-off.",
            }),
        ).toThrow("design-choice claims must remain unresolved");
    });

    it("sanitizes bounded URL and source references", () => {
        const ledger = createExplorationLedger({ runId: "brainstorm-test" });

        const evidence = ledger.captureEvidence({
            toolCallId: "call-1",
            toolName: "fetch_content",
            input: {
                urls: [
                    "https://user:password@example.com/docs?token=secret#section",
                ],
                source: "official-docs",
                apiKey: "must-not-persist",
            },
            content: [{ type: "text", text: "page" }],
            details: undefined,
            isError: false,
        });

        expect(evidence.sourceRefs).toEqual([
            "https://example.com/docs",
            "official-docs",
        ]);
        expect(JSON.stringify(evidence)).not.toMatch(/password|secret|apiKey/);
    });

    it("preserves an explicit stale-source signal", () => {
        const ledger = createExplorationLedger({ runId: "brainstorm-test" });

        const evidence = ledger.captureEvidence({
            toolCallId: "call-1",
            toolName: "ctx_search",
            input: { queries: ["claim"] },
            content: [{ type: "text", text: "cached result" }],
            details: { stale: true },
            isError: false,
        });

        expect(evidence.staleness).toBe("stale");
    });

    it("renders the complete bounded Exploring artifact from ledger records", () => {
        const ledger = createExplorationLedger({ runId: "brainstorm-test" });
        const evidence = ledger.captureEvidence({
            toolCallId: "call-1",
            toolName: "read",
            input: { path: "index.ts" },
            content: [{ type: "text", text: "raw-output-must-stay-native" }],
            details: undefined,
            isError: false,
        });
        const empirical = ledger.recordClaim({
            assertion: "Session entries survive reload.",
            classification: "empirical",
            critical: false,
            verdict: "verified",
            evidenceIds: [evidence.id],
            contradictoryEvidenceIds: [],
            impact: "Supports append-only persistence.",
            mitigation: "Keep a reload test.",
        });
        const choice = ledger.recordClaim({
            assertion: "Use one append-only ledger entry type.",
            classification: "design-choice",
            critical: false,
            verdict: "unresolved",
            evidenceIds: [],
            contradictoryEvidenceIds: [],
            impact: "Keeps persistence small.",
            mitigation: "Keep record kinds explicit.",
        });

        const markdown = ledger.renderExplorationMarkdown({
            approaches: [
                {
                    title: "Session ledger",
                    summary: "Persist records in session entries.",
                    tradeoffs: ["Session grows with evidence count."],
                    claimIds: [empirical.id, choice.id],
                    failureConditions: ["Records are not bounded."],
                },
                {
                    title: "Artifact ledger",
                    summary: "Persist records in a separate file.",
                    tradeoffs: ["Adds a persistence layer."],
                    claimIds: [choice.id],
                    failureConditions: ["File diverges from session."],
                },
            ],
            recommendation: "Use the session ledger.",
            recommendationClaimIds: [empirical.id, choice.id],
            userChoice: "Session ledger",
        });

        for (const heading of [
            "## Assumption Register",
            "## Evidence Index",
            "## Verified Findings",
            "## Falsified Findings",
            "## Design Choices",
            "## Residual Unknowns and Waivers",
            "## Approach Comparison",
            "## Evidence-backed Recommendation",
            "## Review Record",
            "## Overrides",
            "## User Choice",
        ]) {
            expect(markdown).toContain(heading);
        }
        expect(markdown).toContain("CL-001");
        expect(markdown).toContain("EV-001");
        expect(markdown).not.toContain("raw-output-must-stay-native");
    });

    it("hashes equivalent tool inputs canonically", () => {
        const ledger = createExplorationLedger({ runId: "brainstorm-test" });
        const first = ledger.captureEvidence({
            toolCallId: "call-1",
            toolName: "grep",
            input: { pattern: "claim", path: "index.ts" },
            content: [{ type: "text", text: "match" }],
            details: undefined,
            isError: false,
        });
        const second = ledger.captureEvidence({
            toolCallId: "call-2",
            toolName: "grep",
            input: { path: "index.ts", pattern: "claim" },
            content: [{ type: "text", text: "match" }],
            details: undefined,
            isError: false,
        });

        expect(first.inputHash).toBe(second.inputHash);
    });

    it("rejects contradictory evidence outside the claim evidence set", () => {
        const ledger = createExplorationLedger({ runId: "brainstorm-test" });
        const evidence = ledger.captureEvidence({
            toolCallId: "call-1",
            toolName: "read",
            input: { path: "index.ts" },
            content: [{ type: "text", text: "result" }],
            details: undefined,
            isError: false,
        });

        expect(() =>
            ledger.recordClaim({
                assertion: "Evidence conflicts.",
                classification: "empirical",
                critical: false,
                verdict: "unresolved",
                evidenceIds: [evidence.id],
                contradictoryEvidenceIds: ["EV-999"],
                impact: "Requires review.",
                mitigation: "Acquire another direct result.",
            }),
        ).toThrow("Contradictory evidence EV-999");
    });

    it("rejects supersession of an unknown active claim", () => {
        const ledger = createExplorationLedger({ runId: "brainstorm-test" });

        expect(() =>
            ledger.recordClaim({
                assertion: "Replacement claim.",
                classification: "design-choice",
                critical: false,
                verdict: "unresolved",
                evidenceIds: [],
                contradictoryEvidenceIds: [],
                impact: "Changes the trade-off.",
                mitigation: "Keep immutable history.",
                supersedesClaimId: "CL-999",
            }),
        ).toThrow("Unknown active claim: CL-999");
    });

    it("marks synthesized search output as secondary evidence", () => {
        const ledger = createExplorationLedger({ runId: "brainstorm-test" });
        const evidence = ledger.captureEvidence({
            toolCallId: "call-1",
            toolName: "web_search",
            input: { query: "official model limits" },
            content: [{ type: "text", text: "synthesized answer" }],
            details: undefined,
            isError: false,
        });

        expect(evidence.sourceKind).toBe("secondary");
    });
});
