import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { resolveToolAliases } from "../_shared/tool-groups/resolver.ts";

const AGENT_DIR = join(import.meta.dir, "..", "..");
const GROUPS: Record<string, string[]> = JSON.parse(
    readFileSync(join(AGENT_DIR, "tool-groups.json"), "utf8"),
).groups;

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

const rawGroupValues: unknown[] = Object.values(GROUPS).flat();
if (!isStringArray(rawGroupValues)) {
    throw new Error("tool-groups.json contains non-string group members");
}

const AVAILABLE: string[] = [
    ...new Set<string>([
        ...rawGroupValues,
        "think_index",
        "think_search",
        "think_execute",
        "think_execute_file",
        "think_batch_execute",
        "ask_user_question",
        "subagent",
        "todo",
        "signal_loop_success",
        "write_plan",
        "edit_plan",
        "plan_submit",
        "plan_annotate",
        "write_debug_probe",
        "edit_debug_probe",
        "herdr",
    ]),
].filter((n: string) => !n.startsWith("@"));

describe("Task 7 think_* group resolution", () => {
    it("resolves @think-inspect to think_index + think_search", () => {
        const result = resolveToolAliases(["@think-inspect"], AVAILABLE, GROUPS);
        expect(result.names).toEqual(["think_index", "think_search"]);
        expect(result.diagnostics).toEqual([]);
    });

    it("resolves @think-exec to the three execute tools", () => {
        const result = resolveToolAliases(["@think-exec"], AVAILABLE, GROUPS);
        expect(result.names).toEqual([
            "think_execute",
            "think_execute_file",
            "think_batch_execute",
        ]);
        expect(result.diagnostics).toEqual([]);
    });

    it("resolves @think to all five think tools", () => {
        const result = resolveToolAliases(["@think"], AVAILABLE, GROUPS);
        expect(result.names).toEqual([
            "think_index",
            "think_search",
            "think_execute",
            "think_execute_file",
            "think_batch_execute",
        ]);
        expect(result.diagnostics).toEqual([]);
    });

    it("resolves planning role @think-inspect without leaking @think-exec", () => {
        const planTools = "@inspect, @lens, @web, @docs, @memory-consult, @think-inspect, @subagents, ask_user_question, write_plan, edit_plan, todo, plan_submit, plan_annotate"
            .split(",")
            .map((s) => s.trim());
        const result = resolveToolAliases(planTools, AVAILABLE, GROUPS);
        // Must not contain any think_execute tool (least-privilege)
        expect(result.names).not.toContain("think_execute");
        expect(result.names).not.toContain("think_execute_file");
        expect(result.names).not.toContain("think_batch_execute");
        // Must contain think_index + think_search (inspection only)
        expect(result.names).toContain("think_index");
        expect(result.names).toContain("think_search");
        expect(result.diagnostics).toEqual([]);
    });

    it("resolves atlas-orchestrator @think (combined inspect + exec)", () => {
        const atlasTools = "@inspect, @lens, @think, @docs, @memory-consult, safe_bash, todo, ask_user_question, subagent, signal_loop_success"
            .split(",")
            .map((s) => s.trim());
        const result = resolveToolAliases(atlasTools, AVAILABLE, GROUPS);
        // @think composes both sub-groups — full tool access is intended
        expect(result.names).toContain("think_index");
        expect(result.names).toContain("think_search");
        expect(result.names).toContain("think_execute");
        expect(result.names).toContain("think_execute_file");
        expect(result.names).toContain("think_batch_execute");
        expect(result.diagnostics).toEqual([]);
    });

    it("validates every migrated role resolves cleanly (no diagnostics)", () => {
        // Read every role file and resolve its `tools` frontmatter. This is
        // the cross-role smoke that confirms Task 7's least-privilege role
        // migration is internally consistent for every role that consumed a
        // `@ctx*` group: plan.md, atlas-orchestrator.md, herdr-orchestrator.md,
        // brainstorm.md, ask.md, debug.md.
        const roleFiles = [
            "roles/plan.md",
            "roles/atlas-orchestrator.md",
            "roles/herdr-orchestrator.md",
            "roles/brainstorm.md",
            "roles/ask.md",
            "roles/debug.md",
        ] as const;
        for (const file of roleFiles) {
            const content = readFileSync(join(AGENT_DIR, file), "utf8");
            const toolsMatch = content.match(/^tools:\s*(.+)$/m);
            expect(toolsMatch).not.toBeNull();
            if (!toolsMatch) continue;
            const rawTools = toolsMatch[1].trim().replace(/^['"]|['"]$/g, "");
            const tools = rawTools
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
            const result = resolveToolAliases(tools, AVAILABLE, GROUPS);
            expect(result.diagnostics).toEqual([]);
            // None of the migrated roles may still reference ctx_* groups.
            for (const t of tools) {
                expect(t.startsWith("@ctx")).toBe(false);
            }
            // Resolved names must never contain the legacy MCP ctx_* names.
            for (const name of result.names) {
                expect(name.startsWith("mcp:ctx_")).toBe(false);
            }
        }
    });

    it("plan/ask/brainstorm roles resolve to think_inspect only (not think_exec)", () => {
        // Plan / ask / brainstorm must NOT gain the executable think group,
        // because that would widen their capability ceiling beyond inspection.
        const planResult = resolveToolAliases(
            ["@inspect", "@lens", "@web", "@docs", "@memory-consult", "@think-inspect", "@subagents"],
            AVAILABLE,
            GROUPS,
        );
        const askResult = resolveToolAliases(
            ["@inspect", "@lens", "@web", "@docs", "@memory-consult", "@think-inspect", "ask_user_question", "subagent", "signal_loop_success"],
            AVAILABLE,
            GROUPS,
        );
        for (const r of [planResult, askResult]) {
            expect(r.names).not.toContain("think_execute");
            expect(r.names).not.toContain("think_execute_file");
            expect(r.names).not.toContain("think_batch_execute");
        }
    });

    it("atlas/herdr/debug roles resolve to all five think_* tools via @think", () => {
        // Execution-capable roles get the combined @think group, so the
        // analyzer broker is reachable. Least privilege is preserved by NOT
        // handing them the legacy mcp:ctx_* tools.
        const atlasResult = resolveToolAliases(
            ["@inspect", "@lens", "@think", "@docs", "@memory-consult", "safe_bash", "subagent"],
            AVAILABLE,
            GROUPS,
        );
        const debugResult = resolveToolAliases(
            ["@inspect", "@lens", "@think", "@docs", "@memory-consult", "safe_bash", "write_debug_probe", "edit_debug_probe"],
            AVAILABLE,
            GROUPS,
        );
        for (const r of [atlasResult, debugResult]) {
            expect(r.names).toContain("think_index");
            expect(r.names).toContain("think_search");
            expect(r.names).toContain("think_execute");
            expect(r.names).toContain("think_execute_file");
            expect(r.names).toContain("think_batch_execute");
            // Legacy MCP tools must NOT leak through.
            for (const legacy of [
                "mcp:ctx_index",
                "mcp:ctx_search",
                "mcp:ctx_fetch_and_index",
                "mcp:ctx_execute",
                "mcp:ctx_execute_file",
                "mcp:ctx_batch_execute",
            ]) {
                expect(r.names).not.toContain(legacy);
            }
        }
    });

    it("resolves @review to think_index + think_search instead of legacy mcp:ctx_* tools", () => {
        // The `@review` group is consumed by `api-reviewer`, `style-reviewer`,
        // and every `review-max` consumer (architect, code-reviewer,
        // performance-reviewer, security-reviewer, oh-my-oracle,
        // plan-reviewer). At cutover, the legacy `mcp:ctx_index`,
        // `mcp:ctx_search`, and `mcp:ctx_fetch_and_index` tools disappear and
        // the native `think_index` / `think_search` tools take their place.
        // The group must therefore expose Think-in-Code FTS5 access instead
        // of the legacy MCP bridge.
        const reviewResult = resolveToolAliases(
            ["@review"],
            AVAILABLE,
            GROUPS,
        );
        expect(reviewResult.diagnostics).toEqual([]);
        // Native FTS5 access must be present.
        expect(reviewResult.names).toContain("think_index");
        expect(reviewResult.names).toContain("think_search");
        // Legacy MCP tools must NOT leak through.
        for (const legacy of [
            "mcp:ctx_index",
            "mcp:ctx_search",
            "mcp:ctx_fetch_and_index",
        ]) {
            expect(reviewResult.names).not.toContain(legacy);
        }
        // The reviewer group must not gain any executable think_* tool —
        // reviewers inspect evidence, they do not run analyzers.
        for (const executable of [
            "think_execute",
            "think_execute_file",
            "think_batch_execute",
        ]) {
            expect(reviewResult.names).not.toContain(executable);
        }
    });

    it("resolves @review-max to think_index + think_search without executable think_*", () => {
        // `@review-max` composes `@review` plus report-write and docs tools.
        // The same think-inspect boundary applies: it must surface the
        // native FTS5 tools without any executable think_* tool, so the
        // read-only reviewer ceiling is preserved.
        const reviewMaxResult = resolveToolAliases(
            ["@review-max"],
            AVAILABLE,
            GROUPS,
        );
        expect(reviewMaxResult.diagnostics).toEqual([]);
        expect(reviewMaxResult.names).toContain("think_index");
        expect(reviewMaxResult.names).toContain("think_search");
        for (const legacy of [
            "mcp:ctx_index",
            "mcp:ctx_search",
            "mcp:ctx_fetch_and_index",
            "mcp:ctx_execute",
            "mcp:ctx_execute_file",
            "mcp:ctx_batch_execute",
        ]) {
            expect(reviewMaxResult.names).not.toContain(legacy);
        }
        for (const executable of [
            "think_execute",
            "think_execute_file",
            "think_batch_execute",
        ]) {
            expect(reviewMaxResult.names).not.toContain(executable);
        }
    });

    it("validates every review/review-max agent consumer resolves without mcp:ctx_* and gains think_index/think_search", () => {
        // Cross-agent smoke: every agent frontmatter that references
        // `@review` or `@review-max` must resolve cleanly. This is the
        // counterpart to the role-file smoke earlier in this suite; without
        // it, an undiscovered `@ctx-inspect` reference inside `@review`
        // would survive Task 7's migration gate and dangle at cutover
        // because the legacy `mcp:ctx_*` tools are removed.
        const agentDirs = ["agents"] as const;
        const legacyMcpNames = new Set([
            "mcp:ctx_index",
            "mcp:ctx_search",
            "mcp:ctx_fetch_and_index",
            "mcp:ctx_execute",
            "mcp:ctx_execute_file",
            "mcp:ctx_batch_execute",
        ]);
        const matchedAgents: string[] = [];
        for (const directory of agentDirs) {
            const root = join(AGENT_DIR, directory);
            const entries = readdirSync(root)
                .filter((name) => name.endsWith(".md"))
                .map((name) => {
                    const content = readFileSync(join(root, name), "utf8");
                    const match = content.match(/^tools:\s*(.+)$/m);
                    if (!match) return null;
                    const raw = match[1]
                        .trim()
                        .replace(/^['"]|['"]$/g, "");
                    const tools = raw
                        .split(",")
                        .map((s) => s.trim())
                        .filter(Boolean);
                    const usesReviewGroup = tools.some(
                        (t) => t === "@review" || t === "@review-max",
                    );
                    return usesReviewGroup
                        ? { name, tools }
                        : null;
                })
                .filter(
                    (entry): entry is { name: string; tools: string[] } =>
                        entry !== null,
                );
            for (const entry of entries) {
                matchedAgents.push(`${directory}/${entry.name}`);
                const result = resolveToolAliases(
                    entry.tools,
                    AVAILABLE,
                    GROUPS,
                );
                expect(result.diagnostics).toEqual([]);
                // Native FTS5 access must be present in every review-capable
                // agent — replacing what was previously the legacy MCP
                // bridge.
                expect(result.names).toContain("think_index");
                expect(result.names).toContain("think_search");
                // No legacy MCP tool may leak through into a review-capable
                // agent.
                for (const name of result.names) {
                    expect(legacyMcpNames.has(name)).toBe(false);
                }
            }
        }
        // Sanity: this smoke is meaningful only if at least one review
        // consumer exists. The migration is incomplete if it does not.
        expect(matchedAgents.length).toBeGreaterThan(0);
    });
});
