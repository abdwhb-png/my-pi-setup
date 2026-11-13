import { afterEach, expect, test } from "bun:test";
import { createTestSession, type TestSession } from "@abdwhb-png/pi-test-harness";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useIsolatedAgentDir } from "../_shared/testing/config-fixture.ts";
import { prepareLaunchProfile } from "../_shared/launch-profiles.ts";

const agentDir = useIsolatedAgentDir();
let t: TestSession | undefined;
afterEach(async () => { await t?.close(); t = undefined; });
function setup() {
    const path = join(agentDir(), "config", "launch-profiles.json");
    mkdirSync(join(agentDir(), "config"), { recursive: true });
    const text = JSON.stringify({ profiles: { standard: { excludeExtensions: [] } } });
    writeFileSync(path, text);
    return { path, text };
}
async function session(editor: string | (() => string | undefined)) {
    t = await createTestSession({ extensions: [join(import.meta.dir, "index.ts")], mockUI: { editor } });
    return t;
}
test("editing profiles through the command changes the next launch without changing current tools", async () => {
    const { path } = setup();
    const next = { profiles: { custom: { description: "Custom exclusions", excludeExtensions: ["notify"] } } };
    const s = await session(JSON.stringify(next));
    const tools = s.session.getActiveToolNames();
    await s.session.prompt("/profiles edit");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(next);
    expect(prepareLaunchProfile(["--profile", "custom", "hello"], agentDir())).toEqual(["--exclude-extension", "notify", "hello"]);
    expect(s.session.getActiveToolNames()).toEqual(tools);
    await s.session.prompt("/profiles custom");
    expect(s.events.uiCallsFor("notify").at(-1)?.args[0]).toContain("pi --profile custom");
});
test("invalid edits preserve the previous configuration and report the error", async () => {
    const { path, text } = setup();
    const s = await session('{"profiles":{"bad":{"excludeExtensions":[false]}}}');
    await s.session.prompt("/profiles edit");
    expect(readFileSync(path, "utf8")).toBe(text);
    expect(s.events.uiCallsFor("notify").at(-1)?.args[1]).toBe("error");
});
test("cancelling the editor leaves configuration byte-identical", async () => {
    const { path, text } = setup();
    const s = await session(() => undefined);
    await s.session.prompt("/profiles edit");
    expect(readFileSync(path, "utf8")).toBe(text);
});
test("a concurrent configuration edit is preserved instead of overwritten", async () => {
    const { path } = setup();
    const concurrent = JSON.stringify({ profiles: { concurrent: { excludeExtensions: [] } } });
    const s = await session(() => { writeFileSync(path, concurrent); return '{"profiles":{}}'; });
    await s.session.prompt("/profiles edit");
    expect(readFileSync(path, "utf8")).toBe(concurrent);
    expect(s.events.uiCallsFor("notify").at(-1)?.args[1]).toBe("error");
});
