import { afterEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
    SkillDetailOverlay,
    invalidateAllSkillBodies,
    readSkillBody,
} from "./overlay.ts";
import type { RowData, SkillGateTheme } from "./types.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
    invalidateAllSkillBodies();
    for (const dispose of cleanup.splice(0).reverse()) dispose();
});
const identity = (text: string) => text;
const colors: SkillGateTheme = {
    accent: identity,
    dim: identity,
    muted: identity,
    warning: identity,
    error: identity,
    bold: identity,
    enabled: identity,
    selCell: identity,
    selRow: identity,
    nativeDisabled: identity,
};
function fixture() {
    const previous = process.env.PI_CODING_AGENT_DIR;
    cleanup.push(() => {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
    });
    const dir = mkdtempSync(join(tmpdir(), "skill-overlay-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    process.env.PI_CODING_AGENT_DIR = dir;
    initTheme();
    const rows: RowData[] = ["alpha", "beta", "manual"].map((name, index) => {
        const path = join(dir, `${name}.md`);
        writeFileSync(
            path,
            `---\nname: ${name}\ndescription: ${name} description\n---\n# ${name} instructions\n${"Body line\n".repeat(50)}`,
        );
        return {
            name,
            description: `${name} description`,
            filePath: path,
            disableModelInvocation: index === 2,
            state: "enabled",
            source: "default",
            globalEnabled: true,
            usageCount: index + 1,
        };
    });
    const view = new SkillDetailOverlay(
        rows,
        0,
        () => 40,
        colors,
        "global",
        "fixture",
        true,
    );
    return { view, rows, dir };
}
const screen = (view: SkillDetailOverlay, width = 100) =>
    view.render(width).map(stripTerminalSequences).join("\n");

test("Kitty printable shortcuts keep the upstream usage column and help UI", () => {
    const { view } = fixture();
    expect(screen(view)).not.toContain("Uses");
    view.handleInput("\x1b[117u");
    expect(screen(view)).toContain("Uses");
    view.handleInput("\x1b[63u");
    expect(screen(view)).toContain("Skill Gate");
    expect(screen(view)).toContain("Switch global");
    view.handleInput("\x1b[27u");
    expect(screen(view)).not.toContain("Switch global");
});

for (const [down, enter, escape] of [
    ["\x1b[B", "\r", "\x1b"],
    ["\x1b[1;1B", "\x1b[13u", "\x1b[27u"],
])
    test(`navigation and invocation with ${enter === "\r" ? "legacy" : "Kitty"} keys`, () => {
        const { view } = fixture();
        const invoke = mock();
        const close = mock();
        view.onInvoke = invoke;
        view.onClose = close;
        view.handleInput(down!);
        view.handleInput(enter!);
        expect(invoke).toHaveBeenCalledWith("beta");
        view.handleInput(escape!);
        expect(close).toHaveBeenCalledTimes(1);
    });

test("search keeps filtered bulk actions behind confirmation", () => {
    const { view } = fixture();
    const enable = mock();
    view.onEnableAll = enable;
    view.handleInput("/");
    for (const char of "beta") view.handleInput(char);
    view.handleInput("\r");
    view.handleInput("a");
    expect(screen(view)).toContain("Confirm Enable All");
    expect(enable).not.toHaveBeenCalled();
    view.handleInput("\x1b");
    expect(enable).not.toHaveBeenCalled();
    view.handleInput("a");
    view.handleInput("\r");
    expect(enable).toHaveBeenCalledWith(["beta"]);
});

test("full-text search, disable-all and reset preserve confirmations and exclude manual-only skills", () => {
    const { view, rows } = fixture();
    writeFileSync(rows[1]!.filePath, "Unique body phrase");
    const disable = mock();
    const reset = mock();
    view.onDisableAll = disable;
    view.onResetScope = reset;
    view.handleInput("f");
    for (const char of "unique") view.handleInput(char);
    view.handleInput("\r");
    expect(screen(view)).toContain("Unique body phrase");
    view.handleInput("A");
    expect(disable).not.toHaveBeenCalled();
    view.handleInput("\x1b[13u");
    expect(disable).toHaveBeenCalledWith(["beta"]);
    view.handleInput("\x1b");
    view.handleInput("A");
    view.handleInput("\r");
    expect(disable).toHaveBeenLastCalledWith(["alpha", "beta"]);
    rows[0]!.source = "global";
    view.handleInput("r");
    expect(reset).not.toHaveBeenCalled();
    view.handleInput("n");
    expect(reset).not.toHaveBeenCalled();
    view.handleInput("r");
    view.handleInput("\r");
    expect(reset).toHaveBeenCalledTimes(1);
});

test("Kitty key releases do not toggle a skill or invoke it", () => {
    const { view } = fixture();
    const toggle = mock();
    const invoke = mock();
    view.onToggle = toggle;
    view.onInvoke = invoke;
    view.handleInput("\x1b[32;1:3u");
    view.handleInput("\x1b[13;1:3u");
    expect(toggle).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
});

test("manual-only skills stay invocable and cannot be toggled", () => {
    const { view, rows } = fixture();
    const toggle = mock();
    const invoke = mock();
    view.onToggle = toggle;
    view.onInvoke = invoke;
    view.handleInput("\x1b[B");
    view.handleInput("\x1b[B");
    view.handleInput(" ");
    view.handleInput("\r");
    expect(toggle).not.toHaveBeenCalled();
    expect(rows[2]?.state).toBe("enabled");
    expect(invoke).toHaveBeenCalledWith("manual");
});

test("preserves sidebar, scope controls, copy, editing and scrolling", () => {
    const { view, rows } = fixture();
    const yank = mock();
    const edit = mock();
    const scope = mock();
    view.onYank = yank;
    view.onEdit = edit;
    view.onScopeToggle = scope;
    const top = screen(view);
    view.handleInput("j");
    expect(screen(view)).not.toBe(top);
    view.handleInput("\x1b[H");
    expect(screen(view)).toBe(top);
    view.handleInput("y");
    expect(yank).toHaveBeenCalledWith(
        "alpha",
        expect.stringContaining("alpha instructions"),
    );
    view.handleInput("g");
    expect(scope).toHaveBeenCalledTimes(1);
    view.handleInput("o");
    expect(edit).toHaveBeenCalledWith("alpha", rows[0]?.filePath);
    expect(view.render(100).every((line) => visibleWidth(line) <= 100)).toBe(
        true,
    );
});

test("a missing skill file displays its actual error and can recover", () => {
    const { dir } = fixture();
    const path = join(dir, "missing.md");
    expect(readSkillBody(path)).toContain("ENOENT");
    writeFileSync(path, "Recovered instructions");
    expect(readSkillBody(path)).toBe("Recovered instructions");
});
