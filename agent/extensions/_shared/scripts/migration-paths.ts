import { lstatSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function assertNoSymlinkPath(path: string): void {
    let current = resolve(path);
    while (true) {
        try {
            if (lstatSync(current).isSymbolicLink())
                throw new Error(`Refusing symlink: ${current}`);
        } catch (error) {
            if (
                !(
                    error instanceof Error &&
                    "code" in error &&
                    error.code === "ENOENT"
                )
            )
                throw error;
        }
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
    }
}
