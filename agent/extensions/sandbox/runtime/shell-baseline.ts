import { homedir } from "node:os";
import { delimiter, resolve } from "node:path";

export const PRIVATE_RUNTIME_ROOT = "/__zerobox";
export const PRIVATE_SHELL_ROOT = `${PRIVATE_RUNTIME_ROOT}/runtime`;
export const PRIVATE_ANALYSIS_ROOT = `${PRIVATE_RUNTIME_ROOT}/analysis`;
export const PRIVATE_SHELL_PATH = `${PRIVATE_SHELL_ROOT}/bin`;
export const PRIVATE_BASH = `${PRIVATE_SHELL_PATH}/bash`;

/** Host system reads always require an explicit grant. */
export const SHELL_SYSTEM_READ_PATHS: readonly string[] = [];
export const SHELL_SYSTEM_PATH_ENTRIES = [PRIVATE_SHELL_PATH] as const;

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
