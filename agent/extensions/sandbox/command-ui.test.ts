import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { rmSync } from "node:fs";
import {
    ProcessTerminal,
    TuiMainScreen,
    stripTerminalSequences,
    visibleWidth,
    type Component,
} from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { getThemeByName } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import {
    showSandboxDashboard,
    SANDBOX_SECTIONS,
    type SandboxSection,
    type SandboxDashboardSnapshot,
    type SandboxDashboardState,
} from "./command-ui.ts";
import type { SandboxDoctorInspection } from "./doctor.ts";
import { dashboardFixture } from "./testing/dashboard-fixture.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
    for (const dispose of cleanup.splice(0).reverse()) dispose();
});
function fixture(
    rows = 24,
    themeName = "dark",
    initial: SandboxDashboardState = { section: "Status" },
) {
    const data = dashboardFixture();
    cleanup.push(() => rmSync(data.root, { recursive: true, force: true }));
    let snapshot: SandboxDashboardSnapshot = data.snapshot;
    const terminal = new (class extends ProcessTerminal {
        override get rows() {
            return rows;
        }
    })();
    const tui = new TuiMainScreen(terminal);
    const redraw = spyOn(tui, "requestRender").mockImplementation(() => {});
    const theme = getThemeByName(themeName);
    if (!theme) throw new Error("Built-in theme missing");
    const fg = spyOn(theme, "fg");
    cleanup.push(() => fg.mockRestore());
    let ready!: (component: Component) => void;
    const opened = new Promise<Component>((resolve) => {
        ready = resolve;
    });
    let view: Component | undefined;
    cleanup.push(() => {
        view?.handleInput?.("\x1b");
        view?.handleInput?.("\x1b");
    });
    const inspect = mock(
        async (_executable?: string): Promise<SandboxDoctorInspection> =>
            data.report,
    );
    const closed = showSandboxDashboard(
        {
            mode: "tui",
            ui: {
                async custom(factory, options) {
                    if (typeof options?.overlayOptions === "function")
                        throw new Error("Expected static overlay options");
                    expect(options?.overlayOptions?.width).toBe(96);
                    type Result = Parameters<Parameters<typeof factory>[3]>[0];
                    let done!: (value: Result) => void;
                    const result = new Promise<Result>((resolve) => {
                        done = resolve;
                    });
                    view = await factory(
                        tui,
                        theme,
                        new KeybindingsManager(),
                        done,
                    );
                    ready(view);
                    return result;
                },
            },
        },
        { read: () => snapshot, inspect },
        initial,
    );
    return {
        data,
        opened,
        closed,
        inspect,
        redraw,
        fg,
        change: (next: SandboxDashboardSnapshot) => {
            snapshot = next;
        },
        resize: (value: number) => {
            rows = value;
        },
    };
}
const text = (view: Component, width = 80) =>
    view.render(width).map(stripTerminalSequences).join("\n");
function section(
    view: Component,
    name: SandboxSection,
    from: SandboxSection = "Status",
) {
    const names = SANDBOX_SECTIONS;
    view.handleInput?.("\x1b[D");
    for (
        let step = 0;
        step <
        (names.indexOf(name) - names.indexOf(from) + names.length) %
            names.length;
        step++
    )
        view.handleInput?.("\x1b[B");
    view.handleInput?.("\x1b[C");
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("sandbox dashboard", () => {
    it("keeps label and value styling separate in technical details", async () => {
        const f = fixture();
        const view = await f.opened;
        view.handleInput?.("\t");
        view.handleInput?.("\x1b[B");
        view.handleInput?.("\x1b[B");
        view.handleInput?.("\r");
        text(view);
        expect(f.fg).toHaveBeenCalledWith("muted", "Runtime: ");
        expect(f.fg).toHaveBeenCalledWith("text", "enabled");
    });
    it("uses section navigation beside content and colors labels separately", async () => {
        const f = fixture();
        const view = await f.opened;
        const screen = text(view);
        expect(screen).toContain("Sections");
        expect(screen).not.toContain("[Status]");
        expect(
            screen
                .split("\n")
                .some(
                    (line) =>
                        line.includes("Status") && line.includes("Shell mode:"),
                ),
        ).toBe(true);
        expect(f.fg).toHaveBeenCalledWith("muted", "Shell mode: ");
        expect(f.fg).toHaveBeenCalledWith("text", "Sandbox");
        view.handleInput?.("\x1b[B");
        expect(text(view)).toContain("Files:");
        view.handleInput?.("\t");
        view.handleInput?.("\r");
        expect(text(view)).toContain("Read access");
    });
    it("opens the complete action failure from the focused error item", async () => {
        const f = fixture();
        const view = await f.opened;
        const message = `Action refused: ${"reason ".repeat(20)}precise final cause`;
        f.change({ ...f.data.snapshot, actionProblem: message });
        view.handleInput?.("\x1b[C");
        view.handleInput?.("\x1b[B");
        view.handleInput?.("\r");
        text(view);
        view.handleInput?.("\x1b[A");
        view.handleInput?.("\r");
        expect(text(view)).toContain("precise final");
        expect(text(view)).toContain("cause");
        view.handleInput?.("\x1b");
        view.handleInput?.("\x1b");
        expect(await f.closed).toBeUndefined();
    });
    it("keeps a selected Doctor control focused when inspection finishes", async () => {
        const f = fixture();
        const view = await f.opened;
        let finish!: (report: SandboxDoctorInspection) => void;
        f.inspect.mockImplementation(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        section(view, "Doctor");
        view.handleInput?.("\x1b[B");
        finish(f.data.report);
        await tick();
        view.handleInput?.("\r");
        expect(text(view)).not.toContain("Global authority");
        view.handleInput?.("\x1b");
        view.handleInput?.("\x1b");
        expect(await f.closed).toEqual({
            action: "inspect-command",
            state: { section: "Doctor", executable: undefined },
        });
    });
    for (const theme of ["dark", "light"])
        it(`fits a compact colored summary in an 80x24 ${theme} terminal`, async () => {
            const f = fixture(24, theme);
            const view = await f.opened;
            const output = text(view);
            for (const label of [
                "› Status",
                "Permissions",
                "Doctor",
                "Docker",
                "Ready",
                "Applied",
            ])
                expect(output).toContain(label);
            expect(output).not.toContain("grant-29");
            expect(output).not.toContain("NEVER_DISPLAY_SECRET");
            expect(view.render(80).length).toBeLessThanOrEqual(22);
            expect(
                view.render(80).every((line) => visibleWidth(line) <= 80),
            ).toBe(true);
            expect(output).not.toMatch(/\[\d+\/\d+↑↓\]/);
            expect(output).toContain("✓ Ready");
            expect(output).toContain("✓ Applied");
            for (const role of ["success", "accent", "muted", "dim", "text"])
                expect(f.fg.mock.calls.some((call) => call[0] === role)).toBe(
                    true,
                );
            view.handleInput?.("\x1b");
            expect(await f.closed).toBeUndefined();
        });
    for (const [left, right, enter, escape, down, up] of [
        ["\x1b[D", "\x1b[C", "\r", "\x1b", "\x1b[B", "\x1b[A"],
        [
            "\x1b[1;1D",
            "\x1b[1;1C",
            "\x1b[13u",
            "\x1b[27u",
            "\x1b[1;1B",
            "\x1b[1;1A",
        ],
    ])
        it(`navigates panes, sections and controls with ${right === "\x1b[C" ? "legacy" : "Kitty"} keys`, async () => {
            const f = fixture();
            const view = await f.opened;
            view.handleInput?.(down!);
            expect(text(view)).toContain("Files:");
            expect(text(view)).not.toContain("grant-29");
            view.handleInput?.(right!);
            view.handleInput?.(enter!);
            expect(text(view)).toContain("Read access");
            view.handleInput?.("\x1b[F");
            expect(text(view)).toContain("grant-29");
            view.handleInput?.(escape!);
            expect(text(view)).toContain("Manage local installations");
            view.handleInput?.(left!);
            view.handleInput?.(up!);
            expect(text(view)).toContain("Shell mode:");
            view.handleInput?.(enter!);
            view.handleInput?.(down!);
            view.handleInput?.(enter!);
            expect(text(view)).toContain("Shell mode:");
            view.handleInput?.(up!);
            view.handleInput?.(enter!);
            expect(await f.closed).toEqual({
                action: "mode",
                state: { section: "Status", executable: undefined },
            });
            expect(f.redraw).toHaveBeenCalled();
        });
    it("switches pane focus with Tab and Shift-Tab and ignores key releases", async () => {
        const f = fixture();
        const view = await f.opened;
        const first = text(view);
        view.handleInput?.("\x1b[9;1:3u");
        view.handleInput?.("\x1b[13;1:3u");
        expect(text(view)).toBe(first);
        expect(f.redraw).not.toHaveBeenCalled();
        view.handleInput?.("\t");
        view.handleInput?.("\x1b[B");
        expect(text(view)).toContain("Shell mode:");
        view.handleInput?.("\x1b[Z");
        view.handleInput?.("\x1b[B");
        expect(text(view)).toContain("Files:");
    });
    it("shows pending policy instead of an applied receipt or cached Docker success", async () => {
        const f = fixture();
        const view = await f.opened;
        const snapshot = f.data.snapshot;
        if (snapshot.runtime.state !== "enabled")
            throw new Error("Fixture runtime missing");
        f.change({
            ...snapshot,
            runtime: { ...snapshot.runtime, sandboxFingerprint: "obsolete" },
            clients: {
                admission: "admitted",
                cli: { state: "exposed", issues: [] },
                compose: { state: "exposed", issues: [] },
            },
        });
        view.handleInput?.("\x1b[C");
        view.handleInput?.("\x1b[B");
        view.handleInput?.("\r");
        expect(text(view)).toContain("Changes pending");
        expect(text(view)).not.toContain("Applied");
        section(view, "Docker");
        expect(text(view)).not.toContain("Exposed");
    });
    it("shows configuration blockers in the dashboard and reveals the precise cause on request", async () => {
        const f = fixture();
        const view = await f.opened;
        f.change({
            runtime: { state: "error" },
            error: "Invalid filesystem.allowWrite in sandbox.json",
        });
        view.handleInput?.("\x1b[C");
        view.handleInput?.("\x1b[B");
        view.handleInput?.("\r");
        expect(text(view)).toContain("Blocked");
        expect(text(view)).toContain("Correct sandbox.json");
        view.handleInput?.("\x1b[A");
        view.handleInput?.("\r");
        expect(text(view)).toContain("Invalid filesystem.allowWrite");
        expect(f.fg.mock.calls.some((call) => call[0] === "error")).toBe(true);
    });
    it("does not reuse cached Docker client success before this runtime has an admission receipt", async () => {
        const f = fixture();
        const view = await f.opened;
        const snapshot = f.data.snapshot;
        if (snapshot.runtime.state !== "enabled")
            throw new Error("Fixture runtime missing");
        f.change({
            ...snapshot,
            runtime: { ...snapshot.runtime, contexts: undefined },
            clients: {
                admission: "admitted",
                cli: { state: "exposed", issues: [] },
                compose: { state: "exposed", issues: [] },
            },
        });
        section(view, "Docker");
        expect(text(view)).not.toContain("Exposed");
        expect(text(view)).toContain("Not checked");
    });
    it("keeps host and full Docker warnings visible in every section without revealing endpoints", async () => {
        const f = fixture();
        const view = await f.opened;
        if (!f.data.snapshot.resolved)
            throw new Error("Fixture policy missing");
        f.change({
            ...f.data.snapshot,
            resolved: {
                ...f.data.snapshot.resolved,
                shell: { ...f.data.snapshot.resolved.shell, mode: "host" },
                config: {
                    ...f.data.snapshot.resolved.config,
                    docker: {
                        mode: "full",
                        endpoint: "unix:///NEVER_DISPLAY_ENGINE_ENDPOINT",
                    },
                },
            },
        });
        for (let index = 0; index < 4; index++) {
            view.handleInput?.("\x1b[B");
            const output = text(view);
            expect(output).toContain("Host mode");
            expect(output).toContain("host control");
            expect(output).not.toContain("NEVER_DISPLAY_ENGINE_ENDPOINT");
        }
        expect(f.fg.mock.calls.some((call) => call[0] === "warning")).toBe(
            true,
        );
    });
    it("starts Doctor lazily, exposes read-only results and ignores completion after closure", async () => {
        const f = fixture();
        const view = await f.opened;
        expect(f.inspect).not.toHaveBeenCalled();
        let finish!: (report: SandboxDoctorInspection) => void;
        f.inspect.mockImplementation(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        section(view, "Doctor");
        expect(text(view)).toContain("Checking");
        expect(text(view)).toContain("Read-only");
        const calls = f.redraw.mock.calls.length;
        view.handleInput?.("\x1b");
        await f.closed;
        finish(f.data.report);
        await tick();
        expect(f.redraw.mock.calls.length).toBe(calls);
    });
    it("ignores an older Doctor response after refresh and puts blockers before successes", async () => {
        const f = fixture();
        const view = await f.opened;
        const responses: Array<(report: SandboxDoctorInspection) => void> = [];
        f.inspect.mockImplementation(
            () =>
                new Promise((resolve) => {
                    responses.push(resolve);
                }),
        );
        section(view, "Doctor");
        view.handleInput?.("\x1b[B");
        view.handleInput?.("\x1b[B");
        view.handleInput?.("\r");
        expect(responses).toHaveLength(2);
        responses[1]!({
            ...f.data.report,
            executable: {
                name: "git",
                inspection: {
                    state: "inaccessible",
                    issues: ["Read denied for executable"],
                },
            },
        });
        await tick();
        const latest = text(view);
        expect(latest.indexOf("Command: git")).toBeLessThan(
            latest.indexOf("Installed runtime"),
        );
        responses[0]!({ ...f.data.report, runtimeProblem: "OLD RESPONSE" });
        await tick();
        expect(text(view)).toBe(latest);
    });
    it("explains a Doctor blocker and its next step before opening details", async () => {
        const f = fixture();
        const view = await f.opened;
        f.inspect.mockResolvedValue({
            ...f.data.report,
            executable: {
                name: "git",
                inspection: {
                    state: "dependency-inaccessible",
                    issues: ["Missing interpreter: /fixture/bin/interpreter"],
                },
            },
        });
        section(view, "Doctor");
        await tick();
        const output = text(view);
        expect(output).toContain("Dependency unavailable");
        expect(output).toContain("Next step");
        expect(output).toContain("Authorize the command and its dependencies");
        expect(output).not.toContain("/fixture/bin/interpreter");
    });
    it("distinguishes planned executable exposure from admitted access", async () => {
        const f = fixture();
        const view = await f.opened;
        f.inspect.mockResolvedValue({
            ...f.data.report,
            admitted: undefined,
            executable: {
                name: "git",
                inspection: { state: "exposed", issues: [] },
            },
        });
        section(view, "Doctor");
        await tick();
        expect(text(view)).toContain("Exposed · planned");
        expect(text(view)).not.toContain("Exposed · not executed");
    });
    it("invalidates Doctor results when a newly read policy changes", async () => {
        const f = fixture();
        const view = await f.opened;
        f.inspect.mockResolvedValue({
            ...f.data.report,
            dockerClients: {
                admission: "admitted",
                cli: { state: "exposed", issues: [] },
                compose: { state: "exposed", issues: [] },
            },
        });
        section(view, "Doctor");
        await tick();
        if (!f.data.snapshot.resolved)
            throw new Error("Fixture policy missing");
        f.change({
            ...f.data.snapshot,
            resolved: {
                ...f.data.snapshot.resolved,
                shell: {
                    ...f.data.snapshot.resolved.shell,
                    sandboxFingerprint: "new-policy",
                },
            },
        });
        section(view, "Docker", "Doctor");
        expect(text(view)).not.toContain("Exposed");
        expect(text(view)).toContain("Not verified");
        section(view, "Doctor", "Docker");
        expect(f.inspect).toHaveBeenCalledTimes(2);
    });
    it("marks Docker client exposure from a planned inspection as pending", async () => {
        const f = fixture();
        const view = await f.opened;
        f.inspect.mockResolvedValue({
            ...f.data.report,
            admitted: undefined,
            dockerClients: {
                admission: "pending",
                cli: { state: "exposed", issues: [] },
                compose: { state: "exposed", issues: [] },
            },
        });
        section(view, "Doctor");
        await tick();
        section(view, "Docker", "Doctor");
        expect(text(view)).toContain("! Exposed · planned");
        expect(text(view)).not.toContain("✓ Exposed");
    });
    it("keeps warnings, focused content and close controls inside a small frame", async () => {
        const f = fixture(10);
        const view = await f.opened;
        if (!f.data.snapshot.resolved)
            throw new Error("Fixture policy missing");
        f.change({
            ...f.data.snapshot,
            resolved: {
                ...f.data.snapshot.resolved,
                shell: { ...f.data.snapshot.resolved.shell, mode: "host" },
                config: {
                    ...f.data.snapshot.resolved.config,
                    docker: { mode: "full", endpoint: "unix:///fixture" },
                },
            },
        });
        view.handleInput?.("\x1b[B");
        view.handleInput?.("\r");
        const lines = view.render(32);
        expect(lines.length).toBeLessThanOrEqual(8);
        expect(lines.every((line) => visibleWidth(line) <= 32)).toBe(true);
        expect(lines.map(stripTerminalSequences).join("\n")).toContain(
            "Host mode",
        );
        expect(lines.map(stripTerminalSequences).join("\n")).toContain(
            "host control",
        );
        expect(lines.map(stripTerminalSequences).join("\n")).toContain("Esc");
    });
    it("preserves selection and visible close controls on narrow, short and resized terminals", async () => {
        const f = fixture(6);
        const view = await f.opened;
        view.handleInput?.("\x1b[C");
        view.handleInput?.("\x1b[B");
        expect(text(view, 32)).toContain("Refresh");
        for (const [rows, width] of [
            [6, 32],
            [10, 32],
            [24, 80],
            [40, 140],
        ]) {
            f.resize(rows!);
            const lines = view.render(width!);
            expect(lines.length).toBeLessThanOrEqual(Math.min(22, rows! - 2));
            expect(lines.every((line) => visibleWidth(line) <= width!)).toBe(
                true,
            );
            expect(lines.map(stripTerminalSequences).join("\n")).toContain(
                "Esc",
            );
        }
    });
});
