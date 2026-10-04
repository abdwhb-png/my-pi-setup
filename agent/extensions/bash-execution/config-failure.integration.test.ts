import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calls, createTestSession, says, when, type TestSession } from "@abdwhb-png/pi-test-harness";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const roots: string[] = [];
const sessions: TestSession[] = [];
afterEach(() => {
    for (const session of sessions.splice(0)) session.dispose();
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test.each(["legacy", "retired-telemetry"])("blocks both shell tools after %s config failure until successful reload", async (kind) => {
    const root = mkdtempSync(join(tmpdir(), "bash-config-failure-"));
    roots.push(root);
    process.env.PI_CODING_AGENT_DIR = root;
    mkdirSync(join(root, "config"));
    const settings = join(root, "settings.json");
    const canonical = join(root, "config/bash-execution.json");
    writeFileSync(kind === "legacy" ? settings : canonical, JSON.stringify({ safeBash: { mode: "replace", ...(kind === "legacy" ? {} : { telemetry: { directory: "/retired" } }) } }));
    const session = await createTestSession({ cwd: root, extensions: [join(import.meta.dir, "index.ts")], mockTools: { bash: "stub", safe_bash: "stub" } });
    sessions.push(session);
    await session.run(when("Try shell tools", [calls("bash", { command: "printf marker" }), calls("safe_bash", { command: "printf marker" }), says("done")]));
    for (const tool of ["bash", "safe_bash"]) {
        expect(session.events.toolCallsFor(tool)[0]?.blocked).toBe(true);
        expect(session.events.toolResultsFor(tool)[0]?.text).toContain("configuration");
    }
    if (kind === "legacy") rmSync(settings);
    writeFileSync(canonical, JSON.stringify({ safeBash: { mode: "coexist" } }));
    await session.session.extensionRunner!.emit({ type: "session_start", reason: "reload" });
    await session.run(when("Try shell after repair", [calls("bash", { command: "printf marker" }), says("done")]));
    expect(session.events.toolCallsFor("bash").at(-1)?.blocked).toBe(false);
});
