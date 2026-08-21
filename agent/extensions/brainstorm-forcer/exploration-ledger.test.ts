import { describe, expect, it } from "bun:test";
import {
    createExplorationLedger,
    isExplorationRecord,
    type ExplorationRecord,
    type ReviewRecord,
} from "./exploration-ledger";

function reviewerChainInput(task: string) {
    return {
        context: "fresh",
        async: false,
        chain: [
            {
                agent: "reviewer",
                task,
                outputSchema: {
                    type: "object",
                    properties: {
                        outcome: {
                            enum: ["supported", "rejected", "unresolved"],
                        },
                        claimIds: { type: "array", items: { type: "string" } },
                        evidenceIds: {
                            type: "array",
                            items: { type: "string" },
                        },
                    },
                    required: ["outcome", "claimIds", "evidenceIds"],
                    additionalProperties: false,
                },
            },
        ],
    };
}

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
                context: "fresh",
                async: false,
                chain: [
                    {
                        agent: "reviewer",
                        task: "Review CL-001 against EV-001.",
                        outputSchema: { type: "object" },
                    },
                ],
            },
            content: [
                {
                    type: "text",
                    text: "CL-001 is supported by EV-001.",
                },
            ],
            details: {
                mode: "chain",
                context: "fresh",
                results: [
                    {
                        agent: "reviewer",
                        exitCode: 0,
                        sessionFile: "/tmp/reviewer.jsonl",
                        structuredOutput: {
                            outcome: "supported",
                            claimIds: ["CL-001"],
                            evidenceIds: ["EV-001"],
                        },
                    },
                ],
            },
            isError: false,
        });
        const userInput = ledger.captureEvidence({
            toolCallId: "call-4",
            toolName: "ask_user_question",
            input: { questions: [] },
            content: [{ type: "text", text: "User response" }],
            details: undefined,
            isError: false,
        });
        const researcher = ledger.captureEvidence({
            toolCallId: "call-5",
            toolName: "subagent",
            input: {
                agent: "researcher",
                context: "fresh",
                task: "Research the claim.",
            },
            content: [{ type: "text", text: "Research summary" }],
            details: {
                mode: "single",
                results: [{ agent: "researcher", exitCode: 0 }],
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
        expect(userInput.sourceKind).toBe("ineligible");
        expect(researcher.sourceKind).toBe("secondary");
        expect(JSON.stringify(reviewer)).not.toContain("Review CL-001");
        expect(JSON.stringify(reviewer)).not.toContain("supported by");
    });

    it("does not treat unknown tool output as eligible evidence", () => {
        const ledger = createExplorationLedger({ runId: "brainstorm-test" });
        const unknown = ledger.captureEvidence({
            toolCallId: "call-unknown",
            toolName: "arbitrary_lookup",
            input: { query: "claim" },
            content: [{ type: "text", text: "unsupported assertion" }],
            details: undefined,
            isError: false,
        });

        expect(unknown.sourceKind).toBe("ineligible");
        expect(() =>
            ledger.recordClaim({
                assertion: "Unknown output proves the claim.",
                classification: "empirical",
                critical: false,
                verdict: "verified",
                evidenceIds: [unknown.id],
                contradictoryEvidenceIds: [],
                impact: "Could alter the recommendation.",
                verificationDomain: "local-code",
                architectureImpact: false,
                mitigation: "Use a direct inspection tool.",
            }),
        ).toThrow("successful eligible evidence");
    });

    it("requires direct source evidence alongside derived execution output", () => {
        const ledger = createExplorationLedger({ runId: "brainstorm-test" });
        const derived = ledger.captureEvidence({
            toolCallId: "call-execute",
            toolName: "ctx_execute",
            input: {
                language: "javascript",
                code: 'console.log("true")',
            },
            content: [{ type: "text", text: "true" }],
            details: undefined,
            isError: false,
        });

        expect(derived.sourceKind).toBe("derived");
        expect(() =>
            ledger.recordClaim({
                assertion: "The generated value proves runtime behavior.",
                classification: "empirical",
                critical: false,
                verdict: "verified",
                evidenceIds: [derived.id],
                contradictoryEvidenceIds: [],
                impact: "Could turn an assertion into fake proof.",
                verificationDomain: "local-code",
                architectureImpact: false,
                mitigation: "Require associated direct source evidence.",
            }),
        ).toThrow("associated direct evidence");

        const direct = ledger.captureEvidence({
            toolCallId: "call-read",
            toolName: "read",
            input: { path: "runtime.ts" },
            content: [{ type: "text", text: "observable source" }],
            details: undefined,
            isError: false,
        });
        expect(
            ledger.recordClaim({
                assertion: "Source plus derived result proves runtime behavior.",
                classification: "empirical",
                critical: true,
                verdict: "verified",
                evidenceIds: [direct.id, derived.id],
                contradictoryEvidenceIds: [],
                impact: "Links measurement to its source.",
                verificationDomain: "local-code",
                architectureImpact: false,
                mitigation: "Keep both evidence records.",
            }).verdict,
        ).toBe("verified");
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
            verificationDomain: "local-code",
            architectureImpact: false,
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
                verificationDomain: "local-code",
                architectureImpact: false,
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
                verificationDomain: "local-code",
                architectureImpact: false,
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
            verificationDomain: "local-code",
            architectureImpact: false,
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
            verificationDomain: "local-code",
            architectureImpact: false,
            mitigation: "Bound stored metadata.",
            supersedesClaimId: original.id,
        });

        expect(ledger.getActiveClaims()).toEqual([replacement]);
        expect(ledger.getStatusSnapshot()).toMatchObject({
            claims: { historical: 2, active: 1 },
            requiredReviewClaimIds: [],
        });
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
            verificationDomain: "local-code",
            architectureImpact: false,
            mitigation: "Keep one shared blocker.",
        });
        const reviewer = ledger.captureEvidence({
            toolCallId: "call-2",
            toolName: "subagent",
            input: reviewerChainInput(`Review ${claim.id}.`),
            content: [
                {
                    type: "text",
                    text: `Reviewed ${claim.id}; direct proof: ${primary.id}.`,
                },
            ],
            details: {
                mode: "single",
                context: "fresh",
                results: [
                    {
                        agent: "reviewer",
                        exitCode: 0,
                        structuredOutput: {
                            outcome: "supported",
                            claimIds: [claim.id],
                            evidenceIds: [primary.id],
                        },
                    },
                ],
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
            outcome: "supported",
            claimIds: ["CL-001"],
            primaryEvidenceIds: ["EV-001"],
        });
        const approach = {
            title: "Central gate",
            summary: "Keep one transition gate.",
            tradeoffs: ["Centralized policy."],
            claimIds: [claim.id],
            failureConditions: ["Gate is bypassed."],
        };
        const markdown = ledger.renderExplorationMarkdown({
            approaches: [approach, { ...approach, title: "Duplicated gate" }],
            recommendation: "Use the central gate.",
            recommendationClaimIds: [claim.id],
            userChoice: "Central gate",
            userChoiceEvidenceId: primary.id,
        });
        expect(markdown).toContain(`${review.id} — outcome: supported`);
    });

    it("rejects a negative structured review outcome for a verified claim", () => {
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
            verificationDomain: "local-code",
            architectureImpact: false,
            mitigation: "Keep one shared blocker.",
        });
        const reviewer = ledger.captureEvidence({
            toolCallId: "call-2",
            toolName: "subagent",
            input: reviewerChainInput(`Review ${claim.id}.`),
            content: [
                {
                    type: "text",
                    text: `${claim.id} is rejected despite ${primary.id}.`,
                },
            ],
            details: {
                mode: "single",
                context: "fresh",
                results: [
                    {
                        agent: "reviewer",
                        exitCode: 0,
                        structuredOutput: {
                            outcome: "rejected",
                            claimIds: [claim.id],
                            evidenceIds: [primary.id],
                        },
                    },
                ],
            },
            isError: false,
        });

        expect(() =>
            ledger.recordReview({
                reviewerEvidenceId: reviewer.id,
                claimIds: [claim.id],
                primaryEvidenceIds: [primary.id],
                summary: "Reviewer rejected the verified claim.",
            }),
        ).toThrow("outcome does not support");
    });

    it("requires structured reviewer coverage of every contradictory evidence record", () => {
        const ledger = createExplorationLedger({ runId: "brainstorm-test" });
        const primary = ledger.captureEvidence({
            toolCallId: "call-primary",
            toolName: "read",
            input: { path: "index.ts" },
            content: [{ type: "text", text: "direct result" }],
            details: undefined,
            isError: false,
        });
        const contradiction = ledger.captureEvidence({
            toolCallId: "call-contradiction",
            toolName: "web_search",
            input: { query: "counterexample" },
            content: [{ type: "text", text: "secondary counterexample" }],
            details: undefined,
            isError: false,
        });
        const claim = ledger.recordClaim({
            assertion: "The gate is enforced in one function.",
            classification: "empirical",
            critical: true,
            verdict: "verified",
            evidenceIds: [primary.id, contradiction.id],
            contradictoryEvidenceIds: [contradiction.id],
            impact: "Controls all forward transitions.",
            verificationDomain: "local-code",
            architectureImpact: false,
            mitigation: "Review the counterexample explicitly.",
        });
        const reviewer = ledger.captureEvidence({
            toolCallId: "call-review",
            toolName: "subagent",
            input: reviewerChainInput(`Review ${claim.id}.`),
            content: [{ type: "text", text: "Structured review complete." }],
            details: {
                mode: "single",
                context: "fresh",
                results: [
                    {
                        agent: "reviewer",
                        exitCode: 0,
                        structuredOutput: {
                            outcome: "supported",
                            claimIds: [claim.id],
                            evidenceIds: [primary.id],
                        },
                    },
                ],
            },
            isError: false,
        });

        expect(() =>
            ledger.recordReview({
                reviewerEvidenceId: reviewer.id,
                claimIds: [claim.id],
                primaryEvidenceIds: [primary.id],
                summary: "Counterexample was omitted.",
            }),
        ).toThrow("contradictory evidence");
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
            verificationDomain: "local-code",
            architectureImpact: false,
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
            verificationDomain: "local-code",
            architectureImpact: false,
            mitigation: "Keep records bounded.",
        });
        const userChoiceEvidence = ledger.captureEvidence({
            toolCallId: "call-choice",
            toolName: "ask_user_question",
            input: { questions: [{ question: "Which approach?" }] },
            content: [{ type: "text", text: "Append-only session entries" }],
            details: {
                cancelled: false,
                answers: [
                    {
                        questionIndex: 0,
                        question: "Which approach?",
                        kind: "option",
                        answer: "Append-only session entries",
                    },
                ],
            },
            isError: false,
        });
        const submission = {
            approachClaimIds: [[unresolved.id, choice.id]],
            recommendationClaimIds: [choice.id],
            userChoice: "Append-only session entries",
            userChoiceEvidenceId: userChoiceEvidence.id,
        };

        expect(ledger.getGateBlockers(submission)).toContain(
            `${unresolved.id} requires a user-approved waiver.`,
        );
        expect(ledger.getStatusSnapshot()).toMatchObject({
            waiverRequiredClaimIds: [unresolved.id],
            finalChoice: "blockedByWaivers",
        });

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
        expect(ledger.getStatusSnapshot()).toMatchObject({
            waiverRequiredClaimIds: [],
            missingSuccessfulReviewClaimIds: [unresolved.id],
            finalChoice: "blockedByReviews",
        });

        const reviewer = ledger.captureEvidence({
            toolCallId: "call-2",
            toolName: "subagent",
            input: reviewerChainInput(`Review ${unresolved.id}.`),
            content: [
                {
                    type: "text",
                    text: `Reviewed ${unresolved.id}; attempt: ${failed.id}.`,
                },
            ],
            details: {
                mode: "single",
                context: "fresh",
                results: [
                    {
                        agent: "reviewer",
                        exitCode: 0,
                        structuredOutput: {
                            outcome: "unresolved",
                            claimIds: [unresolved.id],
                            evidenceIds: [failed.id],
                        },
                    },
                ],
            },
            isError: false,
        });
        ledger.recordReview({
            reviewerEvidenceId: reviewer.id,
            claimIds: [unresolved.id],
            primaryEvidenceIds: [failed.id],
            summary: "Waiver is bounded and must be revisited.",
        });

        expect(ledger.getGateBlockers(submission)).toContain(
            "User choice evidence must follow required review RV-001.",
        );
        const finalChoiceEvidence = ledger.captureEvidence({
            toolCallId: "call-final-choice",
            toolName: "ask_user_question",
            input: { questions: [{ question: "Which approach?" }] },
            content: [{ type: "text", text: "Append-only session entries" }],
            details: {
                cancelled: false,
                answers: [
                    {
                        questionIndex: 0,
                        question: "Which approach?",
                        kind: "option",
                        answer: "Append-only session entries",
                    },
                ],
            },
            isError: false,
        });
        expect(
            ledger.getGateBlockers({
                ...submission,
                userChoiceEvidenceId: finalChoiceEvidence.id,
            }),
        ).toEqual([]);
    });

    it("blocks Exploring without ask_user_question provenance for the user choice", () => {
        const ledger = createExplorationLedger({ runId: "brainstorm-test" });
        const claim = ledger.recordClaim({
            assertion: "Choose an append-only ledger.",
            classification: "design-choice",
            critical: false,
            verdict: "unresolved",
            evidenceIds: [],
            contradictoryEvidenceIds: [],
            impact: "Controls persistence architecture.",
            verificationDomain: "local-code",
            architectureImpact: false,
            mitigation: "Document the trade-off.",
        });

        expect(
            ledger.getGateBlockers({
                approachClaimIds: [[claim.id]],
                recommendationClaimIds: [claim.id],
                userChoice: "Append-only ledger",
            }),
        ).toContain("User choice must come from ask_user_question evidence.");
    });

    it("blocks a user choice that does not match the recorded answer", () => {
        const ledger = createExplorationLedger({ runId: "brainstorm-test" });
        const claim = ledger.recordClaim({
            assertion: "Choose an append-only ledger.",
            classification: "design-choice",
            critical: false,
            verdict: "unresolved",
            evidenceIds: [],
            contradictoryEvidenceIds: [],
            impact: "Controls persistence architecture.",
            verificationDomain: "local-code",
            architectureImpact: false,
            mitigation: "Document the trade-off.",
        });
        const answer = ledger.captureEvidence({
            toolCallId: "call-choice",
            toolName: "ask_user_question",
            input: { questions: [{ question: "Which approach?" }] },
            content: [{ type: "text", text: "Answer envelope" }],
            details: {
                cancelled: false,
                answers: [
                    {
                        questionIndex: 0,
                        question: "Which approach?",
                        kind: "option",
                        answer: "Approach A",
                    },
                ],
            },
            isError: false,
        });

        expect(answer.userChoiceQuestionHash).toMatch(/^[a-f0-9]{64}$/);
        expect(answer.userResponseHashes).toEqual([
            expect.stringMatching(/^[a-f0-9]{64}$/),
        ]);
        expect(JSON.stringify(answer)).not.toContain("Approach A");
        const blockers = ledger.getGateBlockers({
            approachClaimIds: [[claim.id]],
            recommendationClaimIds: [claim.id],
            userChoice: "Approach B",
            userChoiceEvidenceId: answer.id,
        });
        const mismatch = blockers.find((blocker) =>
            blocker.startsWith("User choice does not match"),
        );
        expect(mismatch).toBeDefined();
        expect(mismatch).toContain("Stored hash:");
        expect(mismatch).toContain(answer.userResponseHashes![0]);
    });

    it("requires user choice evidence after active claims and required reviews", () => {
        const ledger = createExplorationLedger({ runId: "brainstorm-test" });
        const direct = ledger.captureEvidence({
            toolCallId: "call-source",
            toolName: "read",
            input: { path: "index.ts" },
            content: [{ type: "text", text: "direct result" }],
            details: undefined,
            isError: false,
        });
        const captureChoice = (toolCallId: string) =>
            ledger.captureEvidence({
                toolCallId,
                toolName: "ask_user_question",
                input: { questions: [{ question: "Which approach?" }] },
                content: [{ type: "text", text: "Answer envelope" }],
                details: {
                    cancelled: false,
                    answers: [
                        {
                            questionIndex: 0,
                            question: "Which approach?",
                            kind: "option",
                            answer: "Choose A",
                        },
                    ],
                },
                isError: false,
            });
        const beforeClaim = captureChoice("choice-before-claim");
        const claim = ledger.recordClaim({
            assertion: "The transition gate is centralized.",
            classification: "empirical",
            critical: true,
            verdict: "verified",
            evidenceIds: [direct.id],
            contradictoryEvidenceIds: [],
            impact: "Controls phase transitions.",
            verificationDomain: "local-code",
            architectureImpact: false,
            mitigation: "Keep one transition gate.",
        });
        const submission = (userChoiceEvidenceId: string) => ({
            approachClaimIds: [[claim.id]],
            recommendationClaimIds: [claim.id],
            userChoice: "Choose A",
            userChoiceEvidenceId,
        });

        expect(ledger.getGateBlockers(submission(beforeClaim.id))).toContain(
            "User choice evidence must follow every active claim.",
        );

        const beforeReview = captureChoice("choice-before-review");
        ledger.recordVerificationCompletion({
            verificationRunId: "async-owned",
            verifiers: [
                {
                    agent: "brainstorm-code-scout",
                    outputName: "verify_local_code_supported",
                    outcome: "supported",
                    claimIds: [claim.id],
                    evidenceIds: [direct.id],
                    summary: "The direct source supports the claim.",
                },
            ],
        });

        expect(ledger.getGateBlockers(submission(beforeReview.id))).toContain(
            "User choice evidence must follow required review RV-001.",
        );
        expect(ledger.getStatusSnapshot()).toMatchObject({
            requiredReviewClaimIds: [claim.id],
            satisfiedReviewClaimIds: [claim.id],
            missingSuccessfulReviewClaimIds: [],
            finalChoice: "stale",
        });

        const afterReview = captureChoice("choice-after-review");
        expect(ledger.getGateBlockers(submission(afterReview.id))).toEqual([]);
        expect(ledger.getStatusSnapshot().finalChoice).toBe("recorded");

        ledger.recordVerificationCompletion({
            verificationRunId: "async-newer",
            verifiers: [
                {
                    agent: "brainstorm-code-scout",
                    outputName: "verify_local_code_supported",
                    outcome: "supported",
                    claimIds: [claim.id],
                    evidenceIds: [direct.id],
                    summary: "A newer required review also supports the claim.",
                },
            ],
        });
        expect(ledger.getGateBlockers(submission(afterReview.id))).toContain(
            "User choice evidence must follow required review RV-002.",
        );
        expect(ledger.getStatusSnapshot().finalChoice).toBe("stale");

        const finalChoice = captureChoice("choice-after-latest-review");
        expect(ledger.getGateBlockers(submission(finalChoice.id))).toEqual([]);
        expect(ledger.getStatusSnapshot()).toMatchObject({
            reviews: { total: 2, success: 2 },
            finalChoice: "recorded",
        });
    });

    it("rejects multi-question evidence as final choice provenance", () => {
        const ledger = createExplorationLedger({ runId: "brainstorm-test" });
        const claim = ledger.recordClaim({
            assertion: "Choose an append-only ledger.",
            classification: "design-choice",
            critical: false,
            verdict: "unresolved",
            evidenceIds: [],
            contradictoryEvidenceIds: [],
            impact: "Controls persistence architecture.",
            verificationDomain: "local-code",
            architectureImpact: false,
            mitigation: "Document the trade-off.",
        });
        const answer = ledger.captureEvidence({
            toolCallId: "call-choice",
            toolName: "ask_user_question",
            input: {
                questions: [
                    { question: "Which color?" },
                    { question: "Which approach?" },
                ],
            },
            content: [{ type: "text", text: "Answer envelope" }],
            details: {
                cancelled: false,
                answers: [
                    {
                        questionIndex: 0,
                        question: "Which color?",
                        kind: "option",
                        answer: "Blue",
                    },
                    {
                        questionIndex: 1,
                        question: "Which approach?",
                        kind: "option",
                        answer: "Approach A",
                    },
                ],
            },
            isError: false,
        });

        expect(
            ledger.getGateBlockers({
                approachClaimIds: [[claim.id]],
                recommendationClaimIds: [claim.id],
                userChoice: "Approach A",
                userChoiceEvidenceId: answer.id,
            }),
        ).toContain(
            "User choice evidence must contain exactly one question and answer.",
        );
    });

    it("rejects whitespace-only waiver fields at the ledger boundary", () => {
        const ledger = createExplorationLedger({ runId: "brainstorm-test" });
        const claim = ledger.recordClaim({
            assertion: "Choose an append-only ledger.",
            classification: "design-choice",
            critical: true,
            verdict: "unresolved",
            evidenceIds: [],
            contradictoryEvidenceIds: [],
            impact: "Controls persistence architecture.",
            verificationDomain: "local-code",
            architectureImpact: false,
            mitigation: "Document the trade-off.",
        });
        const valid = {
            claimId: claim.id,
            reason: "Source unavailable.",
            impact: "Recommendation remains uncertain.",
            mitigation: "Re-evaluate before implementation.",
            reevaluateWhen: "Source becomes available.",
        };

        for (const field of [
            "reason",
            "impact",
            "mitigation",
            "reevaluateWhen",
        ] as const) {
            expect(() =>
                ledger.recordWaiver({ ...valid, [field]: "   " }),
            ).toThrow("non-empty");
        }
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

    it("does not let a restored mismatched review outcome satisfy the gate", () => {
        const ledger = createExplorationLedger({ runId: "brainstorm-test" });
        const primary = ledger.captureEvidence({
            toolCallId: "call-primary",
            toolName: "read",
            input: { path: "index.ts" },
            content: [{ type: "text", text: "direct result" }],
            details: undefined,
            isError: false,
        });
        const choiceEvidence = ledger.captureEvidence({
            toolCallId: "call-choice",
            toolName: "ask_user_question",
            input: { questions: [{ question: "Which approach?" }] },
            content: [{ type: "text", text: "Central gate" }],
            details: undefined,
            isError: false,
        });
        const claim = ledger.recordClaim({
            assertion: "The gate is centralized.",
            classification: "empirical",
            critical: true,
            verdict: "verified",
            evidenceIds: [primary.id],
            contradictoryEvidenceIds: [],
            impact: "Controls transitions.",
            verificationDomain: "local-code",
            architectureImpact: false,
            mitigation: "Keep one gate.",
        });
        const mismatchedReview: ReviewRecord = {
            id: "RV-001",
            kind: "review",
            runId: "brainstorm-test",
            phase: "exploring",
            sequence: claim.sequence + 1,
            timestamp: "2026-07-28T12:00:00.000Z",
            reviewerEvidenceId: "EV-999",
            outcome: "rejected",
            claimIds: [claim.id],
            primaryEvidenceIds: [primary.id],
            summary: "Restored mismatched review.",
        };
        const restored = createExplorationLedger({
            runId: "brainstorm-test",
            initialRecords: [...ledger.getRecords(), mismatchedReview],
        });

        expect(
            restored.getGateBlockers({
                approachClaimIds: [[claim.id]],
                recommendationClaimIds: [claim.id],
                userChoice: "Central gate",
                userChoiceEvidenceId: choiceEvidence.id,
            }),
        ).toContain(`${claim.id} requires a fresh completed review.`);
    });

    it("rejects malformed restored IDs instead of producing NaN identifiers", () => {
        const valid = createExplorationLedger({ runId: "brainstorm-test" });
        const evidence = valid.captureEvidence({
            toolCallId: "call-1",
            toolName: "read",
            input: { path: "README.md" },
            content: [{ type: "text", text: "result" }],
            details: undefined,
            isError: false,
        });
        const malformed = { ...evidence, id: "EV-not-a-number" };
        const restored = createExplorationLedger({
            runId: "brainstorm-test",
            initialRecords: [malformed as ExplorationRecord],
        });

        const next = restored.captureEvidence({
            toolCallId: "call-2",
            toolName: "read",
            input: { path: "index.ts" },
            content: [{ type: "text", text: "result" }],
            details: undefined,
            isError: false,
        });

        expect(next.id).toBe("EV-001");
        expect(restored.getRecords()).toEqual([next]);
    });

    it("fails the gate when restored records reference missing ledger records", () => {
        const original = createExplorationLedger({ runId: "brainstorm-test" });
        const evidence = original.captureEvidence({
            toolCallId: "call-source",
            toolName: "read",
            input: { path: "runtime.ts" },
            content: [{ type: "text", text: "source" }],
            details: undefined,
            isError: false,
        });
        const claim = original.recordClaim({
            assertion: "Runtime source exists.",
            classification: "empirical",
            critical: false,
            verdict: "verified",
            evidenceIds: [evidence.id],
            contradictoryEvidenceIds: [],
            impact: "Determines recommendation.",
            verificationDomain: "local-code",
            architectureImpact: false,
            mitigation: "Keep source evidence.",
        });
        const restored = createExplorationLedger({
            runId: "brainstorm-test",
            initialRecords: [
                evidence,
                { ...claim, evidenceIds: ["EV-999"] },
            ] as ExplorationRecord[],
        });

        expect(
            restored.getGateBlockers({
                approachClaimIds: [[claim.id]],
                recommendationClaimIds: [claim.id],
                userChoice: "Choose A",
            }),
        ).toContain(
            `Restored claim ${claim.id} references unknown evidence EV-999.`,
        );
    });

    it("validates restored supersession, reviewer, review, and waiver links", () => {
        const original = createExplorationLedger({ runId: "brainstorm-test" });
        const evidence = original.captureEvidence({
            toolCallId: "call-source",
            toolName: "read",
            input: { path: "runtime.ts" },
            content: [{ type: "text", text: "source" }],
            details: undefined,
            isError: false,
        });
        const claim = original.recordClaim({
            assertion: "Runtime source exists.",
            classification: "empirical",
            critical: false,
            verdict: "verified",
            evidenceIds: [evidence.id],
            contradictoryEvidenceIds: [],
            impact: "Determines recommendation.",
            verificationDomain: "local-code",
            architectureImpact: false,
            mitigation: "Keep source evidence.",
        });
        const restored = createExplorationLedger({
            runId: "brainstorm-test",
            initialRecords: [
                evidence,
                claim,
                {
                    ...claim,
                    id: "CL-002",
                    sequence: 3,
                    supersedesClaimId: "CL-999",
                },
                {
                    ...evidence,
                    id: "EV-002",
                    sequence: 4,
                    toolName: "subagent",
                    sourceKind: "reviewer",
                    reviewer: {
                        agent: "reviewer",
                        context: "fresh",
                        exitCode: 0,
                        outcome: "supported",
                        referencedClaimIds: ["CL-998"],
                        referencedEvidenceIds: ["EV-998"],
                    },
                },
                {
                    id: "RV-001",
                    kind: "review",
                    runId: "brainstorm-test",
                    phase: "exploring",
                    sequence: 5,
                    timestamp: "2026-01-01T00:00:00.000Z",
                    reviewerEvidenceId: "EV-999",
                    outcome: "supported",
                    claimIds: ["CL-997"],
                    primaryEvidenceIds: ["EV-997"],
                    summary: "Invalid restored links.",
                },
                {
                    id: "WV-001",
                    kind: "waiver",
                    runId: "brainstorm-test",
                    phase: "exploring",
                    sequence: 6,
                    timestamp: "2026-01-01T00:00:00.000Z",
                    claimId: "CL-996",
                    reason: "Reason",
                    impact: "Impact",
                    mitigation: "Mitigation",
                    reevaluateWhen: "Condition",
                },
            ] as ExplorationRecord[],
        });

        const blockers = restored.getGateBlockers({
            approachClaimIds: [[claim.id]],
            recommendationClaimIds: [claim.id],
            userChoice: "Choose A",
        });
        expect(blockers).toContain(
            "Restored claim CL-002 supersedes unknown claim CL-999.",
        );
        expect(blockers).toContain(
            "Restored reviewer evidence EV-002 references unknown claim CL-998.",
        );
        expect(blockers).toContain(
            "Restored reviewer evidence EV-002 references unknown evidence EV-998.",
        );
        expect(blockers).toContain(
            "Restored review RV-001 references unknown reviewer evidence EV-999.",
        );
        expect(blockers).toContain(
            "Restored review RV-001 references unknown claim CL-997.",
        );
        expect(blockers).toContain(
            "Restored review RV-001 references unknown primary evidence EV-997.",
        );
        expect(blockers).toContain(
            "Restored waiver WV-001 references unknown claim CL-996.",
        );
    });

    it("reclassifies restored evidence under the current proof policy", () => {
        const original = createExplorationLedger({ runId: "brainstorm-test" });
        const answer = original.captureEvidence({
            toolCallId: "call-choice",
            toolName: "ask_user_question",
            input: { questions: [{ question: "Is this verified?" }] },
            content: [{ type: "text", text: "Yes" }],
            details: {
                cancelled: false,
                answers: [
                    {
                        questionIndex: 0,
                        question: "Is this verified?",
                        kind: "option",
                        answer: "Yes",
                    },
                ],
            },
            isError: false,
        });
        const legacyDirect = { ...answer, sourceKind: "direct" };
        const restored = createExplorationLedger({
            runId: "brainstorm-test",
            initialRecords: [legacyDirect as ExplorationRecord],
        });

        expect(() =>
            restored.recordClaim({
                assertion: "User confirmation proves runtime behavior.",
                classification: "empirical",
                critical: true,
                verdict: "verified",
                evidenceIds: [answer.id],
                contradictoryEvidenceIds: [],
                impact: "Could bypass factual verification.",
                verificationDomain: "local-code",
                architectureImpact: false,
                mitigation: "Reclassify restored evidence.",
            }),
        ).toThrow("successful eligible evidence");

        const legacyClaim: ExplorationRecord = {
            id: "CL-001",
            kind: "claim",
            runId: "brainstorm-test",
            phase: "exploring",
            sequence: 2,
            timestamp: "2026-01-01T00:00:00.000Z",
            assertion: "User confirmation proves runtime behavior.",
            classification: "empirical",
            critical: false,
            verdict: "verified",
            evidenceIds: [answer.id],
            contradictoryEvidenceIds: [],
            impact: "Could bypass factual verification.",
            mitigation: "Revalidate restored claims.",
        };
        const restoredClaim = createExplorationLedger({
            runId: "brainstorm-test",
            initialRecords: [
                legacyDirect as ExplorationRecord,
                legacyClaim,
            ],
        });
        expect(
            restoredClaim.getGateBlockers({
                approachClaimIds: [[legacyClaim.id]],
                recommendationClaimIds: [legacyClaim.id],
                userChoice: "Yes",
                userChoiceEvidenceId: answer.id,
            }),
        ).toContain(
            "Restored claim CL-001 is invalid: verified claims require successful eligible evidence.",
        );
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
            verificationDomain: "local-code",
            architectureImpact: false,
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
            verificationDomain: "local-code",
            architectureImpact: false,
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
                verificationDomain: "local-code",
                architectureImpact: false,
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

    it("hashes malformed URLs, suspicious labels, and response identifiers", () => {
        const ledger = createExplorationLedger({ runId: "brainstorm-test" });

        const evidence = ledger.captureEvidence({
            toolCallId: "call-sensitive",
            toolName: "fetch_content",
            input: {
                url: "not-a-url?token=sk-live-secret",
                source: "Bearer sk-source-secret",
                responseId: "resp_private_identifier",
            },
            content: [{ type: "text", text: "page" }],
            details: undefined,
            isError: false,
        });

        expect(evidence.sourceRefs).toHaveLength(3);
        expect(
            evidence.sourceRefs.every((sourceRef) =>
                /^sha256:[a-f0-9]{12}$/.test(sourceRef),
            ),
        ).toBe(true);
        expect(JSON.stringify(evidence)).not.toMatch(
            /not-a-url|sk-live|Bearer|private_identifier/,
        );
    });

    it("hashes opaque high-entropy source labels", () => {
        const ledger = createExplorationLedger({ runId: "brainstorm-test" });
        const opaque = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6";

        const evidence = ledger.captureEvidence({
            toolCallId: "call-opaque",
            toolName: "fetch_content",
            input: { source: opaque },
            content: [{ type: "text", text: "page" }],
            details: undefined,
            isError: false,
        });

        expect(evidence.sourceRefs).toEqual([
            expect.stringMatching(/^sha256:[a-f0-9]{12}$/),
        ]);
        expect(JSON.stringify(evidence)).not.toContain(opaque);
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
            verificationDomain: "local-code",
            architectureImpact: false,
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
            verificationDomain: "local-code",
            architectureImpact: false,
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
            userChoiceEvidenceId: evidence.id,
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
        expect(markdown).toContain("Choice evidence: EV-001");
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
                verificationDomain: "local-code",
                architectureImpact: false,
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
                verificationDomain: "local-code",
                architectureImpact: false,
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

    it("persists verificationDomain and architectureImpact on new claims", () => {
        const ledger = createExplorationLedger({ runId: "brainstorm-test" });
        const evidence = ledger.captureEvidence({
            toolCallId: "call-1",
            toolName: "read",
            input: { path: "runtime.ts" },
            content: [{ type: "text", text: "source" }],
            details: undefined,
            isError: false,
        });

        const claim = ledger.recordClaim({
            assertion: "Runtime source exists.",
            classification: "empirical",
            critical: false,
            verdict: "verified",
            evidenceIds: [evidence.id],
            contradictoryEvidenceIds: [],
            impact: "Determines recommendation.",
            mitigation: "Keep source evidence.",
            verificationDomain: "local-code",
            architectureImpact: false,
        });

        expect(claim.verificationDomain).toBe("local-code");
        expect(claim.architectureImpact).toBe(false);
        expect(ledger.getActiveClaims()[0]).toMatchObject({
            verificationDomain: "local-code",
            architectureImpact: false,
        });
    });

    it("blocks the gate for legacy claims missing routing metadata until superseded", () => {
        const original = createExplorationLedger({ runId: "brainstorm-test" });
        const evidence = original.captureEvidence({
            toolCallId: "call-source",
            toolName: "read",
            input: { path: "runtime.ts" },
            content: [{ type: "text", text: "source" }],
            details: undefined,
            isError: false,
        });
        const legacyClaim: ExplorationRecord = {
            id: "CL-001",
            kind: "claim",
            runId: "brainstorm-test",
            phase: "exploring",
            sequence: 2,
            timestamp: "2026-01-01T00:00:00.000Z",
            assertion: "Runtime source exists.",
            classification: "empirical",
            critical: false,
            verdict: "verified",
            evidenceIds: [evidence.id],
            contradictoryEvidenceIds: [],
            impact: "Determines recommendation.",
            mitigation: "Keep source evidence.",
        };
        const restored = createExplorationLedger({
            runId: "brainstorm-test",
            initialRecords: [evidence, legacyClaim],
        });

        expect(
            restored.getGateBlockers({
                approachClaimIds: [["CL-001"]],
                recommendationClaimIds: ["CL-001"],
                userChoice: "Choose A",
            }),
        ).toContain(
            "Restored claim CL-001 lacks routing metadata and must be superseded before verification.",
        );
        expect(
            restored.getStatusSnapshot().routingMetadataRequiredClaimIds,
        ).toEqual(["CL-001"]);

        const superseded = createExplorationLedger({
            runId: "brainstorm-test",
            initialRecords: [
                evidence,
                legacyClaim,
                {
                    ...legacyClaim,
                    id: "CL-002",
                    sequence: 3,
                    timestamp: "2026-01-02T00:00:00.000Z",
                    supersedesClaimId: "CL-001",
                    verificationDomain: "local-code",
                    architectureImpact: false,
                },
            ],
        });
        expect(
            superseded.getGateBlockers({
                approachClaimIds: [["CL-002"]],
                recommendationClaimIds: ["CL-002"],
                userChoice: "Choose A",
            }),
        ).not.toContain(
            "Restored claim CL-001 lacks routing metadata and must be superseded before verification.",
        );
        expect(
            superseded.getStatusSnapshot().routingMetadataRequiredClaimIds,
        ).toEqual([]);
    });

    it("removes routing metadata blocker from gate after runtime supersession via recordClaim", () => {
        const original = createExplorationLedger({ runId: "brainstorm-test" });
        const evidence = original.captureEvidence({
            toolCallId: "call-source",
            toolName: "read",
            input: { path: "runtime.ts" },
            content: [{ type: "text", text: "source" }],
            details: undefined,
            isError: false,
        });
        const legacyClaim: ExplorationRecord = {
            id: "CL-001",
            kind: "claim",
            runId: "brainstorm-test",
            phase: "exploring",
            sequence: 2,
            timestamp: "2026-01-01T00:00:00.000Z",
            assertion: "Runtime source exists.",
            classification: "empirical",
            critical: false,
            verdict: "verified",
            evidenceIds: [evidence.id],
            contradictoryEvidenceIds: [],
            impact: "Determines recommendation.",
            mitigation: "Keep source evidence.",
        };
        const ledger = createExplorationLedger({
            runId: "brainstorm-test",
            initialRecords: [evidence, legacyClaim],
        });
        expect(
            ledger.getGateBlockers({
                approachClaimIds: [["CL-001"]],
                recommendationClaimIds: ["CL-001"],
                userChoice: "Choose A",
            }),
        ).toContain(
            "Restored claim CL-001 lacks routing metadata and must be superseded before verification.",
        );

        ledger.recordClaim({
            assertion: "Superseding claim with full metadata.",
            classification: "design-choice",
            critical: false,
            verdict: "unresolved",
            evidenceIds: [evidence.id],
            contradictoryEvidenceIds: [],
            impact: "Replaces legacy claim.",
            mitigation: "None.",
            verificationDomain: "local-code",
            architectureImpact: false,
            supersedesClaimId: "CL-001",
        });

        expect(
            ledger.getGateBlockers({
                approachClaimIds: [["CL-002"]],
                recommendationClaimIds: ["CL-002"],
                userChoice: "Choose A",
            }),
        ).not.toContain(
            "Restored claim CL-001 lacks routing metadata and must be superseded before verification.",
        );
        expect(
            ledger.getStatusSnapshot().routingMetadataRequiredClaimIds,
        ).toEqual([]);
    });

    it("drops restored claims with malformed routing metadata (fail closed)", () => {
        const original = createExplorationLedger({ runId: "brainstorm-test" });
        const evidence = original.captureEvidence({
            toolCallId: "call-source",
            toolName: "read",
            input: { path: "runtime.ts" },
            content: [{ type: "text", text: "source" }],
            details: undefined,
            isError: false,
        });
        const base = {
            id: "CL-001",
            kind: "claim",
            runId: "brainstorm-test",
            phase: "exploring",
            sequence: 2,
            timestamp: "2026-01-01T00:00:00.000Z",
            assertion: "Runtime source exists.",
            classification: "empirical",
            critical: false,
            verdict: "verified",
            evidenceIds: [evidence.id],
            contradictoryEvidenceIds: [],
            impact: "Determines recommendation.",
            mitigation: "Keep source evidence.",
        } as const;
        const malformedDomain = {
            ...base,
            verificationDomain: "bogus",
            architectureImpact: false,
        };
        const malformedImpact = {
            ...base,
            verificationDomain: "local-code",
            architectureImpact: "yes",
        };

        for (const malformed of [malformedDomain, malformedImpact]) {
            const restored = createExplorationLedger({
                runId: "brainstorm-test",
                initialRecords: [evidence, malformed as ExplorationRecord],
            });
            expect(
                restored.getActiveClaims().map((claim) => claim.id),
            ).toEqual([]);
        }
    });

    it("appends secondary verifier evidence and an RV audit from structured output", () => {
        const ledger = createExplorationLedger({
            runId: "brainstorm-test",
            now: () => "2026-07-29T12:00:00.000Z",
            homeDir: "/home/test",
        });
        const direct = ledger.captureEvidence({
            toolCallId: "call-source",
            toolName: "read",
            input: { path: "/home/test/runtime.ts" },
            content: [{ type: "text", text: "source" }],
            details: undefined,
            isError: false,
        });
        const claim = ledger.recordClaim({
            assertion: "Runtime source exists.",
            classification: "empirical",
            critical: true,
            verdict: "verified",
            evidenceIds: [direct.id],
            contradictoryEvidenceIds: [],
            impact: "Determines recommendation.",
            mitigation: "Keep source evidence.",
            verificationDomain: "local-code",
            architectureImpact: false,
        });

        const completion = ledger.recordVerificationCompletion({
            verificationRunId: "async-owned",
            verifiers: [
                {
                    agent: "brainstorm-code-scout",
                    outputName: "verify_local_code_supported",
                    outcome: "supported",
                    claimIds: [claim.id],
                    evidenceIds: [direct.id],
                    summary: "The direct source supports the claim.",
                },
            ],
        });

        expect(completion).toMatchObject({
            architectEvidence: undefined,
            verifierEvidence: [
                {
                    id: "EV-002",
                    sourceKind: "secondary",
                    sourceRefs: ["~/runtime.ts"],
                    verifier: {
                        role: "verifier",
                        agent: "brainstorm-code-scout",
                        context: "fresh",
                        exitCode: 0,
                        verificationRunId: "async-owned",
                        outputName: "verify_local_code_supported",
                        outcome: "supported",
                        referencedClaimIds: [claim.id],
                        referencedEvidenceIds: [direct.id],
                    },
                },
            ],
            reviews: [
                {
                    id: "RV-001",
                    verifierEvidenceId: "EV-002",
                    outcome: "supported",
                    claimIds: [claim.id],
                    primaryEvidenceIds: [direct.id],
                    audit: {
                        status: "success",
                        verificationRunId: "async-owned",
                        agent: "brainstorm-code-scout",
                        outputName: "verify_local_code_supported",
                    },
                },
            ],
        });
        expect(
            ledger.getGateBlockers({
                approachClaimIds: [[claim.id]],
                recommendationClaimIds: [claim.id],
                userChoice: "Choose A",
            }),
        ).not.toContain(`${claim.id} requires a fresh completed review.`);
    });

    it("stores architect clear/watch/block data in RV audit and keeps block gated", () => {
        const ledger = createExplorationLedger({ runId: "brainstorm-test" });
        const direct = ledger.captureEvidence({
            toolCallId: "call-source",
            toolName: "read",
            input: { path: "runtime.ts" },
            content: [{ type: "text", text: "source" }],
            details: undefined,
            isError: false,
        });
        const claim = ledger.recordClaim({
            assertion: "Runtime source exists.",
            classification: "empirical",
            critical: true,
            verdict: "verified",
            evidenceIds: [direct.id],
            contradictoryEvidenceIds: [],
            impact: "Changes the extension boundary.",
            mitigation: "Keep the boundary explicit.",
            verificationDomain: "local-code",
            architectureImpact: true,
        });

        const completion = ledger.recordVerificationCompletion({
            verificationRunId: "async-architecture",
            architect: {
                agent: "architect",
                outputName: "architecture_review",
                status: "block",
                claimIds: [claim.id],
                evidenceIds: [direct.id],
                risks: ["The boundary is cyclic."],
                summary: "Resolve the cycle before proceeding.",
            },
            verifiers: [
                {
                    agent: "brainstorm-code-scout",
                    outputName: "verify_local_code_supported",
                    outcome: "supported",
                    claimIds: [claim.id],
                    evidenceIds: [direct.id],
                    summary: "The source supports the claim.",
                },
            ],
        });

        expect(completion.architectEvidence).toMatchObject({
            id: "EV-002",
            sourceKind: "secondary",
            verifier: {
                role: "architect",
                agent: "architect",
                architecturalStatus: "block",
            },
        });
        expect(completion.reviews[0]).toMatchObject({
            id: "RV-001",
            verifierEvidenceId: "EV-003",
            audit: {
                architect: {
                    evidenceId: "EV-002",
                    status: "block",
                    claimIds: [claim.id],
                    evidenceIds: [direct.id],
                    risks: ["The boundary is cyclic."],
                    summary: "Resolve the cycle before proceeding.",
                },
            },
        });
        const architectAudit = completion.reviews[0].audit.architect!;
        const malformedRestoredReview = {
            ...completion.reviews[0],
            audit: {
                ...completion.reviews[0].audit,
                architect: {
                    evidenceId: architectAudit.evidenceId,
                    status: architectAudit.status,
                    evidenceIds: architectAudit.evidenceIds,
                    risks: architectAudit.risks,
                    summary: architectAudit.summary,
                },
            },
        };
        expect(isExplorationRecord(malformedRestoredReview)).toBe(false);
        expect(
            ledger.renderExplorationMarkdown({
                approaches: [],
                recommendation: "Keep the boundary explicit.",
                recommendationClaimIds: [claim.id],
                userChoice: "Choose A",
            }),
        ).toContain(
            `architect block claims: ${claim.id}; evidence: ${direct.id}`,
        );
        expect(
            ledger.getGateBlockers({
                approachClaimIds: [[claim.id]],
                recommendationClaimIds: [claim.id],
                userChoice: "Choose A",
            }),
        ).toContain(`${claim.id} is blocked by architecture verification.`);
    });

    it("scopes architect block to architecture-impacting claims in a mixed verifier group", () => {
        const ledger = createExplorationLedger({ runId: "brainstorm-mixed" });
        const direct = ledger.captureEvidence({
            toolCallId: "call-source",
            toolName: "read",
            input: { path: "runtime.ts" },
            content: [{ type: "text", text: "source" }],
            details: undefined,
            isError: false,
        });
        const architectureClaim = ledger.recordClaim({
            assertion: "The dependency boundary is safe.",
            classification: "empirical",
            critical: false,
            verdict: "verified",
            evidenceIds: [direct.id],
            contradictoryEvidenceIds: [],
            impact: "Changes the dependency graph.",
            mitigation: "Keep the graph acyclic.",
            verificationDomain: "local-code",
            architectureImpact: true,
        });
        const ordinaryClaim = ledger.recordClaim({
            assertion: "The helper returns the expected value.",
            classification: "empirical",
            critical: true,
            verdict: "verified",
            evidenceIds: [direct.id],
            contradictoryEvidenceIds: [],
            impact: "Controls the local result.",
            mitigation: "Keep the regression test.",
            verificationDomain: "local-code",
            architectureImpact: false,
        });

        const completion = ledger.recordVerificationCompletion({
            verificationRunId: "async-mixed",
            architect: {
                agent: "architect",
                outputName: "architecture_review",
                status: "block",
                claimIds: [architectureClaim.id],
                evidenceIds: [direct.id],
                risks: ["The dependency graph contains a cycle."],
                summary: "Remove the cycle before proceeding.",
            },
            verifiers: [
                {
                    agent: "brainstorm-code-scout",
                    outputName: "verify_local_code_supported",
                    outcome: "supported",
                    claimIds: [architectureClaim.id, ordinaryClaim.id],
                    evidenceIds: [direct.id],
                    summary: "Both claims match the direct source.",
                },
            ],
        });

        expect(completion.reviews[0].audit.architect).toMatchObject({
            claimIds: [architectureClaim.id],
            evidenceIds: [direct.id],
        });
        const blockers = ledger.getGateBlockers({
            approachClaimIds: [[architectureClaim.id, ordinaryClaim.id]],
            recommendationClaimIds: [architectureClaim.id, ordinaryClaim.id],
            userChoice: "Choose A",
        });
        expect(blockers).toContain(
            `${architectureClaim.id} is blocked by architecture verification.`,
        );
        expect(blockers).not.toContain(
            `${ordinaryClaim.id} is blocked by architecture verification.`,
        );
        expect(blockers).not.toContain(
            `${ordinaryClaim.id} requires a fresh completed review.`,
        );
    });

    it("scopes architect advisory failures per verifier review and restores them", () => {
        const ledger = createExplorationLedger({ runId: "brainstorm-advisory" });
        const claims = [
            { domain: "pi" as const, architectureImpact: true },
            { domain: "local-code" as const, architectureImpact: true },
            { domain: "external" as const, architectureImpact: false },
        ].map((config, index) => {
            const evidence = ledger.captureEvidence({
                toolCallId: `call-${index + 1}`,
                toolName: "read",
                input: { path: `source-${index + 1}.ts` },
                content: [{ type: "text", text: "source" }],
                details: undefined,
                isError: false,
            });
            const claim = ledger.recordClaim({
                assertion: `Claim ${index + 1} is supported.`,
                classification: "empirical",
                critical: true,
                verdict: "verified",
                evidenceIds: [evidence.id],
                contradictoryEvidenceIds: [],
                impact: `Impact ${index + 1}.`,
                mitigation: `Mitigation ${index + 1}.`,
                verificationDomain: config.domain,
                architectureImpact: config.architectureImpact,
            });
            return { claim, evidence };
        });

        const completion = ledger.recordVerificationCompletion({
            verificationRunId: "async-advisory-failure",
            advisoryFailure: {
                claimIds: [claims[0]!.claim.id, claims[1]!.claim.id],
                evidenceIds: [
                    claims[0]!.evidence.id,
                    claims[1]!.evidence.id,
                ],
                reason: "Step failed: architect",
            },
            verifiers: [
                {
                    agent: "pi-expert",
                    outputName: "verify_pi_supported",
                    outcome: "supported",
                    claimIds: [claims[0]!.claim.id],
                    evidenceIds: [claims[0]!.evidence.id],
                    summary: "Pi claim supported.",
                },
                {
                    agent: "brainstorm-code-scout",
                    outputName: "verify_local_code_supported",
                    outcome: "supported",
                    claimIds: [claims[1]!.claim.id],
                    evidenceIds: [claims[1]!.evidence.id],
                    summary: "Local claim supported.",
                },
                {
                    agent: "factual-researcher",
                    outputName: "verify_external_supported",
                    outcome: "supported",
                    claimIds: [claims[2]!.claim.id],
                    evidenceIds: [claims[2]!.evidence.id],
                    summary: "External claim supported.",
                },
            ],
        });

        expect(completion.reviews[0]!.audit.advisoryFailure).toEqual({
            claimIds: [claims[0]!.claim.id],
            evidenceIds: [claims[0]!.evidence.id],
            reason: "Step failed: architect",
        });
        expect(completion.reviews[1]!.audit.advisoryFailure).toEqual({
            claimIds: [claims[1]!.claim.id],
            evidenceIds: [claims[1]!.evidence.id],
            reason: "Step failed: architect",
        });
        expect(completion.reviews[2]!.audit.advisoryFailure).toBeUndefined();

        const restored = createExplorationLedger({
            runId: "brainstorm-advisory",
            initialRecords: ledger.getRecords(),
        });
        const blockers = restored.getGateBlockers({
            approachClaimIds: [claims.map(({ claim }) => claim.id)],
            recommendationClaimIds: claims.map(({ claim }) => claim.id),
            userChoice: "Choose A",
        });
        expect(blockers).not.toContainEqual(
            expect.stringContaining("inconsistent architect advisory failure"),
        );
        expect(restored.getStatusSnapshot().reviews).toMatchObject({
            success: 3,
            failed: 0,
        });
    });

    it("audits failed, malformed, and timed-out runs as RV records that cannot close the gate", () => {
        for (const failureKind of [
            "failed",
            "malformed",
            "timeout",
        ] as const) {
            const ledger = createExplorationLedger({
                runId: `brainstorm-${failureKind}`,
            });
            const direct = ledger.captureEvidence({
                toolCallId: "call-source",
                toolName: "read",
                input: { path: "runtime.ts" },
                content: [{ type: "text", text: "source" }],
                details: undefined,
                isError: false,
            });
            const claim = ledger.recordClaim({
                assertion: "Runtime source exists.",
                classification: "empirical",
                critical: true,
                verdict: "verified",
                evidenceIds: [direct.id],
                contradictoryEvidenceIds: [],
                impact: "Determines recommendation.",
                mitigation: "Keep source evidence.",
                verificationDomain: "local-code",
                architectureImpact: false,
            });

            const reviews = ledger.recordVerificationFailure({
                verificationRunId: `async-${failureKind}`,
                failureKind,
                reason: `Terminal ${failureKind}.`,
                groups: [
                    {
                        agent: "brainstorm-code-scout",
                        outputName: "verify_local_code_supported",
                        claimIds: [claim.id],
                        evidenceIds: [direct.id],
                    },
                ],
            });

            expect(reviews[0]).toMatchObject({
                id: "RV-001",
                claimIds: [claim.id],
                primaryEvidenceIds: [direct.id],
                audit: {
                    status: failureKind,
                    verificationRunId: `async-${failureKind}`,
                    reason: `Terminal ${failureKind}.`,
                },
            });
            expect(reviews[0]).not.toHaveProperty("verifierEvidenceId");
            expect(
                ledger.getGateBlockers({
                    approachClaimIds: [[claim.id]],
                    recommendationClaimIds: [claim.id],
                    userChoice: "Choose A",
                }),
            ).toContain(`${claim.id} requires a fresh completed review.`);
        }
    });

    it("reports malformed reviews as missing successful review work", () => {
        const ledger = createExplorationLedger({ runId: "brainstorm-status" });
        const direct = ledger.captureEvidence({
            toolCallId: "call-source",
            toolName: "read",
            input: { path: "runtime.ts" },
            content: [{ type: "text", text: "source" }],
            details: undefined,
            isError: false,
        });
        const claim = ledger.recordClaim({
            assertion: "Runtime source exists.",
            classification: "empirical",
            critical: true,
            verdict: "verified",
            evidenceIds: [direct.id],
            contradictoryEvidenceIds: [],
            impact: "Determines recommendation.",
            mitigation: "Keep source evidence.",
            verificationDomain: "local-code",
            architectureImpact: false,
        });
        ledger.recordVerificationFailure({
            verificationRunId: "async-malformed",
            failureKind: "malformed",
            reason: "Owner mismatch.",
            groups: [
                {
                    agent: "brainstorm-code-scout",
                    outputName: "verify_local_code_supported",
                    claimIds: [claim.id],
                    evidenceIds: [direct.id],
                },
            ],
        });

        expect(ledger.getStatusSnapshot()).toEqual({
            evidenceTotal: 1,
            claims: { historical: 1, active: 1 },
            reviews: {
                total: 1,
                success: 0,
                failed: 0,
                malformed: 1,
                timeout: 0,
            },
            unresolvedCriticalClaimIds: [],
            routingMetadataRequiredClaimIds: [],
            requiredReviewClaimIds: [claim.id],
            satisfiedReviewClaimIds: [],
            missingSuccessfulReviewClaimIds: [claim.id],
            architectureBlockedClaimIds: [],
            waiverRequiredClaimIds: [],
            finalChoice: "blockedByReviews",
        });
    });

    it("does not count an invalid restored legacy review as successful", () => {
        const original = createExplorationLedger({ runId: "brainstorm-legacy" });
        const primary = original.captureEvidence({
            toolCallId: "call-primary",
            toolName: "read",
            input: { path: "runtime.ts" },
            content: [{ type: "text", text: "source" }],
            details: undefined,
            isError: false,
        });
        const claim = original.recordClaim({
            assertion: "Runtime source exists.",
            classification: "empirical",
            critical: true,
            verdict: "verified",
            evidenceIds: [primary.id],
            contradictoryEvidenceIds: [],
            impact: "Determines recommendation.",
            mitigation: "Keep source evidence.",
            verificationDomain: "local-code",
            architectureImpact: false,
        });
        const reviewer = original.captureEvidence({
            toolCallId: "call-reviewer",
            toolName: "subagent",
            input: reviewerChainInput("Review the runtime claim."),
            content: [{ type: "text", text: "review envelope" }],
            details: {
                results: [
                    {
                        agent: "reviewer",
                        context: "fresh",
                        exitCode: 0,
                        structuredOutput: {
                            outcome: "supported",
                            claimIds: [claim.id],
                            evidenceIds: [primary.id],
                        },
                    },
                ],
            },
            isError: false,
        });
        original.recordReview({
            reviewerEvidenceId: reviewer.id,
            claimIds: [claim.id],
            primaryEvidenceIds: [primary.id],
            summary: "Legacy review supports the claim.",
        });
        const corrupted = original.getRecords().map((record) =>
            record.kind === "review" && "reviewerEvidenceId" in record
                ? { ...record, reviewerEvidenceId: "EV-999" }
                : record,
        ) as ExplorationRecord[];

        const restored = createExplorationLedger({
            runId: "brainstorm-legacy",
            initialRecords: corrupted,
        });

        expect(restored.getStatusSnapshot().reviews).toEqual({
            total: 1,
            success: 0,
            failed: 0,
            malformed: 1,
            timeout: 0,
        });
        expect(
            restored.getStatusSnapshot().missingSuccessfulReviewClaimIds,
        ).toEqual([claim.id]);

        const validRecords = original.getRecords();
        const reviewSequence = validRecords.find(
            (record) => record.kind === "review",
        )!.sequence;
        const nonPriorReviewer = validRecords.map((record) =>
            record.kind === "evidence" && record.id === reviewer.id
                ? { ...record, sequence: reviewSequence + 1 }
                : record,
        ) as ExplorationRecord[];
        const restoredNonPrior = createExplorationLedger({
            runId: "brainstorm-legacy",
            initialRecords: nonPriorReviewer,
        });
        expect(restoredNonPrior.getStatusSnapshot().reviews).toMatchObject({
            total: 1,
            success: 0,
            malformed: 1,
        });
        expect(restoredNonPrior.getGateBlockers({
            approachClaimIds: [[claim.id]],
            recommendationClaimIds: [claim.id],
            userChoice: "Choose A",
        })).toContain(
            `Restored review RV-001 references non-prior reviewer evidence ${reviewer.id}.`,
        );
    });

    it("audits a pending run even when its selected claim was superseded before completion", () => {
        const ledger = createExplorationLedger({ runId: "brainstorm-test" });
        const direct = ledger.captureEvidence({
            toolCallId: "call-source",
            toolName: "read",
            input: { path: "runtime.ts" },
            content: [{ type: "text", text: "source" }],
            details: undefined,
            isError: false,
        });
        const original = ledger.recordClaim({
            assertion: "Runtime source exists.",
            classification: "empirical",
            critical: true,
            verdict: "verified",
            evidenceIds: [direct.id],
            contradictoryEvidenceIds: [],
            impact: "Determines recommendation.",
            mitigation: "Keep source evidence.",
            verificationDomain: "local-code",
            architectureImpact: false,
        });
        ledger.recordClaim({
            assertion: "Runtime source exists with a narrower scope.",
            classification: "empirical",
            critical: true,
            verdict: "verified",
            evidenceIds: [direct.id],
            contradictoryEvidenceIds: [],
            impact: "Determines recommendation.",
            mitigation: "Keep source evidence.",
            verificationDomain: "local-code",
            architectureImpact: false,
            supersedesClaimId: original.id,
        });

        expect(
            ledger.recordVerificationFailure({
                verificationRunId: "async-stale-scope",
                failureKind: "malformed",
                reason: "Claim scope changed while verification was pending.",
                groups: [
                    {
                        agent: "brainstorm-code-scout",
                        outputName: "verify_local_code_supported",
                        claimIds: [original.id],
                        evidenceIds: [direct.id],
                    },
                ],
            }),
        ).toMatchObject([
            {
                id: "RV-001",
                claimIds: [original.id],
                audit: { status: "malformed" },
            },
        ]);
    });
});
