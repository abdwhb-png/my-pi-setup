import type { SshLaunch, SshProcess } from "../transport.ts";

type Listener<T> = (value: T) => void;

/**
 * In-memory `SshProcess` for tests. Lets a test assert the exact argv, stdin
 * payload, and failure handling of a remote command without a live host.
 *
 * It cannot establish anything about the generated shell script; that needs a
 * real shell, which `write-script.test.ts` does.
 */
export class FakeSshProcess implements SshProcess {
    readonly stdinWrites: (string | Buffer)[] = [];
    stdinEnded = false;
    /** Signals received, in order, so a test can assert SIGTERM then SIGKILL. */
    readonly killSignals: (NodeJS.Signals | undefined)[] = [];
    /** When true, `writeStdin` reports backpressure until `emitDrain`. */
    backpressure = false;
    private drainPending = false;
    private readonly drainListeners: Array<() => void> = [];
    private readonly stdinErrorListeners: Listener<Error>[] = [];
    private readonly stdoutListeners: Listener<Buffer>[] = [];
    private readonly stderrListeners: Listener<Buffer>[] = [];
    private readonly errorListeners: Listener<Error>[] = [];
    private readonly closeListeners: Listener<number | null>[] = [];

    writeStdin(chunk: string | Buffer): boolean {
        this.stdinWrites.push(chunk);
        if (this.backpressure) {
            this.drainPending = true;
            return false;
        }
        return true;
    }
    endStdin(): void {
        this.stdinEnded = true;
    }
    onStdinDrain(listener: () => void): void {
        this.drainListeners.push(listener);
    }
    onStdinError(listener: Listener<Error>): void {
        this.stdinErrorListeners.push(listener);
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
    kill(signal?: NodeJS.Signals): void {
        this.killSignals.push(signal);
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
    emitStdinError(error: Error): void {
        for (const listener of this.stdinErrorListeners) listener(error);
    }
    emitDrain(): void {
        this.drainPending = false;
        for (const listener of this.drainListeners) listener();
    }
    get waitingForDrain(): boolean {
        return this.drainPending;
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

export interface FakeLaunchOptions {
    /** Make `writeStdin` report backpressure until the test emits a drain. */
    backpressure?: boolean;
}

export function fakeLaunch(options: FakeLaunchOptions = {}): FakeLaunchHarness {
    const calls: string[][] = [];
    let current: FakeSshProcess | undefined;
    const launch: SshLaunch = (args) => {
        calls.push([...args]);
        const process = new FakeSshProcess();
        // Configured at construction, because the transport writes stdin
        // synchronously inside the call that spawns the child.
        process.backpressure = options.backpressure ?? false;
        current = process;
        return process;
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
