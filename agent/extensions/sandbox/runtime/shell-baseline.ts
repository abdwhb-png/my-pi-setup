import { homedir } from "node:os";
import { delimiter, resolve } from "node:path";

/**
 * Files required to start dynamically linked, system-provided shell programs.
 * Project and user paths remain separate explicit filesystem grants.
 */
export const SHELL_SYSTEM_READ_PATHS = [
    "/bin",
    "/sbin",
    "/usr",
    "/lib",
    "/lib64",
    "/etc/ld.so.cache",
    "/etc/ld.so.conf",
    "/etc/ld.so.conf.d",
] as const;

export const SHELL_SYSTEM_PATH_ENTRIES = [
    "/usr/local/bin",
    "/usr/local/sbin",
    "/usr/bin",
    "/usr/sbin",
    "/bin",
    "/sbin",
] as const;

function unique(values: string[]): string[] {
    return [...new Set(values)];
}

export function expandShellPathEntry(path: string): string {
    if (path === "~") return homedir();
    if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
    return path;
}

export function buildShellPath(entries: string[] = []): string {
    return unique([...entries, ...SHELL_SYSTEM_PATH_ENTRIES]).join(delimiter);
}
