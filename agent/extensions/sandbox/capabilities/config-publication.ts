import { randomUUID } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
    renameSync,
    unlinkSync,
    openSync,
    fsyncSync,
    closeSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** Caller holds the sandbox publication lock and has validated its authority. */
export function publishConfigFile(
    path: string,
    before: Buffer | undefined,
    next: Record<string, unknown>,
    options: { backup?: boolean; validate?: (temporary: string) => void } = {},
): boolean {
    const current = existsSync(path) ? readFileSync(path) : undefined;
    if (before === undefined ? current !== undefined : !current?.equals(before))
        throw new Error(`Configuration changed while editing: ${path}`);
    const body = JSON.stringify(next, null, 2) + "\n";
    if (
        current &&
        JSON.stringify(JSON.parse(current.toString())) === JSON.stringify(next)
    )
        return false;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = join(dirname(path), `.sandbox-${randomUUID()}.tmp`);
    try {
        writeFileSync(temporary, body, { mode: 0o600, flag: "wx" });
        options.validate?.(temporary);
        const latest = existsSync(path) ? readFileSync(path) : undefined;
        if (
            before === undefined
                ? latest !== undefined
                : !latest?.equals(before)
        )
            throw new Error(`Configuration changed while editing: ${path}`);
        if (options.backup && before)
            writeFileSync(path + "." + randomUUID() + ".backup", before, {
                mode: 0o600,
                flag: "wx",
            });
        const fd = openSync(temporary, "r");
        try {
            fsyncSync(fd);
        } finally {
            closeSync(fd);
        }
        renameSync(temporary, path);
        const dir = openSync(dirname(path), "r");
        try {
            fsyncSync(dir);
        } finally {
            closeSync(dir);
        }
        return true;
    } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
    }
}
