import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let agentDir: string;
let previousAgentDir: string | undefined;

beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "workflow-agents-gate-"));
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
});

const { createWorkflowAgentGate } = await import("./workflow-agents.ts");

function agentFile(name: string): string {
    return join(agentDir, "agents", `${name}.md`);
}

const ENTRY = { name: "sdd-worker", markdown: "---\nname: sdd-worker\n---\nbody" };
const ENTRY_2 = { name: "sdd-spec-reviewer", markdown: "---\nname: sdd-spec-reviewer\n---\nbody" };

describe("createWorkflowAgentGate", () => {
    it("writes on first acquire and removes on matching release", () => {
        const gate = createWorkflowAgentGate([ENTRY]);
        gate.acquire();
        expect(existsSync(agentFile("sdd-worker"))).toBe(true);
        gate.release();
        expect(existsSync(agentFile("sdd-worker"))).toBe(false);
    });

    it("holds files while any run is active (refcount)", () => {
        const gate = createWorkflowAgentGate([ENTRY, ENTRY_2]);
        gate.acquire();
        gate.acquire();
        expect(existsSync(agentFile("sdd-worker"))).toBe(true);
        expect(existsSync(agentFile("sdd-spec-reviewer"))).toBe(true);
        gate.release();
        expect(existsSync(agentFile("sdd-worker"))).toBe(true); // one run still active
        gate.release();
        expect(existsSync(agentFile("sdd-worker"))).toBe(false);
        expect(existsSync(agentFile("sdd-spec-reviewer"))).toBe(false);
    });

    it("does not rewrite on overlapping acquire", () => {
        const gate = createWorkflowAgentGate([ENTRY]);
        gate.acquire();
        gate.acquire();
        gate.release();
        gate.release();
        expect(existsSync(agentFile("sdd-worker"))).toBe(false);
    });

    it("is a no-op when no run has ever acquired", () => {
        const gate = createWorkflowAgentGate([ENTRY]);
        gate.release();
        expect(existsSync(agentFile("sdd-worker"))).toBe(false);
    });
});
