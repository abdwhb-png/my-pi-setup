import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
    env: NodeJS.ProcessEnv;
    hasExecutable(path: string): boolean;
    nativeExecutable?: string;
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
    getStatus(): {
        channel: "native" | "osc9" | "bell" | "none";
        reasons: string[];
    };
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
        env: process.env,
        hasExecutable: (path) => Bun.which(path) !== null,
        nativeExecutable: join(
            dirname(
                fileURLToPath(
                    import.meta.resolve("node-notifier/package.json"),
                ),
            ),
            "vendor/mac.noindex/terminal-notifier.app/Contents/MacOS/terminal-notifier",
        ),
        snoreToastPath: getSnoreToastExecutablePath(getAgentDir()),
        write: (value) => process.stdout.write(value),
        warn: (message) => console.warn(message),
        nativeNotify(options, callback) {
            notifier.notify(options, (error) => callback(error));
        },
        ...(isWsl
            ? {
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
    const reasons: string[] = [];
    let native = false;
    if (deps.isWsl || deps.platform === "win32") {
        native = Boolean(
            deps.snoreToastPath && deps.hasExecutable(deps.snoreToastPath),
        );
        if (!native)
            reasons.push(
                "Native skipped: SnoreToast executable is unavailable.",
            );
    } else if (deps.platform === "darwin") {
        native = Boolean(
            deps.nativeExecutable && deps.hasExecutable(deps.nativeExecutable),
        );
        if (!native)
            reasons.push(
                "Native skipped: terminal-notifier executable is unavailable.",
            );
    } else if (deps.platform === "linux") {
        if (!deps.env.DISPLAY && !deps.env.WAYLAND_DISPLAY) {
            reasons.push("Native skipped: no desktop display in this session.");
        } else {
            native = deps.hasExecutable("notify-send");
            if (!native)
                reasons.push(
                    "Native skipped: notify-send is unavailable on PATH.",
                );
        }
    } else reasons.push("Native skipped: unsupported platform.");
    const multiplexed = Boolean(
        deps.env.TMUX ||
        deps.env.STY ||
        deps.env.TERM?.startsWith("screen") ||
        deps.env.TERM?.startsWith("tmux"),
    );
    let osc =
        !multiplexed &&
        (Boolean(deps.env.KITTY_WINDOW_ID) ||
            /^(ghostty|iterm\.app|wezterm)$/i.test(
                deps.env.TERM_PROGRAM ?? "",
            ) ||
            /^(xterm-ghostty|xterm-kitty)$/.test(deps.env.TERM ?? ""));
    let bell = true;
    if (!deps.isTTY) reasons.push("Terminal skipped: output is not a TTY.");
    else if (!osc)
        reasons.push(
            multiplexed
                ? "OSC 9 skipped: terminal multiplexer passthrough is not confirmed."
                : "OSC 9 skipped: terminal support is not confirmed.",
        );

    const getStatus: NotificationTransport["getStatus"] = () => ({
        channel: !deps.isTTY
            ? "none"
            : native
              ? "native"
              : osc
                ? "osc9"
                : bell
                  ? "bell"
                  : "none",
        reasons: [...reasons],
    });
    function failed(channel: "native" | "osc9" | "bell", error: unknown): void {
        if (channel === "native") native = false;
        else if (channel === "osc9") osc = false;
        else bell = false;
        const message = `${channel === "native" ? "Native notification" : channel + " notification"} failed: ${error instanceof Error ? error.message : String(error)}`;
        reasons.push(message);
        deps.warn?.(`[notify] ${message}`);
    }
    function send(event: PiNotificationEvent): void {
        const channel = getStatus().channel;
        if (channel === "none") return;
        if (channel === "native") {
            const options: NativeNotificationOptions = {
                title: `Pi · ${event.project}`,
                message: formatMessage(event),
                sound: true,
                wait: false,
            };
            let settled = false;
            const delivered = (error?: Error | null) => {
                if (settled) return;
                settled = true;
                if (error) {
                    failed("native", error);
                    send(event);
                }
            };
            try {
                if (
                    deps.isWsl &&
                    deps.snoreToastPath &&
                    deps.launchSnoreToast
                ) {
                    deps.launchSnoreToast(
                        deps.snoreToastPath,
                        toSnoreToastArgs(options),
                        delivered,
                    );
                } else deps.nativeNotify(options, delivered);
            } catch (error) {
                delivered(
                    error instanceof Error ? error : new Error(String(error)),
                );
            }
        } else {
            try {
                const text =
                    `Pi · ${event.project} · ${formatMessage(event)}`.replace(
                        /\p{Cc}/gu,
                        " ",
                    );
                deps.write(
                    channel === "osc9" ? `\x1b]9;${text}\x1b\\` : "\x07",
                );
            } catch (error) {
                failed(channel, error);
                send(event);
            }
        }
    }
    return { send, getStatus };
}
