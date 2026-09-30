import { expect, test } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    createTestSession,
    type TestSession,
} from "@abdwhb-png/pi-test-harness";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
    collectWorkflowAgentDefinitions,
    createWorkflowAgentGate,
} from "../../_shared/subagents/workflow-agents.ts";
import {
    publicExtensionEntrypoint,
    publicExtensionEntrypoints,
} from "./public-extension-session.ts";

test("real Brainstorm and SDD factories publish before activation without changing visibility", async () => {
    const root = mkdtempSync(join(tmpdir(), "subagent-workflow-snapshots-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    let session: TestSession | undefined;
    let bus: ExtensionAPI["events"] | undefined;
    let gate: ReturnType<typeof createWorkflowAgentGate> | undefined;
    try {
        process.env.PI_CODING_AGENT_DIR = root;
        const cwd = join(root, "project");
        mkdirSync(cwd);
        const configPath = join(root, "addon.json");
        writeFileSync(
            configPath,
            JSON.stringify({
                toolGroupOverrides: {
                    enabled: true,
                    userAgentDirs: ["agents"],
                    projectAgentDirs: [],
                    agentTools: {},
                },
            }),
        );
        writeFileSync(
            join(root, "tool-groups.json"),
            JSON.stringify({
                groups: {
                    inspect: ["read"],
                    "lens-inspect": ["grep"],
                    lens: ["@lens-inspect"],
                    "lens-write": ["@lens"],
                    implement: ["write"],
                },
            }),
        );
        const { default: addon } = await import(
            publicExtensionEntrypoint("pi-subagents-addons")
        );
        session = await createTestSession({
            cwd,
            extensions: publicExtensionEntrypoints(
                "brainstorm-forcer",
                "sdd-orchestrator",
            ),
            extensionFactories: [
                (pi: ExtensionAPI) => {
                    bus = pi.events;
                    addon(pi, configPath);
                },
            ],
        });
        const definitions = collectWorkflowAgentDefinitions(bus!);
        expect(definitions.diagnostics).toEqual([]);
        expect(definitions.entries.map((entry) => entry.name)).toEqual(
            expect.arrayContaining([
                "brainstorm-scout",
                "sdd-worker",
                "sdd-qa-tester",
            ]),
        );
        const settingsPath = join(root, "settings.json");
        const bytes = readFileSync(settingsPath, "utf8");
        const overrides = JSON.parse(bytes).subagents.agentOverrides;
        expect(overrides["brainstorm-scout"].tools).toEqual(["read", "grep"]);
        expect(overrides["sdd-worker"].tools).toEqual([
            "read",
            "grep",
            "write",
        ]);
        for (const entry of definitions.entries)
            expect(existsSync(join(root, "agents", `${entry.name}.md`))).toBe(
                false,
            );
        gate = createWorkflowAgentGate(definitions.entries);
        gate.acquire();
        gate.acquire();
        expect(readFileSync(settingsPath, "utf8")).toBe(bytes);
        for (const entry of definitions.entries)
            expect(
                readFileSync(join(root, "agents", `${entry.name}.md`), "utf8"),
            ).toBe(entry.markdown);
        await session.session.reload();
        expect(readFileSync(settingsPath, "utf8")).toBe(bytes);
        expect(collectWorkflowAgentDefinitions(bus!).entries).toHaveLength(
            definitions.entries.length,
        );
        gate.release();
        expect(existsSync(join(root, "agents", "sdd-worker.md"))).toBe(true);
        gate.release();
        expect(existsSync(join(root, "agents", "sdd-worker.md"))).toBe(false);
        expect(readFileSync(settingsPath, "utf8")).toBe(bytes);
        await session.session.extensionRunner!.emit({
            type: "session_shutdown",
            reason: "reload",
        });
        expect(collectWorkflowAgentDefinitions(bus!)).toEqual({
            entries: [],
            diagnostics: [],
        });
    } finally {
        gate?.release();
        gate?.release();
        session?.dispose();
        if (previousAgentDir === undefined)
            delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        rmSync(root, { recursive: true, force: true });
    }
});
