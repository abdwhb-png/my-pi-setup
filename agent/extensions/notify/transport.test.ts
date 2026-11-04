import { describe, expect, it, mock } from "bun:test";
import {
    createNotificationTransport,
    type NativeNotificationOptions,
} from "./transport.ts";

const capabilities = {
    env: { DISPLAY: ":0" },
    hasExecutable: (_path: string) => true,
    nativeExecutable: "/fixture/terminal-notifier",
    snoreToastPath: "/fixture/snoretoast.exe",
};

describe("session notification capabilities", () => {
    const event = {
        type: "action-required" as const,
        project: "fixture",
        promptKind: "input" as const,
    };
    for (const [platform, isWsl] of [
        ["darwin", false],
        ["win32", false],
        ["linux", true],
    ] as const) {
        it(`falls back quietly when the ${platform}/WSL=${isWsl} desktop executable is missing`, () => {
            const nativeNotify = mock(() => undefined);
            const write = mock((_value: string) => undefined);
            const warn = mock((_message: string) => undefined);
            const transport = createNotificationTransport({
                ...capabilities,
                platform,
                isWsl,
                isTTY: true,
                env: {},
                hasExecutable: () => false,
                nativeNotify,
                write,
                warn,
            });
            transport.send(event);
            expect(write.mock.calls).toEqual([["\x07"]]);
            expect(nativeNotify).not.toHaveBeenCalled();
            expect(warn).not.toHaveBeenCalled();
        });
    }
    for (const env of [
        { TERM_PROGRAM: "ghostty" },
        { TERM_PROGRAM: "iTerm.app" },
        { TERM_PROGRAM: "WezTerm" },
        { KITTY_WINDOW_ID: "1" },
    ]) {
        it(`uses OSC 9 without native attempts in a headless ${JSON.stringify(env)} session`, () => {
            const nativeNotify = mock(() => undefined);
            const write = mock((_value: string) => undefined);
            const warn = mock((_message: string) => undefined);
            const transport = createNotificationTransport({
                ...capabilities,
                platform: "linux",
                isWsl: false,
                isTTY: true,
                env,
                hasExecutable: () => false,
                nativeNotify,
                write,
                warn,
            });
            transport.send({
                ...event,
                project: "fixture\x07\x1b]9;bad\x9c\n",
            });
            expect(nativeNotify).not.toHaveBeenCalled();
            expect(warn).not.toHaveBeenCalled();
            expect(write).toHaveBeenCalledTimes(1);
            const output = write.mock.calls[0]![0];
            expect(output).toStartWith("\x1b]9;Pi");
            expect(output).toEndWith("\x1b\\");
            expect(output.slice(5, -2)).not.toMatch(/\p{Cc}/u);
            expect(transport.getStatus().channel).toBe("osc9");
        });
    }
    for (const env of [
        { TERM: "xterm-256color" },
        { TERM_PROGRAM: "ghostty", TMUX: "/fixture" },
        { TERM_PROGRAM: "ghostty", STY: "fixture" },
    ]) {
        it(`uses one BEL for an unconfirmed terminal or multiplexer ${JSON.stringify(env)}`, () => {
            const write = mock((_value: string) => undefined);
            const nativeNotify = mock(() => undefined);
            const transport = createNotificationTransport({
                ...capabilities,
                platform: "linux",
                isWsl: false,
                isTTY: true,
                env,
                write,
                nativeNotify,
            });
            transport.send(event);
            expect(write.mock.calls).toEqual([["\x07"]]);
            expect(nativeNotify).not.toHaveBeenCalled();
            expect(transport.getStatus().channel).toBe("bell");
        });
    }
    it("quietly skips a missing desktop executable and reports its reason without sending", () => {
        const nativeNotify = mock(() => undefined);
        const write = mock((_value: string) => undefined);
        const warn = mock((_message: string) => undefined);
        const transport = createNotificationTransport({
            ...capabilities,
            platform: "linux",
            isWsl: false,
            isTTY: true,
            hasExecutable: () => false,
            nativeNotify,
            write,
            warn,
        });
        expect(transport.getStatus()).toMatchObject({
            channel: "bell",
            reasons: expect.arrayContaining([
                expect.stringContaining("notify-send"),
            ]),
        });
        expect(write).not.toHaveBeenCalled();
        transport.send(event);
        transport.send(event);
        expect(nativeNotify).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
        expect(write.mock.calls).toEqual([["\x07"], ["\x07"]]);
    });
    it("disables a failed native backend and falls back to OSC once per event", () => {
        const write = mock((_value: string) => undefined);
        const warn = mock((_message: string) => undefined);
        const nativeNotify = mock(
            (
                _options: NativeNotificationOptions,
                callback: (error?: Error | null) => void,
            ) => {
                callback(new Error("desktop service refused"));
                callback(new Error("duplicate callback"));
            },
        );
        const transport = createNotificationTransport({
            ...capabilities,
            env: { DISPLAY: ":0", TERM_PROGRAM: "ghostty" },
            platform: "linux",
            isWsl: false,
            isTTY: true,
            nativeNotify,
            write,
            warn,
        });
        transport.send(event);
        transport.send(event);
        expect(nativeNotify).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(write).toHaveBeenCalledTimes(2);
        expect(
            write.mock.calls.every(([value]) => value.startsWith("\x1b]9;")),
        ).toBe(true);
        expect(transport.getStatus().reasons.join(" ")).toContain(
            "desktop service refused",
        );
    });
    it("bounds terminal write failures and exposes them", () => {
        const warn = mock((_message: string) => undefined);
        const write = mock((_value: string) => {
            throw new Error("closed terminal");
        });
        const transport = createNotificationTransport({
            ...capabilities,
            env: { TERM_PROGRAM: "ghostty" },
            platform: "linux",
            isWsl: false,
            isTTY: true,
            nativeNotify: () => undefined,
            write,
            warn,
        });
        expect(() => transport.send(event)).not.toThrow();
        transport.send(event);
        expect(write).toHaveBeenCalledTimes(2);
        expect(warn).toHaveBeenCalledTimes(2);
        expect(transport.getStatus().channel).toBe("none");
    });
    it("does not send through any channel without a terminal", () => {
        const write = mock(() => undefined);
        const nativeNotify = mock(() => undefined);
        const transport = createNotificationTransport({
            ...capabilities,
            platform: "darwin",
            isWsl: false,
            isTTY: false,
            write,
            nativeNotify,
        });
        transport.send(event);
        expect(transport.getStatus().channel).toBe("none");
        expect(nativeNotify).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();
    });
});

describe("notification transport", () => {
    it("executes SnoreToast directly under WSL and surfaces process failure", () => {
        const nativeNotify = mock(
            (
                _options: NativeNotificationOptions,
                callback: (error?: Error | null) => void,
            ) => callback(null),
        );
        const launchSnoreToast = mock(
            (
                _executablePath: string,
                _args: string[],
                callback: (error?: Error | null) => void,
            ) => {
                const error = new Error(
                    "permission denied",
                ) as NodeJS.ErrnoException;
                error.code = "EACCES";
                callback(error);
            },
        );
        const write = mock((_value: string) => undefined);
        const warn = mock((_message: string) => undefined);
        const transport = createNotificationTransport({
            ...capabilities,
            platform: "linux",
            isWsl: true,
            isTTY: true,
            write,
            nativeNotify,
            snoreToastPath: "/fixture/snoretoast-x64.exe",
            launchSnoreToast,
            warn,
        });

        transport.send({
            type: "action-required",
            project: "demo-project",
            promptKind: "custom",
        });

        expect(nativeNotify).toHaveBeenCalledTimes(0);
        expect(launchSnoreToast).toHaveBeenCalledWith(
            "/fixture/snoretoast-x64.exe",
            [
                "-t",
                "Pi · demo-project",
                "-m",
                "Action required · custom dialog",
                "-s",
                "Notification.Default",
            ],
            expect.any(Function),
        );
        expect(write).toHaveBeenCalledTimes(1);
        expect(write).toHaveBeenCalledWith("\x07");
        expect(warn).toHaveBeenCalledWith(
            "[notify] Native notification failed: permission denied",
        );
    });

    it("sends a generic audible native prompt notification", () => {
        const nativeNotify = mock(
            (
                _options: NativeNotificationOptions,
                callback: (error?: Error | null) => void,
            ) => callback(null),
        );
        const write = mock((_value: string) => undefined);
        const transport = createNotificationTransport({
            ...capabilities,
            platform: "darwin",
            isWsl: false,
            isTTY: true,
            write,
            nativeNotify,
        });

        transport.send({
            type: "action-required",
            project: "demo-project",
            promptKind: "select",
        });

        expect(nativeNotify).toHaveBeenCalledTimes(1);
        expect(nativeNotify.mock.calls[0]?.[0]).toEqual({
            title: "Pi · demo-project",
            message: "Action required · selection",
            sound: true,
            wait: false,
        });
        expect(write).toHaveBeenCalledTimes(0);
    });

    it("formats generic completion stats without assistant content", () => {
        const nativeNotify = mock(
            (
                _options: NativeNotificationOptions,
                callback: (error?: Error | null) => void,
            ) => callback(null),
        );
        const transport = createNotificationTransport({
            ...capabilities,
            platform: "win32",
            isWsl: false,
            isTTY: true,
            write: mock(() => undefined),
            nativeNotify,
        });

        transport.send({
            type: "task-complete",
            project: "demo-project",
            elapsedSeconds: 12,
            turnCount: 2,
            filesChanged: 1,
        });

        expect(nativeNotify.mock.calls[0]?.[0]).toEqual({
            title: "Pi · demo-project",
            message: "Task complete · 12s · 2 turns · 1 file",
            sound: true,
            wait: false,
        });
    });

    it("uses only native delivery when a Linux desktop backend is available", () => {
        const write = mock((_value: string) => undefined);
        const transport = createNotificationTransport({
            ...capabilities,
            platform: "linux",
            isWsl: false,
            isTTY: true,
            write,
            nativeNotify: (_options, callback) => callback(null),
        });

        transport.send({
            type: "action-required",
            project: "demo-project",
            promptKind: "select",
        });

        expect(write).toHaveBeenCalledTimes(0);
    });

    it("uses WSL native sound without adding terminal BEL", () => {
        const write = mock((_value: string) => undefined);
        const transport = createNotificationTransport({
            ...capabilities,
            platform: "linux",
            isWsl: true,
            isTTY: true,
            write,
            nativeNotify: (_options, callback) => callback(null),
        });

        transport.send({
            type: "action-required",
            project: "demo-project",
            promptKind: "select",
        });

        expect(write).toHaveBeenCalledTimes(0);
    });

    it("falls back to one BEL when native notification reports an error", () => {
        const write = mock((_value: string) => undefined);
        const transport = createNotificationTransport({
            ...capabilities,
            platform: "win32",
            isWsl: false,
            isTTY: true,
            write,
            nativeNotify: (_options, callback) => {
                callback(new Error("native backend unavailable"));
            },
        });

        expect(() =>
            transport.send({
                type: "action-required",
                project: "demo-project",
                promptKind: "select",
            }),
        ).not.toThrow();
        expect(write).toHaveBeenCalledTimes(1);
        expect(write).toHaveBeenCalledWith("\x07");
    });

    it("does not duplicate BEL when Linux native delivery also fails", () => {
        const write = mock((_value: string) => undefined);
        const transport = createNotificationTransport({
            ...capabilities,
            platform: "linux",
            isWsl: false,
            isTTY: true,
            write,
            nativeNotify: (_options, callback) => {
                callback(new Error("notify-send unavailable"));
            },
        });

        transport.send({
            type: "action-required",
            project: "demo-project",
            promptKind: "select",
        });

        expect(write).toHaveBeenCalledTimes(1);
    });

    it("contains synchronous notifier failures and skips BEL when output is not a TTY", () => {
        const write = mock((_value: string) => undefined);
        const transport = createNotificationTransport({
            ...capabilities,
            platform: "linux",
            isWsl: false,
            isTTY: false,
            write,
            nativeNotify: () => {
                throw new Error("native backend crashed");
            },
        });

        expect(() =>
            transport.send({
                type: "action-required",
                project: "demo-project",
                promptKind: "select",
            }),
        ).not.toThrow();
        expect(write).toHaveBeenCalledTimes(0);
    });
});
