import { describe, expect, it, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let agentDir: string;
let previousAgentDir: string | undefined;

beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "sdd-agents-"));
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
});

const { createSddAgentGate, getSddAgentEntry, getSddAgentEntries } =
    await import("./sdd-agents.ts");

function agentFile(name: string): string {
    return join(agentDir, "agents", `${name}.md`);
}

describe("sdd-agents", () => {
    it("defines exactly the five task-execution agents, not assessor/orchestrator", () => {
        const names = getSddAgentEntries().map((entry) => entry.name).sort();
        expect(names).toEqual([
            "sdd-combined-reviewer",
            "sdd-qa-tester",
            "sdd-quality-reviewer",
            "sdd-spec-reviewer",
            "sdd-worker",
        ]);
        expect(getSddAgentEntry("orchestration-assessor")).toBeUndefined();
        expect(getSddAgentEntry("sdd-orchestrator")).toBeUndefined();
    });

    it("each entry carries a full markdown definition with its name", () => {
        for (const entry of getSddAgentEntries()) {
            expect(entry.markdown).toContain(`name: ${entry.name}`);
            expect(entry.markdown).toContain("---");
        }
    });

    it("writes all five on acquire and removes them on release", () => {
        const gate = createSddAgentGate();
        gate.acquire();
        for (const name of [
            "sdd-worker",
            "sdd-combined-reviewer",
            "sdd-spec-reviewer",
            "sdd-quality-reviewer",
            "sdd-qa-tester",
        ]) {
            expect(existsSync(agentFile(name))).toBe(true);
        }
        gate.release();
        for (const name of [
            "sdd-worker",
            "sdd-combined-reviewer",
            "sdd-spec-reviewer",
            "sdd-quality-reviewer",
            "sdd-qa-tester",
        ]) {
            expect(existsSync(agentFile(name))).toBe(false);
        }
    });

    it("holds files across overlapping runs (refcount)", () => {
        const gate = createSddAgentGate();
        gate.acquire();
        gate.acquire();
        gate.release();
        expect(existsSync(agentFile("sdd-worker"))).toBe(true); // one run still active
        gate.release();
        expect(existsSync(agentFile("sdd-worker"))).toBe(false);
    });
});
