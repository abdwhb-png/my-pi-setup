import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

/** The inherited file description retains flock ownership until close or process exit. */
export function withSandboxPublicationLockSync<T>(
    globalPath: string,
    action: () => T,
): T {
    mkdirSync(dirname(globalPath), { recursive: true, mode: 0o700 });
    const descriptor = openSync(
        globalPath + ".publish-lock",
        constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
    );
    try {
        const metadata = fstatSync(descriptor);
        if (
            !metadata.isFile() ||
            (metadata.mode & 0o022) !== 0 ||
            metadata.uid !== process.getuid?.()
        )
            throw new Error("Untrusted sandbox publication lock");
        const acquired = spawnSync(
            "/usr/bin/flock",
            ["--exclusive", "--nonblock", "3"],
            {
                stdio: ["ignore", "pipe", "pipe", descriptor],
                timeout: 5000,
            },
        );
        if (acquired.error)
            throw new Error(
                "Sandbox publication requires the system flock executable",
                { cause: acquired.error },
            );
        if (acquired.status === 1)
            throw new Error(
                "Another sandbox configuration update or recovery is running. Retry after it finishes.",
            );
        if (acquired.status !== 0)
            throw new Error("Could not acquire the sandbox publication lock");
        return action();
    } finally {
        // Keep the lock inode: unlinking it would let another process lock a different file.
        closeSync(descriptor);
    }
}
