import {
    afterEach,
    describe,
    expect,
    mock,
    test,
} from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
    openSync,
    closeSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { manageInstallations } from "./installation-ui.ts";
import { sandboxConfigPath } from "./authority.ts";

type ConfirmStep = boolean | (() => boolean | Promise<boolean>);

interface MockScript {
    select?: string[];
    input?: string[];
    editor?: string[];
    confirm?: ConfirmStep[];
}

interface UiHarness {
    notifications: string[];
    ctx: ExtensionCommandContext;
    confirmMessages: string[];
    selectionMessages: string[];
}

const fixtureRoots: string[] = [];

afterEach(() => {
    for (const root of fixtureRoots.splice(0)) {
        if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    }
});

function fixture() {
    const root = mkdtempSync(join(tmpdir(), "pi-sandbox-installation-ui-"));
    fixtureRoots.push(root);
    const agentDir = join(root, "agent");
    const projectDir = join(root, "project");
    const globalPath = sandboxConfigPath(agentDir);
    const projectPath = join(projectDir, ".pi", "sandbox.json");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(join(projectDir, ".pi"), { recursive: true });

    const writeGlobal = (value: unknown) =>
        writeFileSync(globalPath, JSON.stringify(value), { mode: 0o600 });
    const writeProject = (value: unknown) =>
        writeFileSync(projectPath, JSON.stringify(value), { mode: 0o600 });

    return {
        root,
        agentDir,
        projectDir,
        globalPath,
        projectPath,
        writeGlobal,
        writeProject,
        readGlobal: () => readFileSync(globalPath, "utf8"),
        readProject: () => readFileSync(projectPath, "utf8"),
    };
}

function createContext(
    cwd: string,
    script: MockScript = {},
    isProjectTrusted = true,
): UiHarness {
    const selections = [...(script.select ?? [])];
    const inputs = [...(script.input ?? [])];
    const editors = [...(script.editor ?? [])];
    const confirms = [...(script.confirm ?? [])];

    const notifications: string[] = [];

    const confirmMessages: string[] = [];
    const selectionMessages:string[]=[];
    const ctx = {
        cwd,
        hasUI: true,
        isProjectTrusted: () => isProjectTrusted,
        ui: {
            notify: mock((value: string) => {
                notifications.push(value);
            }),
            select: mock(async (message:string) => {selectionMessages.push(message);return selections.shift();}),
            input: mock(async () => inputs.shift()),
            editor: mock(async () => editors.shift()),
            confirm: mock(async (title: string, value?: string) => {
                confirmMessages.push(value ?? title);
                const next = confirms.shift();
                if (next === undefined) return false;
                return typeof next === "function" ? Boolean(await next()) : next;
            }),
        },
    } as unknown as ExtensionCommandContext;

    return { notifications, confirmMessages, selectionMessages, ctx };
}

describe("manageInstallations", () => {
    test("shows inherited installation order and previews full command paths before project selection",async()=>{
        const f=fixture();
        for(const name of ["second","first"])mkdirSync(join(f.root,name,"bin"),{recursive:true});
        f.writeGlobal({version:2,machineId:"m1",environment:{installations:{second:[{root:join(f.root,"second"),path:["bin"]}],first:[{root:join(f.root,"first"),path:["bin"]}]}}});
        const ui=createContext(f.projectDir,{select:["Project: Select"],input:["first"],confirm:[true]});
        await manageInstallations(ui.ctx,{agentDir:f.agentDir,machineId:"m1",onChanged:async()=>{}});
        expect(ui.selectionMessages[0]).toContain("inherit (second, first)");
        expect(ui.confirmMessages[0]).toContain(join(f.root,"first","bin"));
        expect(ui.confirmMessages[0]).toContain("read-only");
        expect(JSON.parse(f.readProject()).environment.installations).toEqual(["first"]);
    });
    test("publishes the complete authorized config atomically and validates command directories first", async()=>{
        const f=fixture();mkdirSync(join(f.root,"tools/bin"),{recursive:true});
        f.writeGlobal({version:2,machineId:"m1",environment:{}});
        const original=f.readGlobal();const fd=openSync(f.globalPath,"r");
        const added=createContext(f.projectDir,{select:["Global: Add"],input:["tools"],editor:[JSON.stringify([{root:join(f.root,"tools"),path:["bin"]}])],confirm:[true]});
        try {
            await manageInstallations(added.ctx,{agentDir:f.agentDir,machineId:"m1",onChanged:async()=>{}});
            expect(readFileSync(fd,"utf8")).toBe(original);
            expect(f.readGlobal()).toContain('"tools"');
        } finally {closeSync(fd);}
        const before=f.readGlobal();const onChanged=mock(async()=>{});
        const invalid=createContext(f.projectDir,{select:["Global: Add"],input:["missing"],editor:[JSON.stringify([{root:join(f.root,"tools"),path:["missing"]}])],confirm:[true]});
        await manageInstallations(invalid.ctx,{agentDir:f.agentDir,machineId:"m1",onChanged});
        expect(f.readGlobal()).toBe(before);expect(onChanged).not.toHaveBeenCalled();
        expect(invalid.notifications.join("\n")).toContain("command directory is unavailable");
    });
    test("non-interactive context reports usage and does not mutate", async () => {
        const f = fixture();
        f.writeGlobal({ version: 2, machineId: "m1", environment: {} });

        const ctx = {
            cwd: f.projectDir,
            hasUI: false,
            isProjectTrusted: () => true,
            ui: { notify: mock(() => {}) },
        } as unknown as ExtensionCommandContext;

        const onChanged = mock(async () => {
            throw new Error("onChanged must not run");
        });

        await manageInstallations(ctx, {
            agentDir: f.agentDir,
            machineId: "m1",
            onChanged,
        });

        expect(onChanged).not.toHaveBeenCalled();
        expect(f.readGlobal()).toBe(JSON.stringify({ version: 2, machineId: "m1", environment: {} }));
    });

    test("cancel keeps files unchanged and does not call onChanged", async () => {
        const f = fixture();
        f.writeGlobal({ version: 2, machineId: "m1", environment: { installations: {} } });
        const original = readFileSync(f.globalPath);

        const { ctx } = createContext(f.projectDir, {
            select: ["Cancel"],
        });

        const onChanged = mock(async () => {
            throw new Error("onChanged must not run");
        });
        await manageInstallations(ctx, {
            agentDir: f.agentDir,
            machineId: "m1",
            onChanged,
        });

        expect(readFileSync(f.globalPath)).toEqual(original);
        expect(onChanged).not.toHaveBeenCalled();
    });

    test("adds one global authorization with canonical preview and home-relative persistence", async () => {
        const f = fixture();

        const homeTools = mkdtempSync(join(homedir(), "pi-sandbox-ui-tools-"));
        fixtureRoots.push(homeTools);
        const linkTarget = join(homeTools, "bin");
        mkdirSync(linkTarget, { recursive: true });
        const installationAlias = homeTools.slice(homedir().length + 1).replaceAll("\\", "/");
        const relativeToHome = `~/${installationAlias}`;

        f.writeGlobal({ version: 2, machineId: "m1", environment: {} });

        const { ctx, confirmMessages } = createContext(
            f.projectDir,
            {
                select: ["Global: Add"],
                input: ["tools"],
                editor: [JSON.stringify([{ root: relativeToHome, path: ["bin"] }], null, 2)],
                confirm: [true],
            },
        );

        const onChanged = mock(async () => {});
        await manageInstallations(ctx, {
            agentDir: f.agentDir,
            machineId: "m1",
            onChanged,
        });

        const saved = JSON.parse(f.readGlobal()) as {
            version: number;
            machineId: string;
            environment: { installations: Record<string, { root: string; path: string[] }[]> };
        };

        expect(saved.version).toBe(2);
        expect(saved.machineId).toBe("m1");
        expect(saved.environment?.installations?.tools).toEqual([
            {
                root: relativeToHome,
                path: ["bin"],
            },
        ]);
        expect(confirmMessages[0] ?? "").toContain("Preview canonical paths:");
        expect(onChanged).toHaveBeenCalledTimes(1);
    });

    test("project file with inline installation roots is rejected before writing", async () => {
        const f = fixture();
        f.writeGlobal({ version: 2, machineId: "m1", environment: {} });
        f.writeProject({
            environment: {
                installations: {
                    tools: [{ root: f.globalPath, path: ["bin"] }],
                },
            },
        });
        const before = readFileSync(f.projectPath);

        const { ctx } = createContext(f.projectDir, {
            select: ["Project: Select"],
        });

        const onChanged = mock(async () => {
            throw new Error("onChanged must not run");
        });
        await manageInstallations(ctx, {
            agentDir: f.agentDir,
            machineId: "m1",
            onChanged,
        });

        expect(readFileSync(f.projectPath)).toEqual(before);
        expect(onChanged).not.toHaveBeenCalled();
    });

    test("stale preview is rejected and avoids overwrite", async () => {
        const f = fixture();
        const tools = mkdtempSync(join(homedir(), "pi-sandbox-tools-"));
        fixtureRoots.push(tools);
        mkdirSync(join(tools, "bin"), { recursive: true });
        const toolAlias = tools.slice(homedir().length + 1).replaceAll("\\", "/");

        f.writeGlobal({ version: 2, machineId: "m1", environment: {} });

        const { ctx, notifications } = createContext(
            f.projectDir,
            {
                select: ["Global: Add"],
                input: ["cli"],
                editor: [
                    JSON.stringify([{ root: `~/${toolAlias}` }], null, 2),
                ],
                confirm: [
                    async () => {
                        f.writeGlobal({
                            version: 2,
                            machineId: "m1",
                            environment: {
                                installations: {
                                    stale: [{ root: "/tmp", path: [] }],
                                },
                            },
                        });
                        return true;
                    },
                ],
            },
        );

        const onChanged = mock(async () => {});
        await manageInstallations(ctx, {
            agentDir: f.agentDir,
            machineId: "m1",
            onChanged,
        });

        const saved = JSON.parse(f.readGlobal()) as {
            environment: { installations: Record<string, unknown> };
        };

        expect(saved.environment.installations).toEqual({
            stale: [{ root: "/tmp", path: [] }],
        });
        expect(onChanged).not.toHaveBeenCalled();
        expect(notifications.join("\n")).toContain("Configuration changed while editing:");
    });

    test("revoke and project none keep unrelated fields", async () => {
        const f = fixture();
        const tools = mkdtempSync(join(tmpdir(), "pi-sandbox-tools2-"));
        fixtureRoots.push(tools);
        const extra = mkdtempSync(join(tmpdir(), "pi-sandbox-extra-"));
        fixtureRoots.push(extra);
        f.writeGlobal({
            $schema: "https://example.com/schema",
            version: 2,
            machineId: "m1",
            mode: "sandbox",
            environment: {
                path: ["/legacy/bin"],
                installations: {
                    tools: [{ root: join(tools, "tool"), path: ["bin"] }],
                    other: [{ root: join(extra, "entry"), path: ["cmd"] }],
                },
            },
        });
        f.writeProject({
            filesystem: { allowRead: ["."] },
            environment: { path: ["/project/bin"] },
        });

        const revoke = createContext(f.projectDir, {
            select: ["Global: Revoke", "other"],
            confirm: [true],
        });
        const onChanged = mock(async () => {});

        await manageInstallations(revoke.ctx, {
            agentDir: f.agentDir,
            machineId: "m1",
            onChanged,
        });

        const globalAfter = JSON.parse(f.readGlobal()) as {
            $schema?: string;
            version: number;
            machineId: string;
            mode: string;
            environment: { path: string[]; installations: Record<string, unknown> };
        };
        expect(globalAfter.$schema).toBe("https://example.com/schema");
        expect(globalAfter.version).toBe(2);
        expect(globalAfter.machineId).toBe("m1");
        expect(globalAfter.mode).toBe("sandbox");
        expect(globalAfter.environment.path).toEqual(["/legacy/bin"]);
        expect(globalAfter.environment.installations).toEqual({
            tools: [{ root: join(tools, "tool"), path: ["bin"] }],
        });

        const narrow = createContext(f.projectDir, {
            select: ["Project: None"],
            confirm: [true],
        });
        await manageInstallations(narrow.ctx, {
            agentDir: f.agentDir,
            machineId: "m1",
            onChanged,
        });

        const projectAfter = JSON.parse(f.readProject()) as {
            filesystem: { allowRead: string[] };
            environment: { path: string[]; installations: string[] };
        };
        expect(projectAfter.filesystem).toEqual({ allowRead: ["."] });
        expect(projectAfter.environment.path).toEqual(["/project/bin"]);
        expect(projectAfter.environment.installations).toEqual([]);
    });
});

test("file selections are previewed and persisted without authorizing the containing directory", async () => {
    const f = fixture();
    const directory = join(f.root, "commands");
    mkdirSync(directory);
    writeFileSync(join(directory, "tool"), "tool");
    f.writeGlobal({ version: 2, machineId: "m1", environment: {} });
    const ui = createContext(f.projectDir, { select: ["Global: Add"], input: ["local"],
        editor: [JSON.stringify([{ root: directory, files: ["tool"], path: ["."] }])], confirm: [true] });
    await manageInstallations(ui.ctx, { agentDir: f.agentDir, machineId: "m1", onChanged: async () => {} });
    expect(ui.notifications).toEqual([]);
    expect(ui.confirmMessages[0]).toContain(`${join(directory, "tool")} (read-only file)`);
    expect(ui.confirmMessages[0]).not.toContain(`${directory} (read-only)`);
    expect(JSON.parse(f.readGlobal()).environment.installations.local).toEqual([{ root: directory, path: ["."], files: ["tool"] }]);
});
