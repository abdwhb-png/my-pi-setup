import { constants } from "node:fs";
import { chmod, open, rm } from "node:fs/promises";
import type { Readable } from "node:stream";

import { SandboxExecutionError, type PrivateTempLease } from "./contracts.ts";
import { superviseZeroboxStatusStream } from "./zerobox-status.ts";

export interface ZeroboxStatusChannel {
    childStdio: number;
    supervise(): { ready: Promise<void>; settled: Promise<void> };
    dispose(): Promise<void>;
}

export interface ZeroboxInputChannel {
    childStdio: number;
    releaseParentRead(): Promise<void>;
    write(value: string): Promise<void>;
    dispose(): Promise<void>;
}

let statusChannelCounter = 0;

async function createFifo(path: string, cwd: string): Promise<void> {
    const result = Bun.spawnSync(["/usr/bin/mkfifo", "--mode=600", path], {
        cwd,
        env: { PATH: "/usr/bin:/bin" },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
    });
    if (result.exitCode !== 0) {
        throw new SandboxExecutionError("setup-failed", {
            cause: new Error("Could not create private FIFO"),
        });
    }
    await chmod(path, 0o600);
}

export async function createZeroboxStatusChannel(
    lease: PrivateTempLease,
): Promise<ZeroboxStatusChannel> {
    statusChannelCounter = (statusChannelCounter + 1) % 1_000_000;
    const path = `${lease.root}/s-${process.pid.toString(36)}-${statusChannelCounter.toString(36)}.fifo`;
    await createFifo(path, lease.root);

    let readHandle;
    let writeHandle;
    try {
        [readHandle, writeHandle] = await Promise.all([
            open(path, constants.O_RDONLY),
            open(path, constants.O_WRONLY),
        ]);
    } catch (error) {
        await readHandle?.close().catch(() => undefined);
        await rm(path, { force: true });
        throw new SandboxExecutionError("setup-failed", { cause: error });
    }
    const stream = readHandle.createReadStream({ autoClose: false });
    let supervised = false;
    let disposed = false;

    const dispose = async () => {
        if (disposed) return;
        disposed = true;
        stream.destroy();
        await Promise.allSettled([readHandle.close(), writeHandle.close()]);
        await rm(path, { force: true });
    };

    return {
        childStdio: writeHandle.fd,
        supervise() {
            if (supervised) {
                const error = new SandboxExecutionError("protocol-error");
                return {
                    ready: Promise.reject(error),
                    settled: Promise.reject(error),
                };
            }
            supervised = true;
            const status = superviseZeroboxStatusStream(stream as Readable);
            void writeHandle.close().catch(() => undefined);
            return status;
        },
        dispose,
    };
}

export async function createZeroboxInputChannel(
    root: string,
): Promise<ZeroboxInputChannel> {
    statusChannelCounter = (statusChannelCounter + 1) % 1_000_000;
    const path = `${root}/i-${process.pid.toString(36)}-${statusChannelCounter.toString(36)}.fifo`;
    await createFifo(path, root);

    let readHandle;
    let writeHandle;
    try {
        [readHandle, writeHandle] = await Promise.all([
            open(path, constants.O_RDONLY),
            open(path, constants.O_WRONLY),
        ]);
    } catch (error) {
        await readHandle?.close().catch(() => undefined);
        await writeHandle?.close().catch(() => undefined);
        await rm(path, { force: true });
        throw new SandboxExecutionError("setup-failed", { cause: error });
    }
    let disposed = false;
    let readReleased = false;
    let writeReleased = false;
    let written = false;

    return {
        childStdio: readHandle.fd,
        async releaseParentRead() {
            if (readReleased) return;
            readReleased = true;
            await readHandle.close();
        },
        async write(value: string) {
            if (written || disposed) {
                throw new SandboxExecutionError("protocol-error");
            }
            written = true;
            try {
                await writeHandle.writeFile(value, "utf8");
            } finally {
                if (!writeReleased) {
                    writeReleased = true;
                    await writeHandle.close().catch(() => undefined);
                }
            }
        },
        async dispose() {
            if (disposed) return;
            disposed = true;
            const closes: Promise<void>[] = [];
            if (!readReleased) {
                readReleased = true;
                closes.push(readHandle.close());
            }
            if (!writeReleased) {
                writeReleased = true;
                closes.push(writeHandle.close());
            }
            await Promise.allSettled(closes);
            await rm(path, { force: true });
        },
    };
}
