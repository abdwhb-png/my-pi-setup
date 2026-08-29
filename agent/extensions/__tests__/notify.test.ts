import { beforeEach, describe, expect, it, mock } from "bun:test";

const sendNotification = mock((_event: unknown) => undefined);
const unregisterObserver = mock(() => undefined);
let promptObserver: ((kind: string) => void) | undefined;

mock.module("../notify/transport.ts", () => ({
    createNotificationTransport: () => ({ send: sendNotification }),
}));

mock.module("../_shared/extension-ui-broker.ts", () => ({
    installExtensionUiBroker: () => true,
    registerExtensionUiPromptObserver: (
        _ownerId: string,
        observer: (kind: string) => void,
    ) => {
        promptObserver = observer;
        return unregisterObserver;
    },
}));

const { default: notifyExtension } = await import("../notify.ts");

interface TestContext {
    cwd: string;
    hasUI: boolean;
    isIdle(): boolean;
    hasPendingMessages(): boolean;
    ui: {
        theme: { fg(_color: string, text: string): string };
        setStatus(_key: string, _value: string | undefined): void;
        notify(_message: string, _level: string): void;
    };
}

type Handler = (
    event: unknown,
    context: TestContext,
) => void | Promise<void>;

interface ExtensionFixture {
    handlers: Map<string, Handler[]>;
    commands: Map<
        string,
        {
            handler(
                args: string,
                context: TestContext,
            ): void | Promise<void>;
        }
    >;
}

function setup(): ExtensionFixture {
    const handlers = new Map<string, Handler[]>();
    const commands = new Map<
        string,
        {
            handler(
                args: string,
                context: TestContext,
            ): void | Promise<void>;
        }
    >();

    notifyExtension({
        on(event: string, handler: Handler) {
            const eventHandlers = handlers.get(event) ?? [];
            eventHandlers.push(handler);
            handlers.set(event, eventHandlers);
        },
        registerCommand(
            name: string,
            command: {
                handler(
                    args: string,
                    context: TestContext,
                ): void | Promise<void>;
            },
        ) {
            commands.set(name, command);
        },
        events: { on: () => () => undefined },
    } as never);

    return { handlers, commands };
}

function createContext(
    hasUI = true,
    state: { idle: boolean; pending: boolean } = {
        idle: true,
        pending: false,
    },
): TestContext {
    return {
        cwd: "/work/demo-project",
        hasUI,
        isIdle: () => state.idle,
        hasPendingMessages: () => state.pending,
        ui: {
            theme: { fg: (_color, text) => text },
            setStatus: () => undefined,
            notify: () => undefined,
        },
    };
}

async function emit(
    fixture: ExtensionFixture,
    eventName: string,
    event: unknown,
    context: TestContext,
): Promise<void> {
    for (const handler of fixture.handlers.get(eventName) ?? []) {
        await handler(event, context);
    }
}

beforeEach(() => {
    sendNotification.mockClear();
    unregisterObserver.mockClear();
    promptObserver = undefined;
    delete process.env.PI_NO_NOTIFY;
});

describe("notify extension", () => {
    it("uses agent_settled rather than intermediate agent_end for completion", () => {
        const fixture = setup();

        expect(fixture.handlers.has("agent_end")).toBe(false);
        expect(fixture.handlers.has("agent_settled")).toBe(true);
    });

    it("sends generic completion stats without assistant content", async () => {
        const originalNow = Date.now;
        const now = mock(() => 13_000);
        now.mockReturnValueOnce(1_000);
        Date.now = now;
        try {
            const fixture = setup();
            const context = createContext();
            await emit(fixture, "agent_start", {}, context);
            await emit(fixture, "turn_start", { turnIndex: 1 }, context);
            await emit(
                fixture,
                "tool_result",
                { toolName: "edit", isError: false },
                context,
            );
            await emit(
                fixture,
                "tool_result",
                { toolName: "write", isError: true },
                context,
            );
            await emit(
                fixture,
                "agent_settled",
                { messages: ["SECRET_ASSISTANT_TEXT"] },
                context,
            );
            await new Promise((resolve) => setTimeout(resolve, 5));

            expect(sendNotification).toHaveBeenCalledWith({
                type: "task-complete",
                project: "demo-project",
                elapsedSeconds: 12,
                turnCount: 2,
                filesChanged: 1,
            });
            expect(JSON.stringify(sendNotification.mock.calls)).not.toContain(
                "SECRET_ASSISTANT_TEXT",
            );
        } finally {
            Date.now = originalNow;
        }
    });

    it("suppresses completion when a settled handler queues continuation", async () => {
        const fixture = setup();
        const state = { idle: true, pending: false };
        const context = createContext(true, state);
        await emit(fixture, "agent_start", {}, context);
        await emit(fixture, "agent_settled", {}, context);
        state.pending = true;
        await new Promise((resolve) => setTimeout(resolve, 5));

        expect(sendNotification).toHaveBeenCalledTimes(0);
    });

    it("notifies prompt requests only while an agent is active", async () => {
        const fixture = setup();
        const context = createContext();
        await emit(fixture, "session_start", { reason: "startup" }, context);

        expect(promptObserver).toBeDefined();
        promptObserver?.("confirm");
        expect(sendNotification).toHaveBeenCalledTimes(0);

        await emit(fixture, "agent_start", {}, context);
        promptObserver?.("confirm");

        expect(sendNotification).toHaveBeenCalledWith({
            type: "action-required",
            project: "demo-project",
            promptKind: "confirm",
        });
    });

    it("suppresses prompt and completion notifications when disabled", async () => {
        process.env.PI_NO_NOTIFY = "1";
        const fixture = setup();
        const context = createContext();
        await emit(fixture, "session_start", { reason: "startup" }, context);
        await emit(fixture, "agent_start", {}, context);
        promptObserver?.("input");
        await emit(fixture, "agent_settled", {}, context);
        await new Promise((resolve) => setTimeout(resolve, 5));

        expect(sendNotification).toHaveBeenCalledTimes(0);

        await fixture.commands.get("notify")!.handler("", context);
        await emit(fixture, "agent_start", {}, context);
        promptObserver?.("input");
        expect(sendNotification).toHaveBeenCalledTimes(1);
    });

    it("keeps headless sessions silent", async () => {
        const fixture = setup();
        const context = createContext(false);
        await emit(fixture, "session_start", { reason: "startup" }, context);
        await emit(fixture, "agent_start", {}, context);
        promptObserver?.("editor");
        await emit(fixture, "agent_settled", {}, context);
        await new Promise((resolve) => setTimeout(resolve, 5));

        expect(sendNotification).toHaveBeenCalledTimes(0);
    });

    it("unregisters prompt observation and cancels completion on shutdown", async () => {
        const fixture = setup();
        const context = createContext();
        await emit(fixture, "session_start", { reason: "startup" }, context);
        await emit(fixture, "agent_start", {}, context);
        await emit(fixture, "agent_settled", {}, context);
        await emit(fixture, "session_shutdown", {}, context);
        await new Promise((resolve) => setTimeout(resolve, 5));

        expect(unregisterObserver).toHaveBeenCalledTimes(1);
        expect(sendNotification).toHaveBeenCalledTimes(0);
    });
});
