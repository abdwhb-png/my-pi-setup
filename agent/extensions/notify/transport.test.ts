import { describe, expect, it, mock } from "bun:test";
import {
    createNotificationTransport,
    type NativeNotificationOptions,
} from "./transport.ts";

describe("notification transport", () => {
    it("sends a generic audible native prompt notification", () => {
        const nativeNotify = mock(
            (
                _options: NativeNotificationOptions,
                callback: (error?: Error | null) => void,
            ) => callback(null),
        );
        const write = mock((_value: string) => undefined);
        const transport = createNotificationTransport({
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

    it("rings terminal BEL for Linux where native notifications lack sound", () => {
        const write = mock((_value: string) => undefined);
        const transport = createNotificationTransport({
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

        expect(write).toHaveBeenCalledTimes(1);
        expect(write).toHaveBeenCalledWith("\x07");
    });

    it("uses WSL native sound without adding terminal BEL", () => {
        const write = mock((_value: string) => undefined);
        const transport = createNotificationTransport({
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
