import { afterEach, describe, expect, it, mock } from "bun:test";
import type {
    AuthorizerLog,
    AuthorizerVerdict,
    PermissionQuery,
    PromptPermissionDetails,
} from "@gotgenes/pi-permission-system";

const registerAuthorizer = mock(() => (): void => {});
let service: {
    registerAuthorizer: typeof registerAuthorizer;
} | undefined;

mock.module("@gotgenes/pi-permission-system", () => ({
    getPermissionsService: () => service,
}));

const { default: extension } = await import("./index.ts");
const {
    setDangerousRuntimeState,
    isDangerousEnabled,
} = await import("./runner-patch.ts");
const { DEFAULT_AUTOPILOT } = await import("./config.ts");
const { startRuntimeSession } = await import("./runtime-state.ts");

type AuthorizeFn = (
    details: PromptPermissionDetails,
    query: PermissionQuery,
    log: AuthorizerLog,
) => Promise<AuthorizerVerdict>;

function permissionDetails(
    overrides: Partial<PromptPermissionDetails> = {},
): PromptPermissionDetails {
    return {
        requestId: "request-id",
        source: "tool_call",
        agentName: null,
        message: "Allow tool?",
        ...overrides,
    };
}

const query = {
    checkPermission() {
        return {
            toolName: "bash",
            state: "ask",
            source: "bash",
            origin: "builtin",
        };
    },
    getToolPermission() {
        return "ask";
    },
} as PermissionQuery;

interface Fixture {
    flagValue: boolean | undefined;
    emitReady: () => void;
    runSessionShutdown: () => void;
}

function activate(flagValue: boolean | undefined): Fixture {
    let readyHandler: ((payload?: unknown) => void) | undefined;
    const shutdownHandlers: Array<() => void> = [];
    let activeTools = ["read", "bash"];

    extension({
        registerFlag() {},
        registerCommand() {},
        registerTool() {},
        appendEntry() {},
        sendMessage() {},
        getActiveTools() {
            return activeTools;
        },
        setActiveTools(tools: string[]) {
            activeTools = tools;
        },
        getFlag(name: string) {
            if (name === "dangerously-skip-permissions") return flagValue;
            if (name === "autopilot") return false;
            return undefined;
        },
        on(event: string, handler: unknown) {
            if (event === "session_start") {
                (handler as (e: unknown, ctx: unknown) => void)(
                    { reason: "startup" },
                    {
                        cwd: "/tmp",
                        hasPendingMessages: () => false,
                        ui: { notify() {} },
                    },
                );
            }
            if (event === "session_shutdown") {
                shutdownHandlers.push(handler as () => void);
            }
        },
        events: {
            on(channel: string, handler: (payload?: unknown) => void) {
                if (channel === "permissions:ready") readyHandler = handler;
                return () => {};
            },
            emit() {},
        },
    } as never);

    if (!readyHandler || shutdownHandlers.length === 0) {
        throw new Error("dangerous-mode did not subscribe to lifecycle events");
    }
    return {
        flagValue,
        emitReady: () => readyHandler?.(),
        runSessionShutdown: () => {
            for (const handler of shutdownHandlers) handler();
        },
    };
}

afterEach(() => {
    service = undefined;
    registerAuthorizer.mockClear();
    setDangerousRuntimeState({
        enabled: false,
        config: { protectedTools: [], protectedExtensions: [] },
    });
});

describe("pi-dangerous-mode authorizer link", () => {
    it("registers the link when the permission service publishes", () => {
        service = { registerAuthorizer };
        const fixture = activate(false);
        fixture.emitReady();

        expect(registerAuthorizer).toHaveBeenCalledTimes(1);
        const [name, authorize] = registerAuthorizer.mock.calls[0] as unknown as [
            string,
            AuthorizeFn,
        ];
        expect(name).toBe("pi-dangerous-mode");
        expect(typeof authorize).toBe("function");
    });

    it("does nothing when no permission service is published", () => {
        service = undefined;
        const fixture = activate(false);
        fixture.emitReady();

        expect(registerAuthorizer).not.toHaveBeenCalled();
    });

    it("allows asks while dangerous mode is enabled", async () => {
        service = { registerAuthorizer };
        setDangerousRuntimeState({
            enabled: true,
            config: { protectedTools: [], protectedExtensions: [] },
        });
        const fixture = activate(true);
        fixture.emitReady();
        expect(isDangerousEnabled()).toBe(true);

        const [, authorize] = registerAuthorizer.mock.calls[0] as unknown as [
            string,
            AuthorizeFn,
        ];
        const verdict = await authorize(permissionDetails(), query, {
            review() {},
            debug() {},
        });
        expect(verdict).toEqual({ kind: "allow" });
    });

    it("defers asks while dangerous mode is disabled", async () => {
        service = { registerAuthorizer };
        const fixture = activate(false);
        fixture.emitReady();

        const [, authorize] = registerAuthorizer.mock.calls[0] as unknown as [
            string,
            AuthorizeFn,
        ];
        const verdict = await authorize(permissionDetails(), query, {
            review() {},
            debug() {},
        });
        expect(verdict).toEqual({ kind: "defer" });
    });

    it("reflects a runtime off toggle immediately", async () => {
        service = { registerAuthorizer };
        setDangerousRuntimeState({
            enabled: true,
            config: { protectedTools: [], protectedExtensions: [] },
        });
        const fixture = activate(true);
        fixture.emitReady();

        const [, authorize] = registerAuthorizer.mock.calls[0] as unknown as [
            string,
            AuthorizeFn,
        ];
        expect(
            await authorize(permissionDetails(), query, {
                review() {},
                debug() {},
            }),
        ).toEqual({ kind: "allow" });

        setDangerousRuntimeState({
            enabled: false,
            config: { protectedTools: [], protectedExtensions: [] },
        });
        expect(
            await authorize(permissionDetails(), query, {
                review() {},
                debug() {},
            }),
        ).toEqual({ kind: "defer" });
    });

    it("denies guarded Autopilot permission asks without opening UI", async () => {
        service = { registerAuthorizer };
        const fixture = activate(false);
        fixture.emitReady();
        startRuntimeSession({
            isReload: false,
            dangerousFlag: false,
            autopilotFlag: true,
            config: {
                protectedTools: [],
                protectedExtensions: [],
                autopilot: {
                    ...DEFAULT_AUTOPILOT,
                    guardedTools: [...DEFAULT_AUTOPILOT.guardedTools],
                    guardedCommands: [...DEFAULT_AUTOPILOT.guardedCommands],
                },
            },
            now: 1_000,
        });
        const review = mock(() => undefined);
        const [, authorize] = registerAuthorizer.mock.calls[0] as unknown as [
            string,
            AuthorizeFn,
        ];

        const verdict = await authorize(
            permissionDetails({
                command: "git push origin main",
                toolName: "bash",
                target: "origin/main",
            }),
            query,
            { review, debug() {} },
        );

        expect(verdict).toEqual({
            kind: "deny",
            reason: expect.stringContaining("Autopilot guard"),
        });
        expect(review).toHaveBeenCalledWith("autopilot.guard_blocked", {
            category: "publish",
            toolName: "bash",
        });
    });

    it("disposes registered links on session shutdown", () => {
        const dispose = mock(() => {});
        registerAuthorizer.mockImplementation(() => dispose);
        service = { registerAuthorizer };

        const fixture = activate(true);
        fixture.emitReady();
        fixture.emitReady();
        fixture.runSessionShutdown();

        expect(dispose).toHaveBeenCalledTimes(2);
    });

    it("does not dispose links that were never registered", () => {
        service = undefined;
        const fixture = activate(true);
        fixture.emitReady();
        fixture.runSessionShutdown();
    });
});
