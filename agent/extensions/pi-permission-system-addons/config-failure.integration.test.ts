import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test.each(["legacy", "malformed"])("blocks tool execution on %s permission config until repaired and reloaded", async (kind) => {
    const root = mkdtempSync(join(tmpdir(), "permission-config-failure-"));
    roots.push(root);
    process.env.PI_CODING_AGENT_DIR = root;
    mkdirSync(join(root, "config"));
    const legacy = join(root, "pi-permission-system-addons.json");
    const canonical = join(root, "config/pi-permission-system-addons.json");
    writeFileSync(kind === "legacy" ? legacy : canonical,
        kind === "legacy" ? JSON.stringify({ inherit: { write: "write" } }) : "{broken");
    const session = await createTestSession({ cwd: root, extensions: [join(import.meta.dir, "index.ts")] });
    sessions.push(session);
    await session.run(when("Try writing with invalid permission configuration", [
        calls("write", { path: "blocked.txt", content: "must not execute" }), says("done"),
    ]));
    expect(session.events.toolResultsFor("write")[0]?.isError).toBe(true);
    expect(session.events.toolResultsFor("write")[0]?.text).toContain("configuration");
    expect(existsSync(join(root, "blocked.txt"))).toBe(false);

    if (kind === "legacy") rmSync(legacy);
    writeFileSync(canonical, JSON.stringify({ inherit: {} }));
    await session.session.extensionRunner!.emit({ type: "session_start", reason: "reload" });
    await session.run(when("Try writing after configuration repair", [
        calls("write", { path: "allowed.txt", content: "repaired" }), says("done"),
    ]));
    expect(existsSync(join(root, "allowed.txt"))).toBe(true);
});
