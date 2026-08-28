import { beforeEach, describe, expect, it, mock } from "bun:test";
import {
    createExtensionRuntime,
    ExtensionRunner,
    type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { getRuntimeStatus } from "./runtime-state.ts";
import {
    installUiBrokerPatches,
    type UiBrokerDeps,
} from "./ui-broker.ts";

interface UiFixture {
    ui: ExtensionUIContext;
    select: ReturnType<typeof mock>;
    confirm: ReturnType<typeof mock>;
    input: ReturnType<typeof mock>;
    editor: ReturnType<typeof mock>;
    custom: ReturnType<typeof mock>;
    notify: ReturnType<typeof mock>;
    setStatus: ReturnType<typeof mock>;
    setWidget: ReturnType<typeof mock>;
    setEditorText: ReturnType<typeof mock>;
    getEditorText: ReturnType<typeof mock>;
    theme: ExtensionUIContext["theme"]; 
}

function createUiFixture(): UiFixture {
    const theme = {} as ExtensionUIContext["theme"]; 
    const select = mock(async () => "choice");
    const confirm = mock(async () => true);
    const input = mock(async () => "input");
    const editor = mock(async () => "edited");
    const custom = mock(async () => "custom-result");
    const notify = mock(() => undefined);
    const setStatus = mock(() => undefined);
    const setWidget = mock(() => undefined);
    const setEditorText = mock(() => undefined);
    const getEditorText = mock(() => "editor text");
    const ui = {
        select,
        confirm,
        input,
        editor,
        custom,
        notify,
        setStatus,
        setWidget,
        setEditorText,
        getEditorText,
        theme,
    } as unknown as ExtensionUIContext;
    return {
        ui,
        select,
        confirm,
        input,
        editor,
        custom,
        notify,
        setStatus,
        setWidget,
        setEditorText,
        getEditorText,
        theme,
    };
}

function createRunner(): ExtensionRunner {
    return new ExtensionRunner(
        [],
        createExtensionRuntime(),
        "/tmp/pi-dangerous-mode-ui-broker-test",
        {} as never,
        {} as never,
    );
}

let enabled = false;
let agentActive = true;
let blockedKinds: string[] = [];
const deps: UiBrokerDeps = {
    isEnabled: () => enabled,
    isAgentActive: () => agentActive,
    onBlocked: (event: { kind: string }) => blockedKinds.push(event.kind),
};

class FakeInteractiveMode {
    constructor(private readonly fixture: UiFixture) {}

    createExtensionUIContext(): ExtensionUIContext {
        return this.fixture.ui;
    }
}

beforeEach(() => {
    enabled = false;
    agentActive = true;
    blockedKinds = [];
    expect(
        installUiBrokerPatches(deps, {
            runner: ExtensionRunner,
            interactiveMode: FakeInteractiveMode,
        }),
    ).toBe(true);
});

describe("pi-dangerous-mode UI broker", () => {
    it("delegates structured dialogs while Autopilot is off", async () => {
        const fixture = createUiFixture();
        const runner = createRunner();
        runner.setUIContext(fixture.ui, "tui");

        await expect(runner.createContext().ui.select("Pick", ["choice"]))
            .resolves.toBe("choice");
        expect(fixture.select).toHaveBeenCalledTimes(1);
        expect(blockedKinds).toEqual([]);
    });

    it("blocks structured dialogs before the underlying UI renders", async () => {
        const fixture = createUiFixture();
        const runner = createRunner();
        runner.setUIContext(fixture.ui, "tui");
        const ui = runner.createContext().ui;
        enabled = true;

        for (const invoke of [
            () => ui.select("Pick", ["choice"]),
            () => ui.confirm("Confirm", "Proceed?"),
            () => ui.input("Input"),
            () => ui.editor("Editor"),
        ]) {
            await expect(invoke()).rejects.toMatchObject({
                code: "AUTOPILOT_PROMPT_BLOCKED",
            });
        }

        expect(fixture.select).toHaveBeenCalledTimes(0);
        expect(fixture.confirm).toHaveBeenCalledTimes(0);
        expect(fixture.input).toHaveBeenCalledTimes(0);
        expect(fixture.editor).toHaveBeenCalledTimes(0);
        expect(blockedKinds).toEqual([
            "select",
            "confirm",
            "input",
            "editor",
        ]);
    });

    it("blocks custom UI only during an active agent run", async () => {
        const fixture = createUiFixture();
        const runner = createRunner();
        runner.setUIContext(fixture.ui, "tui");
        const ui = runner.createContext().ui;
        enabled = true;

        await expect(ui.custom(() => ({}) as never)).rejects.toMatchObject({
            code: "AUTOPILOT_PROMPT_BLOCKED",
        });
        expect(fixture.custom).toHaveBeenCalledTimes(0);

        agentActive = false;
        await expect(ui.custom(() => ({}) as never)).resolves.toBe(
            "custom-result",
        );
        expect(fixture.custom).toHaveBeenCalledTimes(1);
    });

    it("delegates non-prompt UI methods and properties", () => {
        const fixture = createUiFixture();
        const runner = createRunner();
        runner.setUIContext(fixture.ui, "tui");
        const ui = runner.createContext().ui;
        enabled = true;

        ui.notify("notice", "info");
        ui.setStatus("autopilot", "running");
        ui.setWidget("autopilot", ["running"]);
        ui.setEditorText("next");

        expect(ui.getEditorText()).toBe("editor text");
        expect(ui.theme).toBe(fixture.theme);
        expect(fixture.notify).toHaveBeenCalledTimes(1);
        expect(fixture.setStatus).toHaveBeenCalledTimes(1);
        expect(fixture.setWidget).toHaveBeenCalledTimes(1);
        expect(fixture.setEditorText).toHaveBeenCalledTimes(1);
    });

    it("reuses one proxy when the same context is bound twice", () => {
        const fixture = createUiFixture();
        const runner = createRunner();

        runner.setUIContext(fixture.ui, "tui");
        const first = runner.getUIContext();
        runner.setUIContext(fixture.ui, "tui");

        expect(runner.getUIContext()).toBe(first);
    });

    it("wraps fresh InteractiveMode contexts used outside the runner", async () => {
        const fixture = createUiFixture();
        const interactive = new FakeInteractiveMode(fixture);
        enabled = true;

        const ui = interactive.createExtensionUIContext();

        await expect(ui.select("Pick", ["choice"])).rejects.toMatchObject({
            code: "AUTOPILOT_PROMPT_BLOCKED",
        });
        expect(fixture.select).toHaveBeenCalledTimes(0);
    });

    it("marks only UI broker incompatible for malformed constructors", () => {
        class MissingUiFactory {}

        expect(
            installUiBrokerPatches(deps, {
                runner: ExtensionRunner,
                interactiveMode: MissingUiFactory,
            }),
        ).toBe(false);
        expect(getRuntimeStatus().compatible).toEqual({
            runner: true,
            uiBroker: false,
        });
    });
});
