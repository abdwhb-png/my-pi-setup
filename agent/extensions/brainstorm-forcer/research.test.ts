import { describe, expect, it } from "bun:test";
import {
    buildResearchDelegation,
    validateResearchResult,
} from "./research";

describe("brainstorm research routing", () => {
    it("routes only local code and external research to dedicated agents", () => {
        expect(
            buildResearchDelegation({
                domain: "local-code",
                question: "Where is the artifact root selected?",
                sources: ["agent/extensions/brainstorm-forcer/index.ts"],
            }),
        ).toMatchObject({ agent: "brainstorm-scout", context: "fresh" });
        expect(
            buildResearchDelegation({
                domain: "external",
                question: "What does the current API guarantee?",
                sources: ["https://pi.dev/docs"],
            }),
        ).toMatchObject({ agent: "factual-researcher", context: "fresh" });
        expect(() =>
            buildResearchDelegation({
                domain: "researcher" as never,
                question: "Invalid route",
                sources: [],
            }),
        ).toThrow("Unsupported brainstorm research domain");
    });

    it("accepts bounded source-backed results and rejects prose-only output", () => {
        expect(
            validateResearchResult({
                summary: "Artifact store creation fixes the root.",
                findings: [
                    {
                        finding: "getArtifactStore receives topic.raw.",
                        sourceRefs: [
                            "agent/extensions/brainstorm-forcer/index.ts:1440",
                        ],
                    },
                ],
                gaps: [],
            }),
        ).toEqual({ ok: true, blockers: [] });
        expect(
            validateResearchResult({
                summary: "Unsupported.",
                findings: [{ finding: "No source.", sourceRefs: [] }],
                gaps: [],
            }),
        ).toEqual({
            ok: false,
            blockers: ["Each research finding requires at least one source reference."],
        });
        expect(
            validateResearchResult({
                summary: "Unexpected shape.",
                findings: [
                    {
                        finding: "Has source.",
                        sourceRefs: ["index.ts:1"],
                        confidence: "high",
                    },
                ],
                gaps: [],
                extra: true,
            }),
        ).toEqual({
            ok: false,
            blockers: [
                "Research result contains unsupported fields.",
                "Research finding contains unsupported fields.",
            ],
        });
    });
});
