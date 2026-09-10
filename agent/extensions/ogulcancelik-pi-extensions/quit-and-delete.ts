import { readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Key, type KeyId } from "@earendil-works/pi-tui";

const PACKAGE_NAME = "@ogulcancelik/pi-quit-and-delete";
const ENV_VAR = "PI_QUIT_AND_DELETE_SHORTCUT";
const DEFAULT_SHORTCUT = "ctrl+shift+x";
const BASE_KEYS = new Set<string>(
    Object.values(Key).filter((value) => typeof value === "string"),
);

function isShortcut(value: unknown): value is KeyId {
    if (typeof value !== "string") return false;
    const parts = value.split("+");
    const key = parts.pop();
    return (
        key !== undefined &&
        (BASE_KEYS.has(key) || /^[a-z0-9]$/.test(key)) &&
        parts.every((part) =>
            ["ctrl", "alt", "shift", "super"].includes(part),
        ) &&
        new Set(parts).size === parts.length
    );
}

function isEnoent(err: unknown): boolean {
    return (
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as Record<string, unknown>).code === "ENOENT"
    );
}

function resolveShortcut(): KeyId {
    const env = process.env[ENV_VAR];
    if (env) return isShortcut(env) ? env : DEFAULT_SHORTCUT;

    try {
        const settingsPath = join(getAgentDir(), "settings.json");
        const raw = readFileSync(settingsPath, "utf-8");
        const settings = JSON.parse(raw) as Record<string, unknown>;
        const ext = settings[PACKAGE_NAME] as
            | Record<string, unknown>
            | undefined;
        if (isShortcut(ext?.shortcut)) {
            return ext.shortcut;
        }
    } catch {
        // settings.json missing or malformed — ignore
    }

    return DEFAULT_SHORTCUT;
}

function restoreTerminal() {
    // cursor visibility, bracketed paste off, kitty keyboard pop
    process.stdout.write("\x1b[?25h\x1b[?2004l\x1b[<u");
}

// override: export PI_QUIT_AND_DELETE_SHORTCUT="ctrl+shift+x" or set in settings.json
export default function (pi: ExtensionAPI) {
    const shortcut = resolveShortcut();

    pi.registerShortcut(shortcut, {
        description: "Quit pi and permanently delete the active session file",
        handler: async (ctx) => {
            const sessionFile = ctx.sessionManager.getSessionFile();

            if (sessionFile) {
                try {
                    await unlink(sessionFile);
                } catch (err) {
                    if (!isEnoent(err)) {
                        const message =
                            err instanceof Error ? err.message : String(err);
                        // TUI toast won't render before process.exit — write to stderr
                        process.stderr.write(
                            `pi-quit-and-delete: failed to delete session: ${message}\n`,
                        );
                    }
                    // still exit — user's intent is to quit
                }
            }

            restoreTerminal();
            process.exit(0);
        },
    });
}
