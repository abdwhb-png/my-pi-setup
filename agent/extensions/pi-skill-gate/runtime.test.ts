import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    createTestSession,
    type TestSession,
} from "@abdwhb-png/pi-test-harness";
import {
    formatSkillsForPrompt,
    loadSkills,
    initTheme,
    type ExtensionAPI,
    type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
    ProcessTerminal,
    TuiMainScreen,
    stripTerminalSequences,
} from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { getThemeByName } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { isolateSkillHome } from "../_shared/testing/skill-home.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
    for (const dispose of cleanup.splice(0).reverse()) dispose();
});

test("editing yields the terminal and restores it after a failed editor", async () => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    const visual = process.env.VISUAL;
    cleanup.push(() => {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
        if (visual === undefined) delete process.env.VISUAL;
        else process.env.VISUAL = visual;
    });
    const root = mkdtempSync(join(tmpdir(), "skill-gate-editor-"));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    process.env.PI_CODING_AGENT_DIR = root;
    isolateSkillHome(root, cleanup);
    const skillPath = join(root, "skills/alpha/SKILL.md");
    mkdirSync(join(root, "skills/alpha"), { recursive: true });
    writeFileSync(
        skillPath,
        "---\nname: alpha\ndescription: Fixture\n---\nBody",
    );
    const editor = join(root, "fixture-editor");
    writeFileSync(editor, "#!/bin/sh\nexit 7\n", { mode: 0o700 });
    process.env.VISUAL = editor;
    const session = await createTestSession({
        cwd: root,
        extensions: [join(import.meta.dir, "index.ts")],
    });
    cleanup.push(() => session.dispose());
    initTheme();
    const theme = getThemeByName("dark");
    if (!theme) throw new Error("Built-in theme missing");
    const tui = new TuiMainScreen(new ProcessTerminal());
    const stop = spyOn(tui, "stop").mockImplementation(() => {});
    const start = spyOn(tui, "start").mockImplementation(() => {});
    const redraw = spyOn(tui, "requestRender").mockImplementation(() => {});
    cleanup.push(() => {
        stop.mockRestore();
        start.mockRestore();
        redraw.mockRestore();
    });
    let opens = 0;
    const custom: ExtensionUIContext["custom"] = async (factory) => {
        type Result = Parameters<Parameters<typeof factory>[3]>[0];
        let done!: (result: Result) => void;
        const result = new Promise<Result>((resolve) => {
            done = resolve;
        });
        const view = await factory(tui, theme, new KeybindingsManager(), done);
        opens++;
        view.handleInput?.(opens === 1 ? "o" : "\x1b");
        return result;
    };
    const ctx = session.session.extensionRunner.createCommandContext();
    session.session.extensionRunner.setUIContext({ ...ctx.ui, custom }, "tui");
    const command = session.session.extensionRunner
        .getRegisteredCommands()
        .find((command) => command.name === "skill-gate");
    if (!command) throw new Error("Command missing");
    await command.handler("", ctx);
    expect(opens).toBe(2);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop.mock.invocationCallOrder[0]).toBeLessThan(
        start.mock.invocationCallOrder[0]!,
    );
    expect(session.events.ui).toContainEqual(
        expect.objectContaining({
            method: "notify",
            args: expect.arrayContaining([
                expect.stringContaining("code 7"),
                "error",
            ]),
        }),
    );
});

test("skill discovery never initializes another extension set", async () => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    cleanup.push(() => {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
    });
    const root = mkdtempSync(join(tmpdir(), "skill-gate-runtime-"));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    process.env.PI_CODING_AGENT_DIR = root;
    isolateSkillHome(root, cleanup);
    const symbol = Symbol.for("pi-test.skill-gate-factory-count");
    const old = Reflect.get(globalThis, symbol);
    cleanup.push(() => {
        if (old === undefined) Reflect.deleteProperty(globalThis, symbol);
        else Reflect.set(globalThis, symbol, old);
    });
    Reflect.set(globalThis, symbol, 0);
    mkdirSync(join(root, "extensions"), { recursive: true });
    writeFileSync(
        join(root, "extensions/counter.ts"),
        'export default function () { const s = Symbol.for("pi-test.skill-gate-factory-count"); globalThis[s] = (globalThis[s] ?? 0) + 1; }',
    );
    let session: TestSession | undefined;
    cleanup.push(() => session?.dispose());
    session = await createTestSession({
        cwd: root,
        extensions: [join(import.meta.dir, "index.ts")],
    });
    expect(Reflect.get(globalThis, symbol)).toBe(1);
});

test("the registered command redraws and persists toggles through the original custom UI", async () => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    cleanup.push(() => {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
    });
    const root = mkdtempSync(join(tmpdir(), "skill-gate-ui-"));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    process.env.PI_CODING_AGENT_DIR = root;
    isolateSkillHome(root, cleanup);
    mkdirSync(join(root, "skills/alpha"), { recursive: true });
    writeFileSync(
        join(root, "skills/alpha/SKILL.md"),
        "---\nname: alpha\ndescription: Alpha fixture\n---\nAlpha body",
    );
    const session = await createTestSession({
        cwd: root,
        extensions: [join(import.meta.dir, "index.ts")],
    });
    cleanup.push(() => session.dispose());
    initTheme();
    const theme = getThemeByName("dark");
    if (!theme) throw new Error("Built-in theme missing");
    const tui = new TuiMainScreen(
        new (class extends ProcessTerminal {
            override get rows() {
                return 40;
            }
        })(),
    );
    const redraw = spyOn(tui, "requestRender").mockImplementation(() => {});
    cleanup.push(() => redraw.mockRestore());
    const ctx = session.session.extensionRunner.createCommandContext();
    const custom: ExtensionUIContext["custom"] = async (factory) => {
        type Result = Parameters<Parameters<typeof factory>[3]>[0];
        let done!: (result: Result) => void;
        const result = new Promise<Result>((resolve) => {
            done = resolve;
        });
        const view = await factory(tui, theme, new KeybindingsManager(), done);
        expect(
            view.render(80).map(stripTerminalSequences).join("\n"),
        ).toContain("Skill Gate");
        view.handleInput?.(" ");
        expect(
            view.render(80).map(stripTerminalSequences).join("\n"),
        ).toContain("disabled");
        expect(redraw).toHaveBeenCalled();
        view.handleInput?.("\x1b");
        return result;
    };
    session.session.extensionRunner.setUIContext({ ...ctx.ui, custom }, "tui");
    const command = session.session.extensionRunner
        .getRegisteredCommands()
        .find((command) => command.name === "skill-gate");
    if (!command) throw new Error("Command missing");
    await command.handler("", ctx);
    const { readFileSync } = await import("node:fs");
    expect(
        JSON.parse(readFileSync(join(root, "config/skill-gate.json"), "utf8")),
    ).toEqual({ skills: { alpha: "disabled" }, projects: {} });
});

test("filters the outgoing skill catalog without changing surrounding instructions", async () => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    cleanup.push(() => {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
    });
    const root = mkdtempSync(join(tmpdir(), "skill-gate-prompt-"));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    process.env.PI_CODING_AGENT_DIR = root;
    isolateSkillHome(root, cleanup);
    for (const [name, manual] of [
        ["visible", false],
        ["hidden", false],
        ["manual", true],
    ] as const) {
        const dir = join(root, "skills", name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
            join(dir, "SKILL.md"),
            `---\nname: ${name}\ndescription: Fixture skill\ndisable-model-invocation: ${manual}\n---\nBody`,
        );
    }
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(
        join(root, "config/skill-gate.json"),
        JSON.stringify({ skills: { hidden: "disabled" }, projects: {} }),
    );
    const skills = loadSkills({
        cwd: root,
        agentDir: root,
        includeDefaults: false,
        skillPaths: [join(root, "skills")],
    }).skills;
    const prompt = `ROLE_INSTRUCTIONS\n${formatSkillsForPrompt(skills)}\nSHELL_CONTEXT`;
    let discovered: string[] = [];
    const session = await createTestSession({
        cwd: root,
        extensions: [join(import.meta.dir, "index.ts")],
        extensionFactories: [
            (pi: ExtensionAPI) => {
                pi.on("session_start", () => {
                    discovered = pi
                        .getCommands()
                        .filter((command) => command.source === "skill")
                        .map((command) => command.name);
                });
            },
        ],
    });
    cleanup.push(() => session.dispose());
    expect(discovered.toSorted()).toEqual([
        "skill:hidden",
        "skill:manual",
        "skill:visible",
    ]);
    const input = {
        instructions: prompt,
        input: [{ role: "user", content: "user text" }],
        tools: [],
    };
    const output =
        await session.session.extensionRunner.emitBeforeProviderRequest(input);
    expect(session.events.ui).toEqual([]);
    const serialized = JSON.stringify(output);
    expect(serialized).toContain("<name>visible</name>");
    expect(serialized).not.toContain("<name>hidden</name>");
    expect(serialized).not.toContain("<name>manual</name>");
    expect(serialized).toContain("ROLE_INSTRUCTIONS");
    expect(serialized).toContain("SHELL_CONTEXT");
    expect(input.instructions).toContain("<name>hidden</name>");

    const unsupported = { messages: [{ role: "system", content: prompt }] };
    expect(
        await session.session.extensionRunner.emitBeforeProviderRequest(
            unsupported,
        ),
    ).toEqual(unsupported);
    expect(session.events.ui).toContainEqual(
        expect.objectContaining({
            method: "notify",
            args: expect.arrayContaining([
                expect.stringContaining("Skill visibility was not applied"),
                "warning",
            ]),
        }),
    );

    writeFileSync(join(root, "config/skill-gate.json"), "{broken");
    const recovered =
        await session.session.extensionRunner.emitBeforeProviderRequest(input);
    expect(JSON.stringify(recovered)).not.toContain("<name>hidden</name>");
    expect(session.events.ui).toContainEqual(
        expect.objectContaining({
            method: "notify",
            args: expect.arrayContaining([
                expect.stringContaining("configuration unavailable"),
                "error",
            ]),
        }),
    );
});
