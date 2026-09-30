import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus } from "@earendil-works/pi-coding-agent";

let agentDir: string;
let previousAgentDir: string | undefined;

beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "workflow-agents-"));
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
});

const {
    registerWorkflowAgents,
    isWorkflowAgentActive,
    publishWorkflowAgentDefinitions,
    collectWorkflowAgentDefinitions,
} = await import("./workflow-agents.ts");

function agentFile(name: string): string {
    return join(agentDir, "agents", `${name}.md`);
}

it("collects definitions before files exist, isolates buses, and removes disposed providers", () => {
    const bus = createEventBus();
    const other = createEventBus();
    const entry = {
        name: "flow-reader",
        markdown: "---\nname: flow-reader\n---\n",
    };
    expect(collectWorkflowAgentDefinitions(bus)).toEqual({
        entries: [],
        diagnostics: [],
    });
    const dispose = publishWorkflowAgentDefinitions(bus, "fixture-owner", [
        entry,
    ]);
    expect(collectWorkflowAgentDefinitions(bus)).toEqual({
        entries: [entry],
        diagnostics: [],
    });
    expect(isWorkflowAgentActive(entry.name)).toBe(false);
    expect(collectWorkflowAgentDefinitions(other)).toEqual({
        entries: [],
        diagnostics: [],
    });
    dispose();
    dispose();
    expect(collectWorkflowAgentDefinitions(bus)).toEqual({
        entries: [],
        diagnostics: [],
    });
});

it("reports conflicting definitions explicitly instead of trusting swallowed bus exceptions", () => {
    const bus = createEventBus();
    const entry = { name: "flow-reader", markdown: "first" };
    const disposeA = publishWorkflowAgentDefinitions(bus, "owner-a", [entry]);
    const disposeB = publishWorkflowAgentDefinitions(bus, "owner-b", [
        { ...entry, markdown: "second" },
    ]);
    try {
        const result = collectWorkflowAgentDefinitions(bus);
        expect(result.diagnostics).toHaveLength(1);
        expect(result.diagnostics[0]).toContain("flow-reader");
        expect(result.entries).toEqual([]);
    } finally {
        disposeA();
        disposeB();
    }
});

describe("registerWorkflowAgents", () => {
    it("writes each entry's markdown to the shared agent dir", () => {
        const handle = registerWorkflowAgents([
            {
                name: "brainstorm-code-scout",
                markdown: "---\nname: brainstorm-code-scout\n---\nbody",
            },
        ]);
        expect(existsSync(agentFile("brainstorm-code-scout"))).toBe(true);
        expect(
            readFileSync(agentFile("brainstorm-code-scout"), "utf8"),
        ).toContain("name: brainstorm-code-scout");
        handle.dispose();
    });

    it("removes the file after dispose", () => {
        const handle = registerWorkflowAgents([
            {
                name: "sdd-worker",
                markdown: "---\nname: sdd-worker\n---\nbody",
            },
        ]);
        expect(isWorkflowAgentActive("sdd-worker")).toBe(true);
        handle.dispose();
        expect(isWorkflowAgentActive("sdd-worker")).toBe(false);
    });

    it("isWorkflowAgentActive reflects file presence", () => {
        expect(isWorkflowAgentActive("unknown-agent")).toBe(false);
        const handle = registerWorkflowAgents([
            {
                name: "sdd-spec-reviewer",
                markdown: "---\nname: sdd-spec-reviewer\n---\nbody",
            },
        ]);
        expect(isWorkflowAgentActive("sdd-spec-reviewer")).toBe(true);
        handle.dispose();
        expect(isWorkflowAgentActive("sdd-spec-reviewer")).toBe(false);
    });

    it("dispose is idempotent", () => {
        const handle = registerWorkflowAgents([
            {
                name: "sdd-worker",
                markdown: "---\nname: sdd-worker\n---\nbody",
            },
        ]);
        handle.dispose();
        handle.dispose();
        expect(isWorkflowAgentActive("sdd-worker")).toBe(false);
    });
});
