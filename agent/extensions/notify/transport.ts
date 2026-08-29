import notifier from "node-notifier";

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
    return {
        platform: process.platform,
        isWsl:
            process.platform === "linux" &&
            Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP),
        isTTY: process.stdout.isTTY,
        write: (value) => process.stdout.write(value),
        nativeNotify(options, callback) {
            notifier.notify(options, (error) => callback(error));
        },
    };
}

export function createNotificationTransport(
    deps: NotificationTransportDeps = defaultDeps(),
): NotificationTransport {
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

            if (deps.platform === "linux" && !deps.isWsl) ring();

            try {
                deps.nativeNotify(
                    {
                        title: `Pi · ${event.project}`,
                        message: formatMessage(event),
                        sound: true,
                        wait: false,
                    },
                    (error) => {
                        if (error) ring();
                    },
                );
            } catch {
                ring();
            }
        },
    };
}
