import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
    compileToolGroupOverrides,
    parseToolGroupOverridesConfig,
} from "./tool-group-overrides.ts";

let root: string;
let agentDir: string;
let cwd: string;
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "generated-agent-tools-"));
    agentDir = join(root, "agent");
    cwd = join(root, "project");
    mkdirSync(join(agentDir, "agents"), { recursive: true });
    mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function agent(directory: string, name: string, tools?: string) {
    const source = `---\nname: ${name}\ndescription: Fixture agent\n${tools === undefined ? "" : `tools: ${tools}\n`}---\nInspect.\n`;
    const path = join(directory, `${name}.md`);
    writeFileSync(path, source);
    return { path, source };
}
function groups(directory: string, definitions: Record<string, string[]>) {
    writeFileSync(
        join(directory, "tool-groups.json"),
        JSON.stringify({ groups: definitions }),
    );
}
function compile(
    overrides: Partial<Parameters<typeof compileToolGroupOverrides>[0]> = {},
) {
    const result = compileToolGroupOverrides({
        cwd,
        agentDir,
        projectTrusted: true,
        config: {
            enabled: true,
            userAgentDirs: ["agents"],
            projectAgentDirs: [".pi/agents"],
            agentTools: {},
        },
        ...overrides,
    });
    if (!result) throw new Error("Expected enabled compilation");
    return result;
}

test("compiles nested groups once, preserving order, MCP selectors and Markdown", () => {
    const file = agent(
        join(agentDir, "agents"),
        "reader",
        '"@review, read, mcp:fixture/echo"',
    );
    groups(agentDir, {
        inspect: ["read", "grep"],
        review: ["@inspect", "read", "child_only_tool"],
    });
    expect(compile().global.reader?.tools).toEqual([
        "read",
        "grep",
        "child_only_tool",
        "mcp:fixture/echo",
    ]);
    expect(readFileSync(file.path, "utf8")).toBe(file.source);
});

test("isolates global output while resolving per-project groups", () => {
    agent(join(agentDir, "agents"), "reader", '"@inspect"');
    groups(agentDir, { inspect: ["read"] });
    groups(join(cwd, ".pi"), { inspect: ["grep"] });
    const first = compile();
    expect(first.global.reader?.tools).toEqual(["read"]);
    expect(first.project?.reader?.tools).toEqual(["grep"]);
    groups(join(cwd, ".pi"), { inspect: ["find"] });
    const second = compile();
    expect(second.global).toEqual(first.global);
    expect(second.project?.reader?.tools).toEqual(["find"]);
    expect(compile({ projectTrusted: false })).toEqual({
        global: first.global,
    });
});

test("project declarations shadow global tools, while explicit mappings take priority", () => {
    agent(join(agentDir, "agents"), "reader", '"@inspect"');
    agent(join(cwd, ".pi", "agents"), "reader");
    groups(agentDir, { inspect: ["read"] });
    expect(compile().project?.reader?.tools).toBe("inherit");
    agent(join(cwd, ".pi", "agents"), "reader", '"grep"');
    expect(compile().project?.reader?.tools).toEqual(["grep"]);
    const mapped = compile({
        config: {
            enabled: true,
            userAgentDirs: ["agents"],
            projectAgentDirs: [".pi/agents"],
            agentTools: {
                reader: ["@inspect", "write_report"],
                worker: ["read"],
            },
        },
    });
    expect(mapped.global.reader?.tools).toEqual(["read", "write_report"]);
    expect(mapped.project?.reader?.tools).toEqual(["read", "write_report"]);
    expect(mapped.global.worker?.tools).toEqual(["read"]);
});

test("accepts block lists and ignores ordinary Markdown or concrete-only agents", () => {
    agent(join(agentDir, "agents"), "reader", '\n  - "@inspect"\n  - grep');
    agent(join(agentDir, "agents"), "concrete", '"read"');
    writeFileSync(
        join(agentDir, "agents", "notes.md"),
        "# Notes\nNot an agent.",
    );
    groups(agentDir, { inspect: ["read"] });
    expect(compile().global.reader?.tools).toEqual(["read", "grep"]);
    expect(compile().global.concrete).toBeUndefined();
});

test("scans only declared roots, tolerates absent optional roots and observes deletion", () => {
    groups(agentDir, { inspect: ["read"] });
    const file = agent(join(agentDir, "agents"), "reader", '"@inspect"');
    mkdirSync(join(agentDir, "agents", "nested"));
    agent(join(agentDir, "agents", "nested"), "nested", '"@inspect"');
    const config = {
        enabled: true,
        userAgentDirs: ["agents", "optional"],
        projectAgentDirs: [".pi/agents"],
        agentTools: {},
    };
    expect(Object.keys(compile({ config }).global)).toEqual(["reader"]);
    rmSync(file.path);
    expect(compile({ config }).global).toEqual({});
    expect(existsSync(join(agentDir, "optional"))).toBe(false);
    writeFileSync(join(agentDir, "optional"), "not a directory");
    expect(() => compile({ config })).toThrow("optional");
});

test("deduplicates identical realpaths but rejects distinct same-layer names", () => {
    const file = agent(join(agentDir, "agents"), "reader", '"@inspect"');
    groups(agentDir, { inspect: ["read"] });
    symlinkSync(file.path, join(agentDir, "agents", "alias.md"));
    expect(Object.keys(compile().global)).toEqual(["reader"]);
    writeFileSync(join(agentDir, "agents", "collision.md"), file.source);
    expect(() => compile()).toThrow("duplicate");
});

test("rejects escaping or broken Markdown symlinks instead of treating them as deletion", () => {
    const outside = agent(root, "outside", '"@inspect"');
    const link = join(agentDir, "agents", "outside.md");
    groups(agentDir, { inspect: ["read"] });
    symlinkSync(outside.path, link);
    expect(() => compile()).toThrow("outside.md");
    rmSync(outside.path);
    expect(() => compile()).toThrow("outside.md");
});

const invalidSelections: Array<{
    tools: string;
    definitions: Record<string, string[]>;
    error: string;
}> = [
    { tools: '"@absent"', definitions: {}, error: "Group not found" },
    { tools: '"@loop"', definitions: { loop: ["@loop"] }, error: "Cycle" },
    {
        tools: '"@inspect, read*"',
        definitions: { inspect: ["read"] },
        error: "wildcard",
    },
    {
        tools: '"@inspect"',
        definitions: { inspect: ["read?"] },
        error: "wildcard",
    },
    { tools: "42", definitions: {}, error: "tools" },
];
test.each(invalidSelections)(
    "fails closed on invalid selection: $tools",
    ({ tools, definitions, error }) => {
        agent(join(agentDir, "agents"), "reader", tools);
        groups(agentDir, definitions);
        expect(() => compile()).toThrow(error);
    },
);

test("reports malformed agent YAML and incomplete frontmatter with source path", () => {
    const path = join(agentDir, "agents", "broken.md");
    writeFileSync(
        path,
        "---\nname: broken\ndescription: Broken\ntools: [\n---\n",
    );
    expect(() => compile()).toThrow("broken.md");
    writeFileSync(path, '---\nname: broken\ntools: "@inspect"\n');
    expect(() => compile()).toThrow("broken.md");
});

test("compiles canonical package-qualified identity and rejects unsupported runners", () => {
    const path = join(agentDir, "agents", "reader.md");
    groups(agentDir, { inspect: ["read"] });
    writeFileSync(
        path,
        '---\nname: reader\npackage: my-package\ndescription: Fixture\ntools: "@inspect"\n---\n',
    );
    expect(compile().global["my-package.reader"]?.tools).toEqual(["read"]);
    writeFileSync(
        path,
        '---\nname: reader\ndescription: Fixture\ntools: "@inspect"\nrunner:\n  type: external-cli\n  command: fixture\n---\n',
    );
    expect(() => compile()).toThrow("runner");
});

test("disabled compiler reads nothing and creates no output for cleanup", () => {
    writeFileSync(
        join(agentDir, "agents", "broken.md"),
        "---\nname: x\ntools: [\n---\n",
    );
    expect(
        compileToolGroupOverrides({
            cwd,
            agentDir,
            projectTrusted: true,
            config: {
                enabled: false,
                userAgentDirs: ["agents"],
                projectAgentDirs: [".pi/agents"],
                agentTools: {},
            },
        }),
    ).toBeNull();
});

test.each([
    { agentScanDirs: ["extra"] },
    { agentExcludeDirs: ["agents"] },
    { projectRootResolution: "git-root" },
    { agentOverridesByProvider: { vendor: { reader: { tools: ["write"] } } } },
])(
    "rejects unsupported upstream discovery or provider selection: %j",
    (subagents) => {
        writeFileSync(
            join(agentDir, "settings.json"),
            JSON.stringify({ subagents }),
        );
        expect(() => compile()).toThrow("Unsupported subagents");
    },
);

test("rejects extra-agent environment discovery and restores environment", () => {
    const previous = process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
    try {
        process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = join(root, "extra");
        expect(() => compile()).toThrow("PI_SUBAGENT_EXTRA_AGENT_DIRS");
    } finally {
        if (previous === undefined)
            delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
        else process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = previous;
    }
});

test("refuses implicit ancestor project selection without creating nested .pi", () => {
    const nested = join(cwd, "nested");
    mkdirSync(nested);
    expect(() => compile({ cwd: nested })).toThrow("project root");
    expect(existsSync(join(nested, ".pi"))).toBe(false);
});

test("detects ancestor git-root policy even when cwd has project markers", () => {
    mkdirSync(join(root, ".pi"));
    writeFileSync(
        join(root, ".pi", "settings.json"),
        JSON.stringify({ subagents: { projectRootResolution: "git-root" } }),
    );
    expect(() => compile()).toThrow("projectRootResolution");
});

test("ignores all project sources without a local or ancestor project marker", () => {
    rmSync(join(cwd, ".pi"), { recursive: true });
    groups(agentDir, { inspect: ["read"] });
    agent(join(agentDir, "agents"), "reader", '"@inspect"');
    expect(compile().project).toBeUndefined();
    expect(existsSync(join(cwd, ".pi"))).toBe(false);
});

test("home is never a project and untrusted configuration is never read", () => {
    groups(agentDir, { inspect: ["read"] });
    agent(join(agentDir, "agents"), "reader", '"@inspect"');
    expect(compile({ cwd: homedir() }).project).toBeUndefined();
    writeFileSync(join(cwd, ".pi", "settings.json"), "{");
    writeFileSync(
        join(cwd, ".pi", "agents", "broken.md"),
        "---\nname: x\ntools: [\n---\n",
    );
    expect(compile({ projectTrusted: false }).global.reader?.tools).toEqual([
        "read",
    ]);
    expect(() => compile()).toThrow("settings.json");
});

test("rejects malformed settings objects but preserves unrelated settings bytes", () => {
    const path = join(agentDir, "settings.json");
    writeFileSync(path, "[]");
    expect(() => compile()).toThrow("settings.json");
    const contents = JSON.stringify({
        unknown: { retained: true },
        subagents: {
            agentOverridesByProvider: {
                vendor: { reader: { model: "vendor/model" } },
            },
        },
    });
    writeFileSync(path, contents);
    compile();
    expect(readFileSync(path, "utf8")).toBe(contents);
});

test("unreadable declared directory prevents a partial snapshot", () => {
    const directory = join(agentDir, "agents");
    agent(directory, "reader", '"@inspect"');
    try {
        chmodSync(directory, 0);
        expect(() => compile()).toThrow("EACCES");
    } finally {
        chmodSync(directory, 0o700);
    }
});

test("collects workflow templates before visibility and deduplicates matching active files", () => {
    groups(agentDir, { inspect: ["read"] });
    const source =
        '---\nname: flow\ndescription: Workflow fixture\ntools: "@inspect"\n---\n';
    const options = { workflowAgents: [{ name: "flow", markdown: source }] };
    expect(compile(options).global.flow?.tools).toEqual(["read"]);
    writeFileSync(join(agentDir, "agents", "flow.md"), source);
    expect(compile(options).global.flow?.tools).toEqual(["read"]);
    writeFileSync(
        join(agentDir, "agents", "flow.md"),
        source + "Divergent body.\n",
    );
    expect(() => compile(options)).toThrow("workflow");
});

test.skipIf(process.env.PI_SUBAGENTS_OFFICIAL_SMOKE !== "1")(
    "compiled snapshots satisfy official launch contracts",
    async () => {
        if (!process.env.PI_SUBAGENTS_COMPILER_HOME) {
            const home = join(root, "home");
            mkdirSync(home);
            const child = spawnSync(
                process.execPath,
                [
                    "test",
                    "--isolate",
                    import.meta.path,
                    "-t",
                    "compiled snapshots satisfy official launch contracts",
                ],
                {
                    env: {
                        ...process.env,
                        HOME: home,
                        PI_CODING_AGENT_DIR: join(home, "agent"),
                        PI_SUBAGENTS_COMPILER_HOME: home,
                        PI_SUBAGENT_EXTRA_AGENT_DIRS: "",
                        PI_OFFLINE: "1",
                    },
                    stdio: "inherit",
                    timeout: 30_000,
                },
            );
            if (child.error) throw child.error;
            expect(child.status).toBe(0);
            return;
        }
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        try {
            expect(homedir()).toBe(process.env.PI_SUBAGENTS_COMPILER_HOME!);
            process.env.PI_CODING_AGENT_DIR = agentDir;
            const { resolveSubagentLaunchContract } =
                await import("pi-subagents/preflight");
            const files = [
                agent(join(agentDir, "agents"), "quoted", '"@inspect, read"'),
                agent(
                    join(agentDir, "agents"),
                    "block",
                    '\n  - "@inspect"\n  - read',
                ),
                agent(join(cwd, ".pi", "agents"), "quoted", '"@inspect, read"'),
                agent(
                    join(cwd, ".pi", "agents"),
                    "block",
                    '\n  - "@inspect"\n  - read',
                ),
                agent(join(agentDir, "agents"), "shadow", '"@inspect"'),
                agent(join(cwd, ".pi", "agents"), "shadow"),
            ];
            const packaged = join(agentDir, "agents", "packaged.md");
            writeFileSync(
                packaged,
                '---\nname: packaged\npackage: fixture-kit\ndescription: Package fixture\nrunner:\n  type: pi\ntools: "@inspect"\n---\n',
            );
            groups(agentDir, { inspect: ["read", "grep"] });
            groups(join(cwd, ".pi"), { inspect: ["find"] });
            const snapshot = compile();
            for (const [directory, overrides] of [
                [agentDir, snapshot.global],
                [join(cwd, ".pi"), snapshot.project],
            ] as const) {
                writeFileSync(
                    join(directory, "settings.json"),
                    JSON.stringify({
                        subagents: { agentOverrides: overrides },
                    }),
                );
            }
            for (const name of ["quoted", "block"]) {
                for (const agentScope of ["user", "project", "both"] as const) {
                    const launch = await resolveSubagentLaunchContract({
                        agent: name,
                        cwd,
                        agentScope,
                        context: "fresh",
                        skill: false,
                        artifacts: false,
                        intercomBridge: { mode: "off" },
                    });
                    if (!launch.ok)
                        throw new Error(`${launch.code}: ${launch.message}`);
                    expect(launch.contract.protocol.packageVersion).toBe(
                        "0.73.1",
                    );
                    expect(launch.contract.tools.declaredBuiltin).toEqual(
                        agentScope === "user"
                            ? ["read", "grep"]
                            : ["find", "read"],
                    );
                }
            }
            const shadow = await resolveSubagentLaunchContract({
                agent: "shadow",
                cwd,
                context: "fresh",
                skill: false,
                artifacts: false,
                intercomBridge: { mode: "off" },
            });
            if (!shadow.ok) throw new Error(shadow.message);
            expect(shadow.contract.agent.source).toBe("project");
            expect(shadow.contract.tools.explicitAllowlist).toBe(false);
            const qualified = await resolveSubagentLaunchContract({
                agent: "fixture-kit.packaged",
                cwd,
                agentScope: "user",
                context: "fresh",
                skill: false,
                artifacts: false,
                intercomBridge: { mode: "off" },
            });
            if (!qualified.ok) throw new Error(qualified.message);
            expect(qualified.contract.tools.declaredBuiltin).toEqual([
                "read",
                "grep",
            ]);
            for (const file of files)
                expect(readFileSync(file.path, "utf8")).toBe(file.source);
        } finally {
            if (previousAgentDir === undefined)
                delete process.env.PI_CODING_AGENT_DIR;
            else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        }
    },
    35_000,
);

test("validates addon configuration and supplies only bounded directory defaults", () => {
    expect(parseToolGroupOverridesConfig(undefined).enabled).toBe(false);
    expect(parseToolGroupOverridesConfig({ enabled: true })).toEqual({
        enabled: true,
        userAgentDirs: ["agents", "~/.agents"],
        projectAgentDirs: [".pi/agents", ".agents"],
        agentTools: {},
    });
    for (const raw of [
        null,
        [],
        { enabled: "yes" },
        { enabled: true, userAgentDirs: [""] },
        { enabled: true, projectAgentDirs: ["../external"] },
        { enabled: true, projectAgentDirs: ["/absolute"] },
        { enabled: true, projectAgentDirs: ["..\\external"] },
        { enabled: true, agentTools: { reader: "@inspect" } },
        { enabled: true, agentTools: { reader: ["read*"] } },
        { enabled: true, agentTools: { reader: [] } },
    ])
        expect(() => parseToolGroupOverridesConfig(raw)).toThrow(
            "toolGroupOverrides",
        );
});
