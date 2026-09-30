import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { syncGeneratedToolSettings } from "./generated-tool-settings.ts";

let root: string;
let agentDir: string;
let cwd: string;
let path: string;
beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "generated-tool-settings-"));
    agentDir = join(root, "agent");
    cwd = join(root, "project");
    mkdirSync(agentDir);
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    path = join(agentDir, "settings.json");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const compilation = {
    global: {
        reader: { tools: ["read", "grep"], sources: ["agentTools.reader"] },
    },
};
function sync() {
    return syncGeneratedToolSettings({
        agentDir,
        cwd,
        projectTrusted: true,
        compilation,
    });
}

test("owns only generated tools, preserves model/budget/unknown fields, and does not rewrite an unchanged snapshot", async () => {
    const retained = {
        model: "vendor/model",
        toolBudget: { hard: 17 },
        futureOption: { keep: true },
    };
    writeFileSync(
        path,
        JSON.stringify({
            unrelated: [1, 2],
            subagents: { agentOverrides: { reader: retained } },
        }),
        { mode: 0o640 },
    );
    expect(await sync()).toEqual({ changed: [path] });
    const settings = JSON.parse(readFileSync(path, "utf8"));
    expect(settings.subagents.agentOverrides.reader).toEqual({
        ...retained,
        tools: ["read", "grep"],
    });
    expect(settings.unrelated).toEqual([1, 2]);
    expect(settings.piSubagentsAddons.generatedToolOverrides.version).toBe(1);
    expect(
        settings.piSubagentsAddons.generatedToolOverrides.agents.reader,
    ).toMatchObject({ sources: ["agentTools.reader"], objectCreated: false });
    expect(statSync(path).mode & 0o777).toBe(0o640);
    const bytes = readFileSync(path, "utf8");
    const inode = statSync(path).ino;
    expect(await sync()).toEqual({ changed: [] });
    expect(readFileSync(path, "utf8")).toBe(bytes);
    expect(statSync(path).ino).toBe(inode);
});

test("removes deleted sources only when owned tools are unchanged, retaining later manual fields", async () => {
    const withCreated = {
        global: {
            ...compilation.global,
            temporary: { tools: ["find"], sources: ["agentTools.temporary"] },
        },
    };
    await syncGeneratedToolSettings({
        agentDir,
        cwd,
        projectTrusted: true,
        compilation: withCreated,
    });
    const settings = JSON.parse(readFileSync(path, "utf8"));
    settings.subagents.agentOverrides.reader.model = "vendor/later";
    writeFileSync(path, JSON.stringify(settings));
    await syncGeneratedToolSettings({
        agentDir,
        cwd,
        projectTrusted: true,
        compilation: { global: {} },
    });
    const cleaned = JSON.parse(readFileSync(path, "utf8"));
    expect(cleaned.subagents.agentOverrides.reader).toEqual({
        model: "vendor/later",
    });
    expect(cleaned.subagents.agentOverrides.temporary).toBeUndefined();
    expect(cleaned.piSubagentsAddons).toBeUndefined();
});

test.each(["update", "delete"])(
    "refuses manually edited owned tools during %s",
    async (action) => {
        await sync();
        const settings = JSON.parse(readFileSync(path, "utf8"));
        settings.subagents.agentOverrides.reader.tools = ["write"];
        const bytes = JSON.stringify(settings);
        writeFileSync(path, bytes);
        await expect(
            syncGeneratedToolSettings({
                agentDir,
                cwd,
                projectTrusted: true,
                compilation: action === "delete" ? { global: {} } : compilation,
            }),
        ).rejects.toThrow("Manual edit");
        expect(readFileSync(path, "utf8")).toBe(bytes);
        expect(existsSync(`${path}.lock`)).toBe(false);
    },
);

test("never adopts an unowned tools field even if it matches the proposed output", async () => {
    const bytes = JSON.stringify({
        subagents: { agentOverrides: { reader: { tools: ["read", "grep"] } } },
    });
    writeFileSync(path, bytes);
    await expect(sync()).rejects.toThrow("explicit adoption");
    expect(readFileSync(path, "utf8")).toBe(bytes);
});

test.each([
    "{",
    "[]",
    '{"subagents":null}',
    '{"piSubagentsAddons":{"generatedToolOverrides":{"version":99}}}',
])("malformed settings remain byte-identical: %s", async (bytes) => {
    writeFileSync(path, bytes);
    await expect(sync()).rejects.toThrow();
    expect(readFileSync(path, "utf8")).toBe(bytes);
    expect(existsSync(`${path}.lock`)).toBe(false);
});

test("refuses unreadable settings without replacing them", async () => {
    writeFileSync(path, "{}", { mode: 0 });
    try {
        await expect(sync()).rejects.toThrow("EACCES");
    } finally {
        chmodSync(path, 0o600);
    }
    expect(readFileSync(path, "utf8")).toBe("{}");
    expect(existsSync(`${path}.lock`)).toBe(false);
});

test("refuses a symlink settings target without touching its destination", async () => {
    const target = join(root, "outside.json");
    writeFileSync(target, "{}");
    symlinkSync(target, path);
    await expect(sync()).rejects.toThrow("symlink");
    expect(readFileSync(target, "utf8")).toBe("{}");
});

test("prepares both files before publishing and ignores untrusted project output", async () => {
    const projectPath = join(cwd, ".pi", "settings.json");
    const snapshot = {
        global: compilation.global,
        project: {
            reader: { tools: ["find"], sources: ["agentTools.reader"] },
        },
    };
    writeFileSync(path, "{}");
    const manual = JSON.stringify({
        subagents: { agentOverrides: { reader: { tools: ["write"] } } },
    });
    writeFileSync(projectPath, manual);
    await expect(
        syncGeneratedToolSettings({
            agentDir,
            cwd,
            projectTrusted: true,
            compilation: snapshot,
        }),
    ).rejects.toThrow("explicit adoption");
    expect(readFileSync(path, "utf8")).toBe("{}");
    expect(readFileSync(projectPath, "utf8")).toBe(manual);
    expect(
        await syncGeneratedToolSettings({
            agentDir,
            cwd,
            projectTrusted: false,
            compilation: snapshot,
        }),
    ).toEqual({ changed: [path] });
    expect(readFileSync(projectPath, "utf8")).toBe(manual);
    writeFileSync(projectPath, "{}");
    expect(
        await syncGeneratedToolSettings({
            agentDir,
            cwd,
            projectTrusted: true,
            compilation: snapshot,
        }),
    ).toEqual({ changed: [projectPath] });
    expect(
        JSON.parse(readFileSync(projectPath, "utf8")).subagents.agentOverrides
            .reader.tools,
    ).toEqual(["find"]);
    expect(
        JSON.parse(readFileSync(path, "utf8")).subagents.agentOverrides.reader
            .tools,
    ).toEqual(["read", "grep"]);
});

test("adopts only explicitly approved unchanged fields and rejects stale approvals", async () => {
    const bytes = JSON.stringify({
        subagents: {
            agentOverrides: {
                reader: { model: "vendor/preserved", tools: ["read", "grep"] },
            },
        },
    });
    writeFileSync(path, bytes);
    const adopt = { global: { reader: ["read", "grep"] } };
    await expect(
        syncGeneratedToolSettings({
            agentDir,
            cwd,
            projectTrusted: true,
            compilation,
            adopt,
        }),
    ).resolves.toEqual({ changed: [path] });
    expect(
        JSON.parse(readFileSync(path, "utf8")).subagents.agentOverrides.reader
            .model,
    ).toBe("vendor/preserved");
    writeFileSync(path, bytes.replace('"grep"', '"write"'));
    const changed = readFileSync(path, "utf8");
    await expect(
        syncGeneratedToolSettings({
            agentDir,
            cwd,
            projectTrusted: true,
            compilation,
            adopt,
        }),
    ).rejects.toThrow("adoption");
    expect(readFileSync(path, "utf8")).toBe(changed);
});

test("reports partial publication and retries idempotently after the second rename fails", async () => {
    const projectPath = join(cwd, ".pi", "settings.json");
    writeFileSync(path, "{}");
    writeFileSync(projectPath, "{}");
    const options = {
        agentDir,
        cwd,
        projectTrusted: true,
        compilation: {
            global: compilation.global,
            project: compilation.global,
        },
    };
    const rename = fs.renameSync;
    const failure = spyOn(fs, "renameSync").mockImplementation((from, to) => {
        if (to === projectPath) throw new Error("fixture rename failure");
        rename(from, to);
    });
    try {
        await expect(syncGeneratedToolSettings(options)).rejects.toThrow(
            `published files: ${path}`,
        );
        expect(readFileSync(projectPath, "utf8")).toBe("{}");
        expect(fs.readdirSync(join(cwd, ".pi"))).toEqual(["settings.json"]);
        expect(existsSync(`${path}.lock`)).toBe(false);
    } finally {
        failure.mockRestore();
    }
    expect(await syncGeneratedToolSettings(options)).toEqual({
        changed: [projectPath],
    });
});

test("retains publication and cleanup errors together while releasing locks", async () => {
    writeFileSync(path, "{}");
    const primary = new Error("fixture publication failure");
    const cleanup = new Error("fixture temporary cleanup failure");
    const renameFailure = spyOn(fs, "renameSync").mockImplementation(() => {
        throw primary;
    });
    const unlink = fs.unlinkSync;
    const unlinkFailure = spyOn(fs, "unlinkSync").mockImplementation(
        (target) => {
            if (String(target).endsWith(".tmp")) throw cleanup;
            unlink(target);
        },
    );
    try {
        const failure = await sync().catch((error) => error);
        expect(failure).toBeInstanceOf(AggregateError);
        expect(failure.errors).toEqual(
            expect.arrayContaining([primary, cleanup]),
        );
        expect(failure.message).toContain("published files: none");
        expect(readFileSync(path, "utf8")).toBe("{}");
        expect(existsSync(`${path}.lock`)).toBe(false);
    } finally {
        renameFailure.mockRestore();
        unlinkFailure.mockRestore();
    }
});

test("detects a noncooperative editor before rename without overwriting its update", async () => {
    writeFileSync(path, "{}");
    const write = fs.writeFileSync;
    const editor = spyOn(fs, "writeFileSync").mockImplementation(
        (target, data, options) => {
            write(target, data, options);
            if (String(target).endsWith(".tmp"))
                write(path, '{"defaultModel":"external-edit"}');
        },
    );
    try {
        await expect(sync()).rejects.toThrow("Concurrent settings edit");
        expect(readFileSync(path, "utf8")).toBe(
            '{"defaultModel":"external-edit"}',
        );
        expect(fs.readdirSync(agentDir)).toEqual(["settings.json"]);
    } finally {
        editor.mockRestore();
    }
});

test("creates .pi only for an approved cwd already marked by .agents, never an unrelated directory", async () => {
    rmSync(join(cwd, ".pi"), { recursive: true });
    mkdirSync(join(cwd, ".agents"));
    const options = {
        agentDir,
        cwd,
        projectTrusted: true,
        compilation: { global: {}, project: compilation.global },
    };
    const projectPath = join(cwd, ".pi", "settings.json");
    expect(await syncGeneratedToolSettings(options)).toEqual({
        changed: [projectPath],
    });
    rmSync(join(cwd, ".pi"), { recursive: true });
    rmSync(join(cwd, ".agents"), { recursive: true });
    await expect(syncGeneratedToolSettings(options)).rejects.toThrow(
        "project root",
    );
    expect(existsSync(join(cwd, ".pi"))).toBe(false);
});

test("malformed JSON diagnostics identify the file without exposing its contents", async () => {
    const sentinel = "fixture-sensitive-value";
    writeFileSync(path, `{"token":"${sentinel}", broken}`);
    let failure: unknown;
    try {
        await sync();
    } catch (error) {
        failure = error;
    }
    expect(String(failure)).toContain(path);
    expect(String(failure)).not.toContain(sentinel);
});

test("uses the conventional Pi lock with a bounded wait and never removes another writer's lock", async () => {
    writeFileSync(path, "{}");
    const release = await lockfile.lock(path, { realpath: false });
    try {
        await expect(sync()).rejects.toThrow("Lock file is already being held");
        expect(existsSync(`${path}.lock`)).toBe(true);
        expect(readFileSync(path, "utf8")).toBe("{}");
    } finally {
        await release();
    }
});

test("two Bun writers isolate projects while SettingsManager updates the shared model", async () => {
    const projectB = join(root, "project-b");
    mkdirSync(join(projectB, ".pi"), { recursive: true });
    writeFileSync(path, "{}");
    const writerModule = new URL(
        "./generated-tool-settings.ts",
        import.meta.url,
    ).href;
    const settingsModule = import.meta
        .resolve("@earendil-works/pi-coding-agent");
    const scripts = [cwd, projectB].map(
        (project, index) => `
        import { syncGeneratedToolSettings } from ${JSON.stringify(writerModule)};
        console.log("ready"); await Bun.stdin.text();
        for (let i=0; i<8; i++) await syncGeneratedToolSettings({agentDir:${JSON.stringify(agentDir)},cwd:${JSON.stringify(project)},projectTrusted:true,compilation:{global:${JSON.stringify(compilation.global)},project:{reader:{tools:[${JSON.stringify(index === 0 ? "grep" : "find")}],sources:["fixture"]}}}});
    `,
    );
    scripts.push(`
        import { SettingsManager } from ${JSON.stringify(settingsModule)};
        const manager = SettingsManager.create(${JSON.stringify(cwd)},${JSON.stringify(agentDir)});
        console.log("ready"); await Bun.stdin.text();
        for (let i=0; i<8; i++) { manager.setDefaultModel("model-"+i); await manager.flush(); }
        const errors = manager.drainErrors(); if (errors.length) throw new Error(JSON.stringify(errors));
    `);
    const children = scripts.map((code) => {
        const child = spawn(process.execPath, ["--eval", code], {
            env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
            stdio: ["pipe", "pipe", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
        });
        const done = new Promise<{ code: number | null; stderr: string }>(
            (resolve, reject) => {
                child.once("error", reject);
                child.once("close", (code) => resolve({ code, stderr }));
            },
        );
        const ready = new Promise<void>((resolve, reject) => {
            child.stdout.once("data", () => resolve());
            child.once("error", reject);
            child.once("close", (code) =>
                reject(
                    new Error(`Worker closed before ready: ${code} ${stderr}`),
                ),
            );
        });
        return { child, ready, done };
    });
    try {
        await Promise.all(children.map((child) => child.ready));
        for (const { child } of children) child.stdin.end("start");
        for (const result of await Promise.all(
            children.map((child) => child.done),
        ))
            expect(result).toEqual({ code: 0, stderr: "" });
        const settings = JSON.parse(readFileSync(path, "utf8"));
        expect(settings.defaultModel).toBe("model-7");
        expect(settings.subagents.agentOverrides.reader.tools).toEqual([
            "read",
            "grep",
        ]);
        expect(
            JSON.parse(readFileSync(join(cwd, ".pi", "settings.json"), "utf8"))
                .subagents.agentOverrides.reader.tools,
        ).toEqual(["grep"]);
        expect(
            JSON.parse(
                readFileSync(join(projectB, ".pi", "settings.json"), "utf8"),
            ).subagents.agentOverrides.reader.tools,
        ).toEqual(["find"]);
    } finally {
        for (const { child } of children)
            if (child.exitCode === null) child.kill();
        await Promise.allSettled(children.map((child) => child.done));
    }
}, 15_000);
