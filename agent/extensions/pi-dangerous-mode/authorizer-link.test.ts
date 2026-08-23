import { afterEach, describe, expect, it, mock } from "bun:test";

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

type AuthorizeFn = (
    details: unknown,
    query: unknown,
    log: { debug: (event: string, details?: Record<string, unknown>) => void },
) => Promise<{ kind: string }>;

interface Fixture {
    flagValue: boolean | undefined;
    emitReady: () => void;
    runSessionShutdown: () => void;
}

function activate(flagValue: boolean | undefined): Fixture {
    let readyHandler: ((payload?: unknown) => void) | undefined;
    let shutdownHandler: (() => void) | undefined;

    extension({
        registerFlag() {},
        registerCommand() {},
        getFlag(name: string) {
            return name === "dangerously-skip-permissions"
                ? flagValue
                : undefined;
        },
        on(event: string, handler: unknown) {
            if (event === "session_start") {
                (handler as (e: unknown, ctx: unknown) => void)(
                    { reason: "startup" },
                    { cwd: "/tmp" },
                );
            }
            if (event === "session_shutdown") shutdownHandler = handler as () => void;
        },
        events: {
            on(channel: string, handler: (payload?: unknown) => void) {
                if (channel === "permissions:ready") readyHandler = handler;
                return () => {};
            },
            emit() {},
        },
    } as never);

    if (!readyHandler || !shutdownHandler) {
        throw new Error("dangerous-mode did not subscribe to lifecycle events");
    }
    return {
        flagValue,
        emitReady: () => readyHandler?.(),
        runSessionShutdown: () => shutdownHandler?.(),
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
        const verdict = await authorize({}, {}, { debug() {} });
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
        const verdict = await authorize({}, {}, { debug() {} });
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
        expect(await authorize({}, {}, { debug() {} })).toEqual({ kind: "allow" });

        setDangerousRuntimeState({
            enabled: false,
            config: { protectedTools: [], protectedExtensions: [] },
        });
        expect(await authorize({}, {}, { debug() {} })).toEqual({ kind: "defer" });
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
