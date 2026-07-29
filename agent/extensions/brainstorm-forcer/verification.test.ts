import { describe, expect, it } from "bun:test";
import { Value } from "typebox/value";
// Direct file import: schemas.ts is not in pi-subagents exports map, so we
// resolve the installed source directly. Validates the REAL installed
// ChainItem / ParallelTaskSchema (pi-subagents 0.37.2), not a handwritten copy.
import {
    ChainItem,
    ParallelTaskSchema,
} from "../../npm/node_modules/pi-subagents/src/extension/schemas.ts";
// The REAL installed runtime validator that throws the production error
// `Invalid chain output name '<name>' at step N. Use /^[A-Za-z_][A-Za-z0-9_]*$/.`
// (pi-subagents 0.37.2, src/runs/shared/chain-outputs.ts: SAFE_OUTPUT_NAME_PATTERN
// + validateChainOutputBindings). Importing it exercises the exact spawn-time
// semantic check that rejected `verify-local-code-supported`.
import {
    validateChainOutputBindings,
    ChainOutputValidationError,
} from "../../npm/node_modules/pi-subagents/src/runs/shared/chain-outputs.ts";
import {
    ARCHITECT_AGENT,
    ARCHITECT_OUTPUT_SCHEMA,
    ARCHITECTURAL_STATUSES,
    READONLY_VERIFIER_TOOLS,
    VERIFICATION_DOMAINS,
    VERIFICATION_OUTCOMES,
    VERIFICATION_ROUTING,
    VERIFIER_AGENT_ALLOWLIST,
    VERIFIER_OUTPUT_SCHEMA,
    buildVerificationChain,
    buildVerifierCapabilityCeiling,
    groupVerificationClaims,
    verifyArchitectCompletion,
    verifyVerifierCompletion,
    type ArchitecturalStatus,
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

describe("verification routing policy", () => {
    it("exposes a closed routing map covering every domain exactly once", () => {
        expect([...VERIFICATION_DOMAINS]).toEqual([
            "pi",
            "local-code",
            "external",
            "performance",
        ]);
        expect(VERIFICATION_ROUTING).toEqual({
            pi: "pi-expert",
            "local-code": "scout",
            external: "factual-researcher",
            performance: "performance-reviewer",
        });
    });

    it("exports the exact verifier agent allowlist and excludes forbidden agents", () => {
        expect([...VERIFIER_AGENT_ALLOWLIST]).toEqual([
            "pi-expert",
            "scout",
            "factual-researcher",
            "performance-reviewer",
        ]);
        for (const agent of [
            "expert-reviewer",
            "reviewer",
            "worker",
            "oracle",
            "quick-worker",
            "sdd-worker",
            "task-doer",
        ]) {
            expect(VERIFIER_AGENT_ALLOWLIST).not.toContain(agent);
        }
    });

    it("routes the architect advisory to the dedicated read-only architect agent", () => {
        expect(ARCHITECT_AGENT).toBe("architect");
    });
});

describe("verification grouping", () => {
    it("groups claims by domain and expected outcome", () => {
        const groups = groupVerificationClaims([
            claim("CL-001", "pi", "supported", [ev("EV-001", "pi/types.ts")]),
            claim("CL-002", "pi", "supported", [ev("EV-002", "pi/types.ts")]),
            claim("CL-003", "local-code", "rejected"),
            claim("CL-004", "pi", "unresolved"),
        ]);

        expect(groups.map((group) => [group.domain, group.outcome])).toEqual([
            ["pi", "supported"],
            ["pi", "unresolved"],
            ["local-code", "rejected"],
        ]);
        expect(groups[0]!.claimIds).toEqual(["CL-001", "CL-002"]);
        expect(groups[0]!.agent).toBe("pi-expert");
        expect(groups[1]!.agent).toBe("pi-expert");
        expect(groups[2]!.agent).toBe("scout");
    });

    it("keeps stable ordering independent of input order", () => {
        const ordered = [
            claim("CL-001", "pi", "supported"),
            claim("CL-002", "external", "rejected"),
            claim("CL-003", "local-code", "unresolved"),
            claim("CL-004", "performance", "supported"),
            claim("CL-005", "pi", "supported", [], "Earlier assertion"),
        ];
        const shuffled = [
            claim("CL-005", "pi", "supported", [], "Earlier assertion"),
            claim("CL-004", "performance", "supported"),
            claim("CL-002", "external", "rejected"),
            claim("CL-001", "pi", "supported"),
            claim("CL-003", "local-code", "unresolved"),
        ];

        expect(groupVerificationClaims(shuffled)).toEqual(
            groupVerificationClaims(ordered),
        );
        expect(groupVerificationClaims(ordered).map((g) => g.claimIds)).toEqual([
            ["CL-001", "CL-005"],
            ["CL-003"],
            ["CL-002"],
            ["CL-004"],
        ]);
    });

    it("deduplicates evidence by id and merges source refs inside a group", () => {
        const groups = groupVerificationClaims([
            claim("CL-002", "external", "supported", [
                ev("EV-003", "https://a.example/x"),
                ev("EV-001", "README.md"),
            ]),
            claim("CL-001", "external", "supported", [
                ev("EV-001", "README.md", "index.ts"),
                ev("EV-002", "index.ts"),
            ]),
        ]);

        const evidence = groups[0]!.evidence;
        expect(evidence.map((e) => e.id)).toEqual(["EV-001", "EV-002", "EV-003"]);
        const merged = evidence.find((e) => e.id === "EV-001")!;
        expect([...merged.sourceRefs]).toEqual(["README.md", "index.ts"]);
    });

    it("returns no groups for an empty claim set", () => {
        expect(groupVerificationClaims([])).toEqual([]);
    });
});

describe("verification chain payload — installed schema contract", () => {
    it("every generated chain step validates against the installed ChainItem schema", () => {
        const { chain } = buildVerificationChain({
            runId: "run-1",
            claims: [
                claim("CL-001", "pi", "supported", [ev("EV-001", "pi/types.ts")]),
                claim("CL-002", "local-code", "rejected", [
                    ev("EV-002", "src/index.ts"),
                ]),
                claim("CL-003", "external", "unresolved", [
                    ev("EV-003", "https://docs.example/x"),
                ]),
                claim("CL-004", "performance", "supported"),
            ],
            architectureImpact: true,
        });

        expect(chain.length).toBeGreaterThan(0);
        for (const step of chain) {
            expect(Value.Check(ChainItem, step)).toBe(true);
            if ("parallel" in step) {
                for (const task of step.parallel) {
                    expect(Value.Check(ParallelTaskSchema, task)).toBe(true);
                }
            }
        }
    });

    it("rejects per-step context: a hand-built step with context fails ChainItem", () => {
        // Regression guard: ChainItem has additionalProperties:false and no
        // `context` key. context lives only on top-level SubagentParams.
        const withContext = {
            agent: "scout",
            context: "fresh",
            task: "x",
            outputSchema: { type: "object" },
            as: "v",
        };
        expect(Value.Check(ChainItem, withContext)).toBe(false);
    });

    it("rejects a step that sets acceptance:false explicitly", () => {
        // Package docs: omit acceptance for reviewer/read-only calls.
        const withAcceptance = {
            agent: "scout",
            task: "x",
            outputSchema: { type: "object" },
            as: "v",
            acceptance: false,
        };
        // acceptance:false IS schema-valid, but policy forbids it — the builder
        // must not emit it. Confirm schema still accepts it, then verify the
        // builder omits the key entirely.
        expect(Value.Check(ChainItem, withAcceptance)).toBe(true);
        const { chain } = buildVerificationChain({
            runId: "run-1",
            claims: [claim("CL-001", "local-code", "supported")],
        });
        const serialized = JSON.stringify(chain);
        expect(serialized).not.toContain('"acceptance"');
    });

    it("omits output and outputMode from every generated step", () => {
        const { chain } = buildVerificationChain({
            runId: "run-1",
            claims: [
                claim("CL-001", "pi", "supported", [ev("EV-001", "pi/types.ts")]),
            ],
            architectureImpact: true,
        });
        const serialized = JSON.stringify(chain);
        expect(serialized).not.toContain('"output"');
        expect(serialized).not.toContain('"outputMode"');
    });

    it("never emits expert-reviewer, reviewer, worker, or oracle in generated steps", () => {
        const { chain } = buildVerificationChain({
            runId: "run-1",
            claims: [
                claim("CL-001", "pi", "supported"),
                claim("CL-002", "local-code", "rejected"),
                claim("CL-003", "external", "unresolved"),
                claim("CL-004", "performance", "supported"),
            ],
            architectureImpact: true,
        });
        const serialized = JSON.stringify(chain);
        for (const forbidden of [
            "expert-reviewer",
            '"reviewer"',
            "worker",
            "oracle",
        ]) {
            expect(serialized).not.toContain(forbidden);
        }
    });

    it("omits the architect step for ordinary claims without architecture impact", () => {
        const { chain } = buildVerificationChain({
            runId: "run-1",
            claims: [claim("CL-001", "local-code", "supported")],
        });
        expect(chain).toHaveLength(1);
        expect(JSON.stringify(chain)).not.toContain(ARCHITECT_AGENT);
    });

    it("appends a single architect advisory after verifier groups when architecture impact is true", () => {
        const { chain } = buildVerificationChain({
            runId: "run-1",
            claims: [
                claim("CL-001", "pi", "supported"),
                claim("CL-002", "local-code", "rejected"),
                claim("CL-003", "performance", "unresolved"),
            ],
            architectureImpact: true,
        });

        expect(chain).toHaveLength(2);
        expect(chain[0]).toHaveProperty("parallel");
        const architect = chain[1] as Record<string, unknown>;
        expect(architect.agent).toBe(ARCHITECT_AGENT);
        expect(architect).not.toHaveProperty("context");
        expect(architect).not.toHaveProperty("acceptance");
        expect(architect.outputSchema).toBe(ARCHITECT_OUTPUT_SCHEMA);
        expect(typeof architect.task).toBe("string");
        expect(String(architect.task)).toContain("{outputs.");
    });

    it("pins the architect task to the selected architecture claim and evidence scope", () => {
        const { chain } = buildVerificationChain({
            runId: "run-1",
            claims: [
                claim(
                    "CL-001",
                    "local-code",
                    "supported",
                    [ev("EV-001", "ordinary.ts")],
                ),
                claim(
                    "CL-002",
                    "external",
                    "supported",
                    [ev("EV-002", "architecture.md")],
                ),
            ],
            architectureImpact: true,
            architectureScope: {
                claimIds: ["CL-002"],
                evidenceIds: ["EV-002"],
            },
        });
        const architect = chain[1] as Record<string, unknown>;
        expect(String(architect.task)).toContain(
            "Exact architecture claimIds: CL-002.",
        );
        expect(String(architect.task)).toContain(
            "Exact architecture evidenceIds: EV-002.",
        );
    });

    it("produces identical payloads for the same claim set regardless of order", () => {
        const base = [
            claim("CL-001", "pi", "supported", [ev("EV-001", "a.ts")]),
            claim("CL-002", "external", "rejected", [ev("EV-002", "https://x")]),
            claim("CL-003", "local-code", "unresolved"),
        ];
        const a = buildVerificationChain({
            runId: "run-1",
            claims: base,
            architectureImpact: true,
        });
        const b = buildVerificationChain({
            runId: "run-1",
            claims: [...base].reverse(),
            architectureImpact: true,
        });
        expect(JSON.stringify(b)).toEqual(JSON.stringify(a));
    });
});

describe("verifier task content", () => {
    it("embeds each claim id, assertion, evidence id, and source reference", () => {
        const { chain } = buildVerificationChain({
            runId: "run-1",
            claims: [
                claim(
                    "CL-001",
                    "local-code",
                    "supported",
                    [ev("EV-001", "src/gate.ts:42")],
                    "The gate is centralized.",
                ),
            ],
        });
        const step = chain[0]!;
        if (!("parallel" in step)) throw new Error("expected parallel step");
        const task = step.parallel[0]!.task;
        expect(task).toContain("CL-001");
        expect(task).toContain("The gate is centralized.");
        expect(task).toContain("EV-001");
        expect(task).toContain("src/gate.ts:42");
    });
});

describe("strict output schemas", () => {
    it("owns a strict verifier schema with exactly the required fields", () => {
        expect(VERIFIER_OUTPUT_SCHEMA).toEqual({
            type: "object",
            properties: {
                outcome: {
                    type: "string",
                    enum: [...VERIFICATION_OUTCOMES],
                },
                claimIds: {
                    type: "array",
                    items: { type: "string" },
                    uniqueItems: true,
                },
                evidenceIds: {
                    type: "array",
                    items: { type: "string" },
                    uniqueItems: true,
                },
                summary: { type: "string" },
            },
            required: ["outcome", "claimIds", "evidenceIds", "summary"],
            additionalProperties: false,
        });
    });

    it("owns a strict architect schema distinguishing watch from block", () => {
        expect(ARCHITECT_OUTPUT_SCHEMA).toEqual({
            type: "object",
            properties: {
                status: {
                    type: "string",
                    enum: [...ARCHITECTURAL_STATUSES],
                },
                claimIds: {
                    type: "array",
                    items: { type: "string" },
                    uniqueItems: true,
                },
                evidenceIds: {
                    type: "array",
                    items: { type: "string" },
                    uniqueItems: true,
                },
                risks: { type: "array", items: { type: "string" } },
                summary: { type: "string" },
            },
            required: ["status", "claimIds", "evidenceIds", "risks", "summary"],
            additionalProperties: false,
        });
        expect([...ARCHITECTURAL_STATUSES]).toEqual(["clear", "watch", "block"]);
    });
});

describe("completion validators — exact correlation", () => {
    const group = groupVerificationClaims([
        claim("CL-001", "pi", "supported", [ev("EV-001", "a.ts")]),
        claim("CL-002", "pi", "supported", [ev("EV-002", "b.ts")]),
    ])[0]!;

    it("accepts a verifier completion with the exact claim and evidence set", () => {
        const result = verifyVerifierCompletion(group, {
            outcome: "supported",
            claimIds: ["CL-001", "CL-002"],
            evidenceIds: ["EV-001", "EV-002"],
            summary: "Both claims corroborated.",
        });
        expect(result).toEqual({ ok: true, outcome: "supported" });
    });

    it("rejects a verifier completion with an undeclared structured field", () => {
        const result = verifyVerifierCompletion(group, {
            outcome: "supported",
            claimIds: ["CL-001", "CL-002"],
            evidenceIds: ["EV-001", "EV-002"],
            summary: "Both claims corroborated.",
            confidence: 0.9,
        });
        expect(result.ok).toBe(false);
        if (!result.ok)
            expect(result.blockers.join("\n")).toContain("fields");
    });

    it("rejects a verifier completion whose outcome diverges from the group", () => {
        const result = verifyVerifierCompletion(group, {
            outcome: "rejected",
            claimIds: ["CL-001", "CL-002"],
            evidenceIds: ["EV-001", "EV-002"],
            summary: "Diverging outcome.",
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.blockers.join("\n")).toContain("outcome");
    });

    it("rejects a verifier completion that drops a grouped claim id", () => {
        const result = verifyVerifierCompletion(group, {
            outcome: "supported",
            claimIds: ["CL-001"],
            evidenceIds: ["EV-001", "EV-002"],
            summary: "Missing claim.",
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.blockers.join("\n")).toContain("CL-002");
    });

    it("rejects a verifier completion that invents an extra claim id", () => {
        const result = verifyVerifierCompletion(group, {
            outcome: "supported",
            claimIds: ["CL-001", "CL-002", "CL-999"],
            evidenceIds: ["EV-001", "EV-002"],
            summary: "Extra claim.",
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.blockers.join("\n")).toContain("CL-999");
    });

    it("rejects a verifier completion that invents an extra evidence id", () => {
        const result = verifyVerifierCompletion(group, {
            outcome: "supported",
            claimIds: ["CL-001", "CL-002"],
            evidenceIds: ["EV-001", "EV-002", "EV-999"],
            summary: "Extra evidence.",
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.blockers.join("\n")).toContain("EV-999");
    });

    it("rejects a verifier completion that drops a grouped evidence id", () => {
        const result = verifyVerifierCompletion(group, {
            outcome: "supported",
            claimIds: ["CL-001", "CL-002"],
            evidenceIds: ["EV-001"],
            summary: "Missing evidence.",
        });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.blockers.join("\n")).toContain("EV-002");
    });

    it("rejects a verifier completion with duplicate claim ids", () => {
        const result = verifyVerifierCompletion(group, {
            outcome: "supported",
            claimIds: ["CL-001", "CL-001", "CL-002"],
            evidenceIds: ["EV-001", "EV-002"],
            summary: "Duplicate claim.",
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.blockers.join("\n").toLowerCase()).toContain(
                "duplicate",
            );
        }
    });

    it("rejects a verifier completion with duplicate evidence ids", () => {
        const result = verifyVerifierCompletion(group, {
            outcome: "supported",
            claimIds: ["CL-001", "CL-002"],
            evidenceIds: ["EV-001", "EV-001", "EV-002"],
            summary: "Duplicate evidence.",
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.blockers.join("\n").toLowerCase()).toContain(
                "duplicate",
            );
        }
    });

    it("rejects malformed verifier output structures", () => {
        expect(verifyVerifierCompletion(group, null).ok).toBe(false);
        expect(
            verifyVerifierCompletion(group, {
                outcome: "supported",
                claimIds: "CL-001",
                evidenceIds: ["EV-001"],
                summary: "Wrong claimIds shape.",
            }).ok,
        ).toBe(false);
        expect(
            verifyVerifierCompletion(group, {
                outcome: "supported",
                claimIds: ["CL-001", "CL-002"],
                evidenceIds: ["EV-001", "EV-002"],
                summary: "",
            }).ok,
        ).toBe(false);
    });

    it("accepts every architectural status and validates against the expected scope", () => {
        const scope = {
            claimIds: ["CL-001", "CL-002"],
            evidenceIds: ["EV-001", "EV-002"],
        };
        for (const status of ARCHITECTURAL_STATUSES) {
            const result = verifyArchitectCompletion(
                {
                    status,
                    claimIds: ["CL-001", "CL-002"],
                    evidenceIds: ["EV-001", "EV-002"],
                    risks: ["latency under load"],
                    summary: "Advisory.",
                },
                scope,
            );
            expect(result).toEqual({ ok: true, status });
        }
    });

    it("rejects architect output with duplicate claim or evidence ids", () => {
        const scope = {
            claimIds: ["CL-001", "CL-002"],
            evidenceIds: ["EV-001", "EV-002"],
        };
        const dupClaims = verifyArchitectCompletion(
            {
                status: "clear",
                claimIds: ["CL-001", "CL-001", "CL-002"],
                evidenceIds: ["EV-001", "EV-002"],
                risks: ["x"],
                summary: "Dup claims.",
            },
            scope,
        );
        expect(dupClaims.ok).toBe(false);
        if (!dupClaims.ok) {
            expect(dupClaims.blockers.join("\n").toLowerCase()).toContain(
                "duplicate",
            );
        }
        const dupEvidence = verifyArchitectCompletion(
            {
                status: "clear",
                claimIds: ["CL-001", "CL-002"],
                evidenceIds: ["EV-001", "EV-001", "EV-002"],
                risks: ["x"],
                summary: "Dup evidence.",
            },
            scope,
        );
        expect(dupEvidence.ok).toBe(false);
        if (!dupEvidence.ok) {
            expect(
                dupEvidence.blockers.join("\n").toLowerCase(),
            ).toContain("duplicate");
        }
    });

    it("rejects architect output whose claim scope drifts from expected", () => {
        const result = verifyArchitectCompletion(
            {
                status: "clear",
                claimIds: ["CL-001", "CL-002", "CL-999"],
                evidenceIds: ["EV-001", "EV-002"],
                risks: ["x"],
                summary: "Extra claim.",
            },
            { claimIds: ["CL-001", "CL-002"], evidenceIds: ["EV-001", "EV-002"] },
        );
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.blockers.join("\n")).toContain("CL-999");
    });

    it("rejects architect output whose evidence scope drifts from expected", () => {
        const result = verifyArchitectCompletion(
            {
                status: "block",
                claimIds: ["CL-001"],
                evidenceIds: ["EV-001", "EV-777"],
                risks: ["x"],
                summary: "Extra evidence.",
            },
            { claimIds: ["CL-001"], evidenceIds: ["EV-001"] },
        );
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.blockers.join("\n")).toContain("EV-777");
    });

    it("rejects architect output with an unknown status or missing risks", () => {
        expect(
            verifyArchitectCompletion(
                {
                    status: "green",
                    claimIds: ["CL-001"],
                    evidenceIds: ["EV-001"],
                    risks: ["x"],
                    summary: "Unknown status.",
                },
                { claimIds: ["CL-001"], evidenceIds: ["EV-001"] },
            ).ok,
        ).toBe(false);
        expect(
            verifyArchitectCompletion(
                {
                    status: "block",
                    claimIds: ["CL-001"],
                    evidenceIds: ["EV-001"],
                    summary: "Missing risks.",
                // missing risks key
                } as unknown as Record<string, unknown>,
                { claimIds: ["CL-001"], evidenceIds: ["EV-001"] },
            ).ok,
        ).toBe(false);
    });

    it("rejects architect output with an undeclared structured field", () => {
        const result = verifyArchitectCompletion(
            {
                status: "clear",
                claimIds: ["CL-001"],
                evidenceIds: ["EV-001"],
                risks: [],
                summary: "No architecture issue.",
                recommendation: "Proceed.",
            },
            { claimIds: ["CL-001"], evidenceIds: ["EV-001"] },
        );
        expect(result.ok).toBe(false);
        if (!result.ok)
            expect(result.blockers.join("\n")).toContain("fields");
    });
});

describe("read-only capability policy", () => {
    it("exports a non-empty read-only tool allowlist", () => {
        expect(READONLY_VERIFIER_TOOLS.length).toBeGreaterThan(0);
    });

    it("forbids every mutation-capable tool from the verifier ceiling", () => {
        const forbidden = [
            // file/workspace mutation
            "write",
            "edit",
            "bash",
            "safe_bash",
            "hypa_shell",
            "propose_commit_plan",
            "todo",
            "memory",
            "skill_manage",
            "subagent",
            "edit_plan",
            "write_plan",
            "write_report",
            "edit_report",
            // arbitrary-code execution (shell/node fs can mutate project)
            "ctx_execute",
            "ctx_batch_execute",
            "ctx_execute_file",
            // persistent index mutation
            "ctx_index",
            // LSP rename/executeCommand(apply:true) mutates the workspace
            "lsp_navigation",
        ];
        for (const tool of forbidden) {
            expect(READONLY_VERIFIER_TOOLS).not.toContain(tool);
        }
    });

    it("keeps read-only investigation and research tools available", () => {
        for (const tool of [
            "read",
            "grep",
            "find",
            "ls",
            "lsp_diagnostics",
            "lens_diagnostics",
            "symbol_search",
            "module_report",
            "web_search",
            "source_check",
            "fetch_content",
        ]) {
            expect(READONLY_VERIFIER_TOOLS).toContain(tool);
        }
    });

    it("builds a capability ceiling that keeps providers loadable (denyExtensions false)", () => {
        const ceiling = buildVerifierCapabilityCeiling();
        expect(ceiling.denyExtensions).toBe(false);
        expect(Array.isArray(ceiling.allowedTools)).toBe(true);
        expect(ceiling.allowedTools).toEqual([...READONLY_VERIFIER_TOOLS].sort());
        // sorted and de-duplicated
        const sorted = [...ceiling.allowedTools].sort();
        expect(ceiling.allowedTools).toEqual(sorted);
        expect(new Set(ceiling.allowedTools).size).toBe(ceiling.allowedTools.length);
    });
});

describe("deterministic domain and outcome orderings", () => {
    it("emits groups in canonical domain then outcome order", () => {
        const groups = groupVerificationClaims([
            claim("CL-010", "performance", "supported"),
            claim("CL-009", "external", "unresolved"),
            claim("CL-008", "external", "rejected"),
            claim("CL-007", "local-code", "supported"),
            claim("CL-006", "pi", "unresolved"),
            claim("CL-005", "pi", "rejected"),
            claim("CL-004", "pi", "supported"),
        ]);
        expect(
            groups.map((group) => `${group.domain}:${group.outcome}` as const),
        ).toEqual([
            "pi:supported",
            "pi:rejected",
            "pi:unresolved",
            "local-code:supported",
            "external:rejected",
            "external:unresolved",
            "performance:supported",
        ]);
    });
});

describe("architectural status type narrowing", () => {
    it("treats watch as distinct from block at the type level", () => {
        const statuses: ArchitecturalStatus[] = ["clear", "watch", "block"];
        expect(statuses).toContain("watch");
        expect(statuses).toContain("block");
        expect("watch").not.toBe("block");
    });
});

// Runtime contract mirror: pi-subagents 0.37.2 src/runs/shared/chain-outputs.ts
// declares `const SAFE_OUTPUT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;` and throws
// `Invalid chain output name '<name>' at step N` from validateChainOutputBindings
// when any emitted `as` (named output) fails it. A hyphen anywhere in the name
// (e.g. the `local-code` domain, or a `-` separator) is rejected — so EVERY
// generated verifier/architect output name must be identifier-safe.
const SAFE_OUTPUT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Walk a generated chain and collect every named-output (`as`) string in
 * emission order: each parallel task's `as`, then the architect step's `as`.
 */
function generatedOutputNames(chain: readonly unknown[]): string[] {
    const names: string[] = [];
    for (const step of chain) {
        if (
            step !== null &&
            typeof step === "object" &&
            !Array.isArray(step) &&
            "parallel" in step &&
            Array.isArray((step as { parallel: unknown }).parallel)
        ) {
            for (const task of (step as { parallel: { as?: unknown }[] })
                .parallel) {
                if (typeof task.as === "string") names.push(task.as);
            }
        } else if (
            step !== null &&
            typeof step === "object" &&
            !Array.isArray(step) &&
            "as" in step &&
            typeof (step as { as?: unknown }).as === "string"
        ) {
            names.push((step as { as: string }).as);
        }
    }
    return names;
}

describe("generated output names — runtime identifier contract", () => {
    it("every generated output name matches the runtime SAFE_OUTPUT_NAME_PATTERN across all domain/outcome combinations", () => {
        // Every domain × every outcome, one claim each, plus the architect step.
        const claims: VerificationClaim[] = [];
        let ordinal = 1;
        for (const domain of VERIFICATION_DOMAINS) {
            for (const outcome of VERIFICATION_OUTCOMES) {
                claims.push(
                    claim(
                        `CL-${String(ordinal).padStart(3, "0")}`,
                        domain,
                        outcome,
                        [ev(`EV-${String(ordinal).padStart(3, "0")}`, "ref.ts")],
                    ),
                );
                ordinal += 1;
            }
        }
        const { chain } = buildVerificationChain({
            runId: "run-all-combos",
            claims,
            architectureImpact: true,
        });

        const names = generatedOutputNames(chain);
        // 12 verifier groups + 1 architect = 13 named outputs.
        expect(names).toHaveLength(
            VERIFICATION_DOMAINS.length * VERIFICATION_OUTCOMES.length + 1,
        );
        for (const name of names) {
            expect(SAFE_OUTPUT_NAME_PATTERN.test(name)).toBe(true);
        }
    });

    it("the actual generated chain passes the installed pi-subagents validateChainOutputBindings (the exact spawn-time check)", () => {
        const { chain } = buildVerificationChain({
            runId: "run-validator",
            claims: [
                claim("CL-001", "local-code", "supported", [
                    ev("EV-001", "src/index.ts"),
                ]),
                claim("CL-002", "pi", "rejected"),
                claim("CL-003", "external", "unresolved"),
                claim("CL-004", "performance", "supported"),
            ],
            architectureImpact: true,
        });
        // Deep-copy into mutable plain objects (the validator expects ChainStep[];
        // our payload uses readonly tuples). Shape is structurally identical.
        const mutableChain = JSON.parse(JSON.stringify(chain)) as unknown[];
        expect(() => {
            validateChainOutputBindings(
                mutableChain as Parameters<typeof validateChainOutputBindings>[0],
            );
        }).not.toThrow(ChainOutputValidationError);
    });

    it("emits the exact identifier-safe names for the local-code supported group and the architect step", () => {
        // `local-code` is the only domain containing a hyphen; its name must NOT
        // retain it. Architect step name must also be identifier-safe.
        const { chain } = buildVerificationChain({
            runId: "run-local-code",
            claims: [
                claim("CL-001", "local-code", "supported", [
                    ev("EV-001", "src/gate.ts"),
                ]),
            ],
            architectureImpact: true,
        });
        const names = generatedOutputNames(chain);
        expect(names).toContain("verify_local_code_supported");
        expect(names).toContain("architect_advisory");
        // Never emit the rejected hyphenated forms.
        expect(names).not.toContain("verify-local-code-supported");
        expect(names).not.toContain("architect-advisory");
    });

    it("keeps verifier output names and the architect task's {outputs.X} references correlated", () => {
        // The architect task embeds `{outputs.<name>}` for every verifier group;
        // those references must use the SAME identifier-safe names the verifier
        // steps declare as their `as`, or resolveOutputReferences throws.
        const { chain } = buildVerificationChain({
            runId: "run-correlation",
            claims: [
                claim("CL-001", "local-code", "supported"),
                claim("CL-002", "pi", "rejected"),
            ],
            architectureImpact: true,
        });
        const verifierNames = generatedOutputNames([chain[0]!]);
        const architect = chain[chain.length - 1] as Record<string, unknown>;
        const task = String(architect.task);
        for (const name of verifierNames) {
            expect(task).toContain(`{outputs.${name}}`);
            expect(SAFE_OUTPUT_NAME_PATTERN.test(name)).toBe(true);
        }
    });
});
