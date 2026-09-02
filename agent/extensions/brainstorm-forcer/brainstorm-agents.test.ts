import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let agentDir: string;
let previousAgentDir: string | undefined;

beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "brainstorm-agents-"));
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
});

const {
    createBrainstormAgentGate,
    getBrainstormAgentEntries,
    getBrainstormAgentEntry,
} = await import("./brainstorm-agents.ts");

function agentFile(name: string): string {
    return join(agentDir, "agents", `${name}.md`);
}

describe("brainstorm agents", () => {
    it("defines one local research and verification agent", () => {
        expect(getBrainstormAgentEntries().map((entry) => entry.name)).toEqual([
            "brainstorm-scout",
        ]);
        expect(getBrainstormAgentEntry("brainstorm-code-scout")).toBeUndefined();
        expect(getBrainstormAgentEntry("brainstorm-scout")?.markdown).toContain(
            "research and verify local-code claims",
        );
    });

    it("gates brainstorm-scout across overlapping active runs", () => {
        const gate = createBrainstormAgentGate();
        gate.acquire();
        gate.acquire();
        expect(existsSync(agentFile("brainstorm-scout"))).toBe(true);
        gate.release();
        expect(existsSync(agentFile("brainstorm-scout"))).toBe(true);
        gate.release();
        expect(existsSync(agentFile("brainstorm-scout"))).toBe(false);
    });
});
