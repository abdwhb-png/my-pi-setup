import { describe, expect, it, mock } from "bun:test";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import * as broker from "./extension-ui-broker.ts";

interface BrokerWithObserver {
    registerExtensionUiPromptObserver?: (
        ownerId: string,
        observer: (kind: broker.ExtensionUiPromptKind) => void,
    ) => () => void;
}

function createUiFixture(): ExtensionUIContext {
    return {
        select: mock(async () => "choice"),
        confirm: mock(async () => true),
        input: mock(async () => "input"),
        editor: mock(async () => "edited"),
        custom: mock(async () => "custom-result"),
        notify: mock(() => undefined),
        setStatus: mock(() => undefined),
        setWidget: mock(() => undefined),
        setEditorText: mock(() => undefined),
        getEditorText: mock(() => "editor text"),
        theme: {},
    } as unknown as ExtensionUIContext;
}

class FakeRunner {
    uiContext: ExtensionUIContext | undefined;

    setUIContext(uiContext?: ExtensionUIContext): void {
        this.uiContext = uiContext;
    }
}

class FakeInteractiveMode {
    constructor(readonly uiContext: ExtensionUIContext) {}

    createExtensionUIContext(): ExtensionUIContext {
        return this.uiContext;
    }
}

describe("shared extension UI broker", () => {
    it("observes every prompt kind once and preserves dialog results", async () => {
        expect(
            broker.installExtensionUiBroker({
                runner: FakeRunner,
                interactiveMode: FakeInteractiveMode,
            }),
        ).toBe(true);

        const registerObserver = (broker as BrokerWithObserver)
            .registerExtensionUiPromptObserver;
        expect(typeof registerObserver).toBe("function");
        if (!registerObserver) return;

        const observed: broker.ExtensionUiPromptKind[] = [];
        const unregister = registerObserver(
            "shared-broker-test.observer",
            (kind) => observed.push(kind),
        );
        const fixture = createUiFixture();
        const runner = new FakeRunner();
        runner.setUIContext(fixture);
        const ui = runner.uiContext!;

        await expect(ui.select("Pick", ["choice"])).resolves.toBe("choice");
        await expect(ui.confirm("Confirm", "Proceed?")).resolves.toBe(true);
        await expect(ui.input("Input")).resolves.toBe("input");
        await expect(ui.editor("Editor")).resolves.toBe("edited");
        await expect(ui.custom(() => ({}) as never)).resolves.toBe(
            "custom-result",
        );

        expect(observed).toEqual([
            "select",
            "confirm",
            "input",
            "editor",
            "custom",
        ]);
        unregister();
    });

    it("isolates observer failures from the underlying prompt", async () => {
        expect(
            broker.installExtensionUiBroker({
                runner: FakeRunner,
                interactiveMode: FakeInteractiveMode,
            }),
        ).toBe(true);

        const unregister = broker.registerExtensionUiPromptObserver(
            "shared-broker-test.failing-observer",
            () => {
                throw new Error("notification backend failed");
            },
        );
        const fixture = createUiFixture();
        const runner = new FakeRunner();
        runner.setUIContext(fixture);

        await expect(
            runner.uiContext!.select("Pick", ["choice"]),
        ).resolves.toBe("choice");
        unregister();
    });

    it("runs guards before observers and skips blocked prompt rendering", async () => {
        const fixture = createUiFixture();
        const runner = new FakeRunner();
        runner.setUIContext(fixture);
        const observer = mock(() => undefined);
        const unregisterObserver = broker.registerExtensionUiPromptObserver(
            "shared-broker-test.blocked-observer",
            observer,
        );
        const unregisterGuard = broker.registerExtensionUiPromptGuard(
            "shared-broker-test.blocking-guard",
            () => {
                throw new Error("prompt blocked");
            },
        );

        await expect(
            runner.uiContext!.select("Pick", ["choice"]),
        ).rejects.toThrow("prompt blocked");
        expect(observer).toHaveBeenCalledTimes(0);
        expect(fixture.select).toHaveBeenCalledTimes(0);

        unregisterGuard();
        unregisterObserver();
    });

    it("replaces owners without letting stale unregister remove the replacement", async () => {
        const firstObserver = mock(() => undefined);
        const secondObserver = mock(() => undefined);
        const unregisterFirst = broker.registerExtensionUiPromptObserver(
            "shared-broker-test.reload-owner",
            firstObserver,
        );
        const unregisterSecond = broker.registerExtensionUiPromptObserver(
            "shared-broker-test.reload-owner",
            secondObserver,
        );
        unregisterFirst();

        const runner = new FakeRunner();
        runner.setUIContext(createUiFixture());
        await runner.uiContext!.input("Input");

        expect(firstObserver).toHaveBeenCalledTimes(0);
        expect(secondObserver).toHaveBeenCalledTimes(1);

        unregisterSecond();
        await runner.uiContext!.input("Input");
        expect(secondObserver).toHaveBeenCalledTimes(1);
    });

    it("preserves non-prompt method binding and properties", () => {
        const fixture = createUiFixture();
        const theme = fixture.theme;
        const getEditorText = mock(function (this: ExtensionUIContext) {
            return this === fixture ? "bound" : "unbound";
        });
        fixture.getEditorText = getEditorText;
        const runner = new FakeRunner();
        runner.setUIContext(fixture);

        expect(runner.uiContext!.getEditorText()).toBe("bound");
        expect(runner.uiContext!.theme).toBe(theme);
        expect(getEditorText).toHaveBeenCalledTimes(1);
    });

    it("uses one proxy across InteractiveMode and runner binding", () => {
        const fixture = createUiFixture();
        const interactive = new FakeInteractiveMode(fixture);
        const interactiveContext = interactive.createExtensionUIContext();
        const runner = new FakeRunner();

        runner.setUIContext(interactiveContext);

        expect(runner.uiContext).toBe(interactiveContext);
    });

    it("reports incompatible constructors without replacing valid UI methods", () => {
        class MissingUiFactory {}

        expect(
            broker.installExtensionUiBroker({
                runner: FakeRunner,
                interactiveMode: MissingUiFactory,
            }),
        ).toBe(false);

        const fixture = createUiFixture();
        const runner = new FakeRunner();
        runner.setUIContext(fixture);
        expect(runner.uiContext).toBeDefined();
    });

    it("replaces and disables the legacy dangerous-mode broker during reload", () => {
        class LegacyRunner {
            uiContext: ExtensionUIContext | undefined;

            setUIContext(uiContext?: ExtensionUIContext): void {
                this.uiContext = uiContext;
            }
        }
        class LegacyInteractiveMode {
            constructor(readonly uiContext: ExtensionUIContext) {}

            createExtensionUIContext(): ExtensionUIContext {
                return this.uiContext;
            }
        }

        const originalSetUIContext = LegacyRunner.prototype.setUIContext;
        const originalCreateUIContext =
            LegacyInteractiveMode.prototype.createExtensionUIContext;
        Object.defineProperty(LegacyRunner.prototype, "setUIContext", {
            configurable: true,
            value() {
                throw new Error("legacy runner wrapper invoked");
            },
        });
        Object.defineProperty(
            LegacyInteractiveMode.prototype,
            "createExtensionUIContext",
            {
                configurable: true,
                value() {
                    throw new Error("legacy interactive wrapper invoked");
                },
            },
        );

        const legacyDeps = {
            isEnabled: () => true,
            isAgentActive: () => true,
            onBlocked: () => undefined,
        };
        const legacyState = {
            deps: legacyDeps,
            runnerOriginals: new WeakMap<object, unknown>([
                [LegacyRunner.prototype, originalSetUIContext],
            ]),
            interactiveOriginals: new WeakMap<object, unknown>([
                [
                    LegacyInteractiveMode.prototype,
                    originalCreateUIContext,
                ],
            ]),
        };
        const legacyKey = Symbol.for("pi-dangerous-mode.ui-broker");
        const globals = globalThis as typeof globalThis &
            Record<symbol, unknown>;
        globals[legacyKey] = legacyState;

        expect(
            broker.installExtensionUiBroker({
                runner: LegacyRunner,
                interactiveMode: LegacyInteractiveMode,
            }),
        ).toBe(true);

        const fixture = createUiFixture();
        const runner = new LegacyRunner();
        expect(() => runner.setUIContext(fixture)).not.toThrow();
        expect(runner.uiContext).toBeDefined();
        expect(
            new LegacyInteractiveMode(fixture).createExtensionUIContext(),
        ).toBeDefined();
        expect(legacyState.deps).not.toBe(legacyDeps);

        delete globals[legacyKey];
    });
});
