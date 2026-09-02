import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
    ARCHITECT_AGENT,
    ARCHITECT_OUTPUT_SCHEMA,
    READONLY_VERIFIER_TOOLS,
    VERIFICATION_DOMAINS,
    VERIFICATION_OUTCOMES,
    VERIFICATION_ROUTING,
    VERIFIER_AGENT_ALLOWLIST,
    VERIFIER_OUTPUT_SCHEMA,
    buildVerificationPlan,
    buildVerifierCapabilityCeiling,
    groupVerificationClaims,
    verifyArchitectCompletion,
    verifyVerifierCompletion,
    type EvidenceDescriptor,
    type VerificationClaim,
    type VerificationDomain,
    type VerificationOutcome,
} from "./verification";

function ev(id: string, ...sourceRefs: string[]): EvidenceDescriptor {
    return { id, sourceRefs };
}

function claim(
    id: string,
    domain: VerificationDomain,
    outcome: VerificationOutcome,
    evidence: EvidenceDescriptor[] = [],
    assertion = `Assertion ${id}`,
): VerificationClaim {
    return { id, assertion, domain, expectedOutcome: outcome, evidence };
}

describe("verification routing", () => {
    it("covers every domain with the exact read-only agent allowlist", () => {
        expect([...VERIFICATION_DOMAINS]).toEqual([
            "pi",
            "local-code",
            "external",
            "performance",
        ]);
        expect(VERIFICATION_ROUTING).toEqual({
            pi: "pi-expert",
            "local-code": "brainstorm-scout",
            external: "factual-researcher",
            performance: "performance-reviewer",
        });
        expect([...VERIFIER_AGENT_ALLOWLIST]).toEqual([
            "pi-expert",
            "brainstorm-scout",
            "factual-researcher",
            "performance-reviewer",
        ]);
    });

    it("keeps the capability ceiling read-only while provider extensions remain loadable", () => {
        const ceiling = buildVerifierCapabilityCeiling();
        expect(ceiling).toEqual({
            allowedTools: [...READONLY_VERIFIER_TOOLS],
            denyExtensions: false,
        });
        for (const tool of ["write", "edit", "bash", "safe_bash", "subagent"])
            expect(ceiling.allowedTools).not.toContain(tool);
    });

    it("includes think_search in the read-only allowlist (no think execute tools)", () => {
        // Task 7 contract: read-only verifier tools may inspect the Think-in-
        // Code FTS5 index via `think_search` (no filesystem, no execution),
        // but they must NEVER receive the three execute tools. Adding
        // `think_execute`/`think_execute_file`/`think_batch_execute` to the
        // allowlist would silently widen the capability ceiling and let
        // verifiers mutate project state through the analyzer broker.
        expect(READONLY_VERIFIER_TOOLS).toContain("think_search");
        for (const tool of [
            "think_execute",
            "think_execute_file",
            "think_batch_execute",
            "think_index",
        ]) {
            expect(READONLY_VERIFIER_TOOLS).not.toContain(tool);
        }
        // Sanity: ctx_search parity still holds alongside think_search.
        expect(READONLY_VERIFIER_TOOLS).toContain("ctx_search");
    });

    it("keeps the documented local-code route aligned with the closed routing contract", async () => {
        const [readme, skill, adr] = await Promise.all([
            readFile(join(import.meta.dir, "README.md"), "utf8"),
            readFile(join(import.meta.dir, "skills", "brainstorm-forcer", "SKILL.md"), "utf8"),
            readFile(
                join(
                    import.meta.dir,
                    "..",
                    "..",
                    "..",
                    "docs",
                    "adr",
                    "ADR-008-domain-routed-asynchronous-brainstorm-verification.md",
                ),
                "utf8",
            ),
        ]);
        for (const document of [readme, skill]) {
            expect(document).toMatch(/\|\s*`local-code`\s*\|\s*`brainstorm-scout`\s*\|/);
            expect(document).not.toMatch(/\|\s*`local-code`\s*\|\s*`scout`\s*\|/);
        }
        const [beforeHistorical, historicalAndAfter = ""] = adr.split(
            "### Historical protocol note",
            2,
        );
        const [, afterHistorical = ""] = historicalAndAfter.split(
            "### Structured result and ledger policy",
            2,
        );
        const activeSections = `${beforeHistorical}\n${afterHistorical}`;
        expect(activeSections).toContain("pi-subagents/delegation");
        expect(activeSections).toContain("external-runs");
        expect(activeSections).toContain("brainstorm-scout");
        expect(activeSections).not.toMatch(/\bRPC\b|package lifecycle artifacts/i);
        expect(historicalAndAfter).toMatch(/removed RPC v1[\s\S]*lifecycle artifacts/i);
    });
});

describe("verification plan", () => {
    it("groups deterministically and merges evidence references", () => {
        const input = [
            claim("CL-002", "external", "supported", [
                ev("EV-001", "README.md"),
            ]),
            claim("CL-001", "external", "supported", [
                ev("EV-001", "index.ts"),
                ev("EV-002", "docs.md"),
            ]),
        ];
        const groups = groupVerificationClaims(input);
        expect(groups).toHaveLength(1);
        expect(groups[0]).toMatchObject({
            agent: "factual-researcher",
            claimIds: ["CL-001", "CL-002"],
            evidenceIds: ["EV-001", "EV-002"],
        });
        expect(groups[0]!.evidence[0]).toEqual({
            id: "EV-001",
            sourceRefs: ["README.md", "index.ts"],
        });
        expect(groupVerificationClaims([...input].reverse())).toEqual(groups);
    });

    it("builds public-delegation nodes without legacy orchestration fields", () => {
        const { nodes } = buildVerificationPlan({
            runId: "run-1",
            claims: [
                claim("CL-001", "local-code", "supported", [
                    ev("EV-001", "src/gate.ts"),
                ]),
            ],
            architectureImpact: true,
            architectureScope: {
                claimIds: ["CL-001"],
                evidenceIds: ["EV-001"],
            },
        });

        expect(nodes).toHaveLength(2);
        expect(nodes[0]).toMatchObject({
            role: "verifier",
            agent: "brainstorm-scout",
            outputName: "verify_local_code_supported",
            schema: VERIFIER_OUTPUT_SCHEMA,
        });
        expect(nodes[0]!.task).toContain("CL-001");
        expect(nodes[0]!.task).toContain("EV-001: src/gate.ts");
        expect(nodes[1]).toMatchObject({
            role: "architect",
            agent: ARCHITECT_AGENT,
            outputName: "architect_advisory",
            schema: ARCHITECT_OUTPUT_SCHEMA,
        });
        expect(nodes[1]!.task).toContain(
            "{outputs.verify_local_code_supported}",
        );
        const serialized = JSON.stringify(nodes);
        for (const legacy of ["\"chain\"", "\"tasks\"", "\"parallel\"", "\"acceptance\""])
            expect(serialized).not.toContain(legacy);
    });

    it("omits the architect node for ordinary claims and is order-stable", () => {
        const claims = [
            claim("CL-001", "pi", "supported"),
            claim("CL-002", "external", "rejected"),
        ];
        const direct = buildVerificationPlan({ runId: "run", claims });
        const reversed = buildVerificationPlan({
            runId: "run",
            claims: [...claims].reverse(),
        });
        expect(direct).toEqual(reversed);
        expect(direct.nodes.every((node) => node.role === "verifier")).toBe(
            true,
        );
    });
});

describe("structured completion validation", () => {
    const group = groupVerificationClaims([
        claim("CL-001", "local-code", "supported", [ev("EV-001", "x.ts")]),
    ])[0]!;

    it("accepts only the exact verifier outcome and owned id sets", () => {
        expect(
            verifyVerifierCompletion(group, {
                outcome: "supported",
                claimIds: ["CL-001"],
                evidenceIds: ["EV-001"],
                summary: "supported",
            }),
        ).toEqual({ ok: true, outcome: "supported" });
        expect(
            verifyVerifierCompletion(group, {
                outcome: "rejected",
                claimIds: ["CL-001", "CL-999"],
                evidenceIds: [],
                summary: "wrong",
            }),
        ).toMatchObject({ ok: false });
    });

    it("accepts architect clear/watch/block and rejects scope drift", () => {
        for (const status of ["clear", "watch", "block"] as const) {
            expect(
                verifyArchitectCompletion(
                    {
                        status,
                        claimIds: ["CL-001"],
                        evidenceIds: ["EV-001"],
                        risks: [],
                        summary: status,
                    },
                    { claimIds: ["CL-001"], evidenceIds: ["EV-001"] },
                ),
            ).toEqual({ ok: true, status });
        }
        expect(
            verifyArchitectCompletion(
                {
                    status: "clear",
                    claimIds: ["CL-999"],
                    evidenceIds: ["EV-001"],
                    risks: [],
                    summary: "drift",
                },
                { claimIds: ["CL-001"], evidenceIds: ["EV-001"] },
            ),
        ).toMatchObject({ ok: false });
    });

    it("owns strict structured schemas", () => {
        expect(VERIFIER_OUTPUT_SCHEMA.additionalProperties).toBe(false);
        expect(VERIFIER_OUTPUT_SCHEMA.required).toEqual([
            "outcome",
            "claimIds",
            "evidenceIds",
            "summary",
        ]);
        expect(ARCHITECT_OUTPUT_SCHEMA.additionalProperties).toBe(false);
        expect(ARCHITECT_OUTPUT_SCHEMA.properties.status.enum).toEqual([
            "clear",
            "watch",
            "block",
        ]);
        expect([...VERIFICATION_OUTCOMES]).toEqual([
            "supported",
            "rejected",
            "unresolved",
        ]);
    });
});
