import { writeFixtureFile as writeFileSync } from "../_shared/testing/config-fixture.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,

} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    createTestSession,
    says,
    when,
    type TestSession,
} from "@abdwhb-png/pi-test-harness";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { resolveSubagentCapabilityCeiling } from "pi-subagents/capability-ceiling";
import registerSubagentsAddons, { readAddonsConfig } from "./index.ts";

let root: string;
let agentDir: string;
let cwd: string;
let configPath: string;
let session: TestSession | undefined;
let previousAgentDir: string | undefined;
beforeEach(() => {
    previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    root = mkdtempSync(join(tmpdir(), "subagents-addon-lifecycle-"));
    agentDir = join(root, "agent");
    cwd = join(root, "project");
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    mkdirSync(cwd);
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ packages:[fileURLToPath(new URL(".", import.meta.resolve("pi-subagents")))] }));
    new ProjectTrustStore(agentDir).set(cwd, true);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    configPath = join(root, "addon.json");
    writeFileSync(
        configPath,
        JSON.stringify({
            toolGroupOverrides: {
                enabled: true,
                userAgentDirs: ["agents"],
                projectAgentDirs: [".pi/agents"],
                agentTools: {},
            },
        }),
    );
    writeFileSync(
        join(agentDir, "config/tool-groups.json"),
        JSON.stringify({ groups: { inspect: ["read", "grep"] } }),
    );
    writeFileSync(
        join(agentDir, "agents", "reader.md"),
        '---\nname: reader\ndescription: Reader fixture\ntools: "@inspect"\n---\n',
    );
});
afterEach(async () => {
    try {
        if (session)
            await session.session.extensionRunner?.emit({
                type: "session_shutdown",
                reason: "quit",
            });
    } finally {
        session?.dispose();
        session = undefined;
        if (previousAgentDir === undefined)
            delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        rmSync(root, { recursive: true, force: true });
    }
});

async function start() {
    session = await createTestSession({
        cwd,
        extensionFactories: [(pi) => registerSubagentsAddons(pi, configPath)],
    });
    return session;
}

test("startup, reload and turns preserve settings byte for byte", async () => {
    const settingsPath = join(agentDir, "settings.json");
    const bytes = JSON.stringify({ subagents: { agentOverrides: { reader: { tools: ["read"], model: "p/m" } } } });
    writeFileSync(settingsPath, bytes);
    const running = await start();
    expect(readFileSync(settingsPath, "utf8")).toBe(bytes);
    await running.session.extensionRunner!.emit({ type: "session_start", reason: "reload" });
    await running.run(when("Inspect only", [says("unchanged")]));
    expect(readFileSync(settingsPath, "utf8")).toBe(bytes);
    expect(resolveSubagentCapabilityCeiling(running.session.sessionManager.getSessionId())).toBeUndefined();
});

test("startup does not create settings for alias declarations", async () => {
    await start();
    expect(existsSync(join(agentDir, "settings.json"))).toBe(false);
});

test("invalid addon configuration remains visible", async () => {
    writeFileSync(configPath, "{");
    const running = await start();
    expect(running.events.uiCallsFor("notify").length).toBeGreaterThan(0);
    expect(existsSync(join(agentDir, "settings.json"))).toBe(false);
});

test("preserves and validates fallback advice configuration", () => {
    writeFileSync(
        configPath,
        JSON.stringify({
            fallbackAdvice: {
                enabled: true,
                fallbackModels: { worker: ["p/second", "p/third"] },
            },
        }),
    );
    expect(
        readAddonsConfig(configPath).fallbackAdvice.fallbackModels.worker,
    ).toEqual(["p/second", "p/third"]);
    writeFileSync(
        configPath,
        JSON.stringify({
            fallbackAdvice: {
                enabled: true,
                fallbackModels: { worker: ["p/second", "p/second"] },
            },
        }),
    );
    expect(() => readAddonsConfig(configPath)).toThrow();
});
