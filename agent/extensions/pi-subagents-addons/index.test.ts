import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
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
    says,
    when,
    type TestSession,
} from "@abdwhb-png/pi-test-harness";
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
        join(agentDir, "tool-groups.json"),
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

test("startup and reload publish snapshots while ordinary turns do not", async () => {
    const running = await start();
    const settingsPath = join(agentDir, "settings.json");
    expect(existsSync(settingsPath)).toBe(true);
    const snapshot = readFileSync(settingsPath, "utf8");
    expect(JSON.parse(snapshot).subagents.agentOverrides.reader.tools).toEqual([
        "read",
        "grep",
    ]);
    writeFileSync(
        join(agentDir, "tool-groups.json"),
        JSON.stringify({ groups: { inspect: ["ls"] } }),
    );
    await running.run(when("Read snapshot only", [says("unchanged")]));
    expect(readFileSync(settingsPath, "utf8")).toBe(snapshot);
    await running.session.extensionRunner!.emit({
        type: "session_start",
        reason: "reload",
    });
    expect(
        JSON.parse(readFileSync(settingsPath, "utf8")).subagents.agentOverrides
            .reader.tools,
    ).toEqual(["ls"]);
    expect(
        resolveSubagentCapabilityCeiling(
            running.session.sessionManager.getSessionId(),
        ),
    ).toBeUndefined();
});

test.each([
    "{",
    JSON.stringify({
        toolGroupOverrides: { enabled: true, userAgentDirs: 42 },
    }),
])(
    "invalid addon config %s keeps a public denial ceiling until a successful reload",
    async (invalid) => {
        writeFileSync(configPath, invalid);
        const running = await start();
        const id = running.session.sessionManager.getSessionId();
        expect(resolveSubagentCapabilityCeiling(id)?.allowedAgents).toEqual([]);
        expect(existsSync(join(agentDir, "settings.json"))).toBe(false);
        expect(
            running.events
                .uiCallsFor("notify")
                .some((call) => JSON.stringify(call).includes("blocked")),
        ).toBe(true);
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
        await running.session.extensionRunner!.emit({
            type: "session_start",
            reason: "reload",
        });
        expect(resolveSubagentCapabilityCeiling(id)).toBeUndefined();
        expect(existsSync(join(agentDir, "settings.json"))).toBe(true);
    },
);

test("failed recompilation retains last snapshot, blocks launches, and releases its ceiling on shutdown", async () => {
    const running = await start();
    const settingsPath = join(agentDir, "settings.json");
    const snapshot = readFileSync(settingsPath, "utf8");
    writeFileSync(
        join(agentDir, "tool-groups.json"),
        JSON.stringify({ groups: { inspect: ["@missing"] } }),
    );
    await running.session.extensionRunner!.emit({
        type: "session_start",
        reason: "reload",
    });
    const id = running.session.sessionManager.getSessionId();
    expect(resolveSubagentCapabilityCeiling(id)?.allowedAgents).toEqual([]);
    expect(readFileSync(settingsPath, "utf8")).toBe(snapshot);
    await running.session.extensionRunner!.emit({
        type: "session_shutdown",
        reason: "new",
    });
    expect(resolveSubagentCapabilityCeiling(id)).toBeUndefined();
});

test("partial settings publication keeps the session blocked until reload repairs the remaining file", async () => {
    mkdirSync(join(cwd, ".pi"));
    const projectPath = join(cwd, ".pi", "settings.json");
    writeFileSync(projectPath, "{}");
    const rename = fs.renameSync;
    const failure = spyOn(fs, "renameSync").mockImplementation((from, to) => {
        if (to === projectPath)
            throw new Error("fixture project publication failed");
        rename(from, to);
    });
    try {
        const running = await start();
        const id = running.session.sessionManager.getSessionId();
        expect(resolveSubagentCapabilityCeiling(id)?.allowedAgents).toEqual([]);
        expect(
            JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))
                .subagents.agentOverrides.reader.tools,
        ).toEqual(["read", "grep"]);
        expect(readFileSync(projectPath, "utf8")).toBe("{}");
        expect(
            running.events
                .uiCallsFor("notify")
                .some((call) =>
                    JSON.stringify(call).includes("published files:"),
                ),
        ).toBe(true);
    } finally {
        failure.mockRestore();
    }
    await session!.session.extensionRunner!.emit({
        type: "session_start",
        reason: "reload",
    });
    expect(
        resolveSubagentCapabilityCeiling(
            session!.session.sessionManager.getSessionId(),
        ),
    ).toBeUndefined();
    expect(
        JSON.parse(readFileSync(projectPath, "utf8")).subagents.agentOverrides
            .reader.tools,
    ).toEqual(["read", "grep"]);
});

test("untrusted project bytes are ignored until trusted reload", async () => {
    const running = await start();
    running.session.settingsManager.setProjectTrusted(false);
    mkdirSync(join(cwd, ".pi"));
    const projectPath = join(cwd, ".pi", "settings.json");
    writeFileSync(projectPath, "{");
    const id = running.session.sessionManager.getSessionId();
    await running.session.extensionRunner!.emit({
        type: "session_start",
        reason: "reload",
    });
    expect(resolveSubagentCapabilityCeiling(id)).toBeUndefined();
    expect(readFileSync(projectPath, "utf8")).toBe("{");
    running.session.settingsManager.setProjectTrusted(true);
    await running.session.extensionRunner!.emit({
        type: "session_start",
        reason: "reload",
    });
    expect(resolveSubagentCapabilityCeiling(id)?.allowedAgents).toEqual([]);
    expect(readFileSync(projectPath, "utf8")).toBe("{");
    writeFileSync(
        projectPath,
        JSON.stringify({ toolGroups: { groups: { inspect: ["ls"] } } }),
    );
    await running.session.extensionRunner!.emit({
        type: "session_start",
        reason: "reload",
    });
    expect(resolveSubagentCapabilityCeiling(id)).toBeUndefined();
    expect(
        JSON.parse(readFileSync(projectPath, "utf8")).subagents.agentOverrides
            .reader.tools,
    ).toEqual(["ls"]);
    expect(
        JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))
            .subagents.agentOverrides.reader.tools,
    ).toEqual(["read", "grep"]);
});

test("child marker skips snapshot writes and denial registration", async () => {
    const previous = process.env.PI_SUBAGENT_CHILD;
    try {
        process.env.PI_SUBAGENT_CHILD = "1";
        const running = await start();
        expect(existsSync(join(agentDir, "settings.json"))).toBe(false);
        expect(
            resolveSubagentCapabilityCeiling(
                running.session.sessionManager.getSessionId(),
            ),
        ).toBeUndefined();
    } finally {
        if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD;
        else process.env.PI_SUBAGENT_CHILD = previous;
    }
});

test("disabled generation leaves prior overrides and optional tools untouched", async () => {
    writeFileSync(
        configPath,
        JSON.stringify({ toolGroupOverrides: { enabled: false } }),
    );
    const settingsPath = join(agentDir, "settings.json");
    const bytes = JSON.stringify({
        subagents: {
            agentOverrides: { reader: { tools: ["read"], model: "p/m" } },
        },
    });
    writeFileSync(settingsPath, bytes);
    const running = await start();
    expect(readFileSync(settingsPath, "utf8")).toBe(bytes);
    expect(
        running.session.getAllTools().map((tool) => tool.name),
    ).not.toContain("subagents_overview");
    expect(
        resolveSubagentCapabilityCeiling(
            running.session.sessionManager.getSessionId(),
        ),
    ).toBeUndefined();
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
