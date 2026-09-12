import { constants } from "node:fs";
import { chmod, open, rm } from "node:fs/promises";
import type { Readable } from "node:stream";

import { readSandboxAdmission, type SandboxAdmission } from "./admission.ts";
import { SandboxExecutionError, type PrivateTempLease } from "./contracts.ts";
import {
    superviseZeroboxStatusStream,
    type ZeroboxStatusOptions,
} from "./zerobox-status.ts";

export interface ZeroboxStatusChannel {
    childStdio: number;
    supervise(options?: ZeroboxStatusOptions): {
        ready: Promise<void>;
        settled: Promise<void>;
    };
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

async function createZeroboxOutputChannel(lease: PrivateTempLease): Promise<{
    childStdio: number;
    receive<T>(reader: (stream: Readable) => T): T;
    dispose(): Promise<void>;
}> {
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
        receive<T>(reader: (stream: Readable) => T): T {
            if (supervised) {
                throw new SandboxExecutionError("protocol-error");
            }
            supervised = true;
            const status = reader(stream as Readable);
            void writeHandle.close().catch(() => undefined);
            return status;
        },
        dispose,
    };
}

export async function createZeroboxStatusChannel(
    lease: PrivateTempLease,
): Promise<ZeroboxStatusChannel> {
    const channel = await createZeroboxOutputChannel(lease);
    return {
        childStdio: channel.childStdio,
        supervise: (options) =>
            channel.receive((stream) =>
                superviseZeroboxStatusStream(stream, options),
            ),
        dispose: () => channel.dispose(),
    };
}

export async function createZeroboxAdmissionChannel(
    lease: PrivateTempLease,
): Promise<{
    childStdio: number;
    childAckStdio: number;
    read(): Promise<SandboxAdmission>;
    acknowledge(digest: string): Promise<void>;
    dispose(): Promise<void>;
}> {
    const channel = await createZeroboxOutputChannel(lease);
    let acknowledgement: ZeroboxInputChannel;
    try {
        acknowledgement = await createZeroboxInputChannel(lease.root);
    } catch (error) {
        await channel.dispose();
        throw error;
    }
    return {
        childStdio: channel.childStdio,
        childAckStdio: acknowledgement.childStdio,
        async read() {
            await acknowledgement.releaseParentRead();
            return channel.receive(readSandboxAdmission);
        },
        async acknowledge(digest) {
            if (!/^[a-f0-9]{64}$/.test(digest))
                throw new SandboxExecutionError("protocol-error");
            await acknowledgement.write(`ACK:${digest}\n`);
        },
        async dispose() {
            const results = await Promise.allSettled([
                channel.dispose(),
                acknowledgement.dispose(),
            ]);
            const errors: unknown[] = [];
            for (const result of results) {
                if (result.status === "rejected") errors.push(result.reason);
            }
            if (errors.length)
                throw new AggregateError(
                    errors,
                    "Admission channel cleanup failed",
                );
        },
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
