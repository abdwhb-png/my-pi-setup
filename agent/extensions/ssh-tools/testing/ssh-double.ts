import type { SshLaunch, SshProcess } from "../transport.ts";

type Listener<T> = (value: T) => void;

/**
 * In-memory `SshProcess` for tests. Lets a test assert the exact argv, stdin
 * payload, and failure handling of a remote command without a live host.
 */
export class FakeSshProcess implements SshProcess {
    readonly stdinWrites: (string | Buffer)[] = [];
    stdinEnded = false;
    killed = false;
    private readonly stdoutListeners: Listener<Buffer>[] = [];
    private readonly stderrListeners: Listener<Buffer>[] = [];
    private readonly errorListeners: Listener<Error>[] = [];
    private readonly closeListeners: Listener<number | null>[] = [];

    writeStdin(chunk: string | Buffer): void {
        this.stdinWrites.push(chunk);
    }
    endStdin(): void {
        this.stdinEnded = true;
    }
    onStdout(listener: Listener<Buffer>): void {
        this.stdoutListeners.push(listener);
    }
    onStderr(listener: Listener<Buffer>): void {
        this.stderrListeners.push(listener);
    }
    onError(listener: Listener<Error>): void {
        this.errorListeners.push(listener);
    }
    onClose(listener: Listener<number | null>): void {
        this.closeListeners.push(listener);
    }
    kill(): void {
        this.killed = true;
    }

    emitStdout(text: string): void {
        for (const listener of this.stdoutListeners)
            listener(Buffer.from(text));
    }
    emitStderr(text: string): void {
        for (const listener of this.stderrListeners)
            listener(Buffer.from(text));
    }
    emitError(error: Error): void {
        for (const listener of this.errorListeners) listener(error);
    }
    emitClose(code: number | null): void {
        for (const listener of this.closeListeners) listener(code);
    }
}

export interface FakeLaunchHarness {
    /** Every argv passed to ssh, in launch order. */
    readonly calls: string[][];
    readonly launch: SshLaunch;
    readonly process: FakeSshProcess;
}

export function fakeLaunch(): FakeLaunchHarness {
    const calls: string[][] = [];
    let current: FakeSshProcess | undefined;
    const launch: SshLaunch = (args) => {
        calls.push([...args]);
        current = new FakeSshProcess();
        return current;
    };
    return {
        calls,
        launch,
        get process() {
            if (!current) throw new Error("ssh was not launched");
            return current;
        },
    };
}
