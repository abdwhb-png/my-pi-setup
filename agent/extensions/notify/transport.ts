import { spawn } from "node:child_process";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import notifier from "node-notifier";
import {
    getSnoreToastExecutablePath,
    isWslRuntime,
} from "../_shared/package-install/snoretoast.ts";

export type NotificationPromptKind =
    | "select"
    | "confirm"
    | "input"
    | "editor"
    | "custom";

export interface ActionRequiredNotification {
    type: "action-required";
    project: string;
    promptKind: NotificationPromptKind;
}

export interface TaskCompleteNotification {
    type: "task-complete";
    project: string;
    elapsedSeconds: number | null;
    turnCount: number;
    filesChanged: number;
}

export type PiNotificationEvent =
    | ActionRequiredNotification
    | TaskCompleteNotification;

export interface NativeNotificationOptions {
    title: string;
    message: string;
    sound: true;
    wait: false;
}

export interface NotificationTransportDeps {
    platform: NodeJS.Platform;
    isWsl: boolean;
    isTTY: boolean;
    write(value: string): void;
    nativeNotify(
        options: NativeNotificationOptions,
        callback: (error?: Error | null) => void,
    ): void;
    snoreToastPath?: string;
    launchSnoreToast?(
        executablePath: string,
        args: string[],
        callback: (error?: Error | null) => void,
    ): void;
    warn?(message: string): void;
}

export interface NotificationTransport {
    send(event: PiNotificationEvent): void;
}

const PROMPT_LABELS = {
    select: "selection",
    confirm: "confirmation",
    input: "text input",
    editor: "editor",
    custom: "custom dialog",
} as const satisfies Record<NotificationPromptKind, string>;

function formatMessage(event: PiNotificationEvent): string {
    if (event.type === "action-required") {
        return `Action required · ${PROMPT_LABELS[event.promptKind]}`;
    }

    const parts = ["Task complete"];
    if (event.elapsedSeconds !== null) {
        parts.push(`${event.elapsedSeconds}s`);
    }
    if (event.turnCount > 0) {
        parts.push(
            `${event.turnCount} turn${event.turnCount === 1 ? "" : "s"}`,
        );
    }
    if (event.filesChanged > 0) {
        parts.push(
            `${event.filesChanged} file${event.filesChanged === 1 ? "" : "s"}`,
        );
    }
    return parts.join(" · ");
}

function defaultDeps(): NotificationTransportDeps {
    const isWsl = isWslRuntime();
    return {
        platform: process.platform,
        isWsl,
        isTTY: process.stdout.isTTY,
        write: (value) => process.stdout.write(value),
        warn: (message) => console.warn(message),
        nativeNotify(options, callback) {
            notifier.notify(options, (error) => callback(error));
        },
        ...(isWsl
            ? {
                  snoreToastPath: getSnoreToastExecutablePath(getAgentDir()),
                  launchSnoreToast(
                      executablePath: string,
                      args: string[],
                      callback: (error?: Error | null) => void,
                  ) {
                      const child = spawn(executablePath, args, {
                          detached: true,
                          stdio: "ignore",
                          windowsHide: true,
                      });
                      child.once("error", (error) => callback(error));
                      child.once("spawn", () => callback(null));
                      child.unref();
                  },
              }
            : {}),
    };
}

function toSnoreToastArgs(options: NativeNotificationOptions): string[] {
    return [
        "-t",
        options.title,
        "-m",
        options.message,
        "-s",
        "Notification.Default",
    ];
}

export function createNotificationTransport(
    deps: NotificationTransportDeps = defaultDeps(),
): NotificationTransport {
    let warnedNativeFailure = false;

    return {
        send(event) {
            let rang = false;
            const ring = () => {
                if (rang || !deps.isTTY) return;
                rang = true;
                try {
                    deps.write("\x07");
                } catch {
                    // Terminal fallback is best-effort.
                }
            };
            const reportNativeFailure = (error: unknown) => {
                ring();
                if (warnedNativeFailure || deps.warn === undefined) return;
                warnedNativeFailure = true;
                deps.warn(
                    `[notify] Native notification failed: ${error instanceof Error ? error.message : String(error)}`,
                );
            };

            const options: NativeNotificationOptions = {
                title: `Pi · ${event.project}`,
                message: formatMessage(event),
                sound: true,
                wait: false,
            };

            if (
                deps.isWsl &&
                deps.snoreToastPath !== undefined &&
                deps.launchSnoreToast !== undefined
            ) {
                try {
                    deps.launchSnoreToast(
                        deps.snoreToastPath,
                        toSnoreToastArgs(options),
                        (error) => {
                            if (error) reportNativeFailure(error);
                        },
                    );
                } catch (error) {
                    reportNativeFailure(error);
                }
                return;
            }

            if (deps.platform === "linux" && !deps.isWsl) ring();

            try {
                deps.nativeNotify(options, (error) => {
                    if (error) reportNativeFailure(error);
                });
            } catch (error) {
                reportNativeFailure(error);
            }
        },
    };
}
