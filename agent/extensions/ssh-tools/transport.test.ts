import { describe, expect, it } from "bun:test";
import { fakeLaunch } from "./testing/ssh-double.ts";
import {
    buildProbeScript,
    buildSshArgs,
    buildWriteScript,
    sshExec,
    sshOk,
    remoteProbe,
} from "./transport.ts";

/** Pinned contract: stderr is capped at 64 KiB when the caller sets no cap. */
const DEFAULT_STDERR_CAP = 65_536;

function commandOf(harness: ReturnType<typeof fakeLaunch>, index = 0): string {
    return harness.calls[index]?.at(-1) ?? "";
}

describe("buildSshArgs", () => {
    it("forces non-interactive auth so a prompt cannot hang the tool", () => {
        expect(buildSshArgs("devlab", "pwd")).toContain("BatchMode=yes");
    });

    it("bounds the TCP connect phase", () => {
        expect(buildSshArgs("devlab", "pwd")).toContain("ConnectTimeout=10");
    });

    it("keeps the remote and command as the final two arguments", () => {
        const args = buildSshArgs("devlab", "pwd");
        expect(args.slice(-2)).toEqual(["devlab", "pwd"]);
    });

    it("passes every option as a separate -o argument pair", () => {
        const args = buildSshArgs("devlab", "pwd");
        for (const option of ["BatchMode=yes", "ConnectTimeout=10"]) {
            expect(args[args.indexOf(option) - 1]).toBe("-o");
        }
    });
});

describe("buildProbeScript with link detection", () => {
    it("checks -L before -e so a link is not hidden by the referent", () => {
        const script = buildProbeScript("/home/dev/app.conf", ["r", "w"], {
            detectLink: true,
        });
        expect(script).toContain("[ -L '/home/dev/app.conf' ]");
        expect(script.indexOf("[ -L ")).toBeLessThan(script.indexOf("[ -e "));
    });

    it("reports a distinct LINK result", () => {
        expect(
            buildProbeScript("/home/dev/app.conf", ["r"], { detectLink: true }),
        ).toContain("printf LINK");
    });

    it("omits the link check when detection is off", () => {
        const script = buildProbeScript("/home/dev/app.conf", ["r"]);
        expect(script).not.toContain("[ -L ");
    });
});

describe("transport lifetime", () => {
    it("never spawns for an already-aborted call", async () => {
        const harness = fakeLaunch();
        const controller = new AbortController();
        controller.abort();
        await expect(
            sshExec("devlab", "sleep 60", {
                signal: controller.signal,
                spawnFn: harness.launch,
            }),
        ).rejects.toThrow("aborted");
        expect(harness.calls).toHaveLength(0);
    });

    it("rejects on a stdin error instead of leaving it uncaught", async () => {
        const harness = fakeLaunch();
        const pending = sshExec("devlab", "cat", {
            stdin: "payload",
            spawnFn: harness.launch,
        });
        // ssh died mid-transfer: the pipe breaks.
        harness.process.emitStdinError(new Error("EPIPE"));
        await expect(pending).rejects.toThrow("EPIPE");
    });

    it("settles once even when stdin errors and the child then closes", async () => {
        const harness = fakeLaunch();
        const pending = sshExec("devlab", "cat", {
            stdin: "payload",
            spawnFn: harness.launch,
        });
        harness.process.emitStdinError(new Error("EPIPE"));
        harness.process.emitClose(1);
        const message = await pending.then(
            () => "",
            (error: Error) => error.message,
        );
        expect(message).toBe("EPIPE");
    });

    it("ends stdin immediately when the write does not fill the buffer", async () => {
        const harness = fakeLaunch();
        const pending = sshExec("devlab", "cat", {
            stdin: "small",
            spawnFn: harness.launch,
        });
        expect(harness.process.stdinEnded).toBe(true);
        harness.process.emitClose(0);
        await pending;
    });

    it("waits for drain before ending stdin when the buffer fills", async () => {
        const harness = fakeLaunch({ backpressure: true });
        const pending = sshExec("devlab", "cat", {
            stdin: "large",
            spawnFn: harness.launch,
        });
        // Ending stdin here would truncate what the remote command reads.
        expect(harness.process.stdinEnded).toBe(false);
        expect(harness.process.waitingForDrain).toBe(true);
        harness.process.emitDrain();
        expect(harness.process.stdinEnded).toBe(true);
        harness.process.emitClose(0);
        await pending;
    });

    it("escalates to SIGKILL when the child ignores SIGTERM", async () => {
        const harness = fakeLaunch();
        const controller = new AbortController();
        const pending = sshExec("devlab", "sleep 60", {
            signal: controller.signal,
            killGraceMs: 0.02,
            spawnFn: harness.launch,
        });
        controller.abort();
        expect(harness.process.killSignals).toEqual(["SIGTERM"]);
        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(harness.process.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
        harness.process.emitClose(null);
        await expect(pending).rejects.toThrow("aborted");
    });

    it("bounds retained output while still streaming every byte", async () => {
        const harness = fakeLaunch();
        const streamed: number[] = [];
        const pending = sshExec("devlab", "yes", {
            maxRetainedOutputBytes: 10,
            onStdoutData: (chunk) => streamed.push(chunk.length),
            spawnFn: harness.launch,
        });
        harness.process.emitStdout("x".repeat(50));
        harness.process.emitClose(0);
        const result = await pending;
        expect(result.stdout.length).toBe(10);
        expect(streamed).toEqual([50]);
    });

    it("bounds diagnostic stderr for the error message", async () => {
        const harness = fakeLaunch();
        const pending = sshOk("devlab", "false", {
            maxRetainedOutputBytes: 5,
            onStdoutData: () => undefined,
            spawnFn: harness.launch,
        });
        harness.process.emitStderr("permission denied for the target path");
        harness.process.emitClose(1);
        const message = await pending.then(
            () => "",
            (error: Error) => error.message,
        );
        // Bounded, so a huge dump cannot flood the error text.
        expect(message).toContain("permi");
        expect(message).not.toContain("target path");
    });

    it("never truncates a data-returning read, because a short file looks like a different file", async () => {
        const harness = fakeLaunch();
        const pending = sshOk("devlab", "cat /home/dev/big.txt", {
            maxRetainedOutputBytes: 5,
            spawnFn: harness.launch,
        });
        harness.process.emitStdout("y".repeat(500));
        harness.process.emitClose(0);
        const result = await pending;
        expect(result.length).toBe(500);
    });

    it("rejects a data call that exceeds the hard data limit instead of truncating it", async () => {
        const harness = fakeLaunch();
        const pending = sshOk("devlab", "cat /home/dev/huge.bin", {
            maxDataBytes: 10,
            spawnFn: harness.launch,
        });
        harness.process.emitStdout("z".repeat(50));
        await expect(pending).rejects.toThrow("exceeded the 10 byte limit");
    });

    it("escalates to SIGKILL even when the data limit already settled the promise", async () => {
        const harness = fakeLaunch();
        const pending = sshOk("devlab", "cat /home/dev/huge.bin", {
            maxDataBytes: 10,
            killGraceMs: 0.02,
            spawnFn: harness.launch,
        });
        harness.process.emitStdout("z".repeat(50));
        await expect(pending).rejects.toThrow("exceeded the 10 byte limit");
        // The promise is settled but the process is still running, and a child
        // that ignores SIGTERM must still be escalated. Gating the escalation
        // on promise settlement rather than process closure leaves it alive.
        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(harness.process.killSignals).toEqual(["SIGTERM", "SIGKILL"]);
    });

    it("ignores output that arrives after the data limit settled", async () => {
        const harness = fakeLaunch();
        const pending = sshOk("devlab", "cat /home/dev/huge.bin", {
            maxDataBytes: 10,
            killGraceMs: 0.02,
            spawnFn: harness.launch,
        });
        harness.process.emitStdout("z".repeat(50));
        await expect(pending).rejects.toThrow("exceeded the 10 byte limit");
        const killsAtSettle = harness.process.killSignals.length;
        // A late chunk must not re-enter the limit branch and schedule more kills.
        harness.process.emitStdout("z".repeat(50));
        expect(harness.process.killSignals.length).toBe(killsAtSettle);
    });

    it("caps stderr in data mode, where the stdout data limit does not apply", async () => {
        const harness = fakeLaunch();
        const pending = sshOk("devlab", "cat /home/dev/a.txt", {
            maxRetainedOutputBytes: 5,
            maxDataBytes: 1000,
            spawnFn: harness.launch,
        });
        harness.process.emitStderr("e".repeat(200));
        harness.process.emitClose(1);
        const message = await pending.then(
            () => "",
            (error: Error) => error.message,
        );
        // stdout keeps its own 16 MiB budget, but stderr is only diagnostic.
        expect(message).not.toContain("e".repeat(6));
    });

    it("caps stderr at a default budget when the caller sets none", async () => {
        const harness = fakeLaunch();
        const pending = sshExec("devlab", "cat /home/dev/a.txt", {
            spawnFn: harness.launch,
        });
        harness.process.emitStderr("e".repeat(DEFAULT_STDERR_CAP + 50));
        harness.process.emitClose(1);
        const result = await pending;
        // A hostile or chatty server must not grow local memory without bound.
        expect(result.stderr.length).toBe(DEFAULT_STDERR_CAP);
    });

    it("reports an abort as aborted even when the stdin pipe breaks after it", async () => {
        const harness = fakeLaunch();
        const controller = new AbortController();
        const pending = sshExec("devlab", "cat", {
            stdin: "payload",
            signal: controller.signal,
            spawnFn: harness.launch,
        });
        controller.abort();
        // Killing the child breaks the pipe, so EPIPE lands after the abort and
        // would otherwise mask the "aborted" contract pi matches on.
        harness.process.emitStdinError(new Error("EPIPE"));
        await expect(pending).rejects.toThrow("aborted");
    });

    it("reports a timeout even when the stdin pipe breaks after it", async () => {
        const harness = fakeLaunch();
        const pending = sshExec("devlab", "cat", {
            stdin: "payload",
            timeoutSeconds: 0.02,
            spawnFn: harness.launch,
        });
        await new Promise((resolve) => setTimeout(resolve, 60));
        harness.process.emitStdinError(new Error("EPIPE"));
        await expect(pending).rejects.toThrow("timeout:0.02");
    });
});

describe("remoteProbe link results", () => {
    it("returns LINK for a symlinked path", async () => {
        const harness = fakeLaunch();
        const pending = remoteProbe(
            "devlab",
            "/home/dev/link.conf",
            ["r"],
            { spawnFn: harness.launch, detectLink: true },
        );
        expect(commandOf(harness, 0)).toContain("[ -L '/home/dev/link.conf' ]");
        harness.process.emitStdout("LINK");
        harness.process.emitClose(0);
        expect(await pending).toBe("LINK");
    });
});

describe("buildWriteScript", () => {
    it("never inlines file content in the remote command", () => {
        expect(buildWriteScript("/home/dev/app.conf", 5)).not.toContain("base64");
    });

    it("creates the temp with mktemp so two writers get distinct inodes", () => {
        const script = buildWriteScript("/home/dev/app.conf", 5);
        expect(script).toContain("mktemp");
        expect(script).toContain("XXXXXX");
    });

    it("puts the temp in the target directory so mv stays on one filesystem", () => {
        const script = buildWriteScript("/home/dev/nested/app.conf", 5);
        expect(script).toContain("'/home/dev/nested/.pi-ssh.XXXXXX'");
    });

    it("does not derive the temp name from the target", () => {
        // A shared temp path lets one writer truncate another's temp, or follow
        // a pre-existing symlink at that exact name.
        const script = buildWriteScript("/home/dev/app.conf", 5);
        expect(script).not.toContain("app.conf.pi-ssh.tmp");
    });

    it("cleans the temp on every exit, not only a failed cat", () => {
        const script = buildWriteScript("/home/dev/app.conf", 5);
        expect(script).toContain("trap");
        expect(script).toContain('rm -rf "$tmpdir"');
    });

    it("keeps the cleanup trap armed after a successful rename", () => {
        // The payload has been moved out, so the trap only has an empty
        // directory left. Disabling it would leak one directory per write.
        const script = buildWriteScript("/home/dev/app.conf", 5);
        expect(script).not.toContain("trap - EXIT");
    });

    it("refuses an unsafe target before allocating any staging space", () => {
        const script = buildWriteScript("/home/dev/app.conf", 5);
        // A rejected target should leave no trace in the remote directory.
        expect(script.indexOf("[ -d ")).toBeLessThan(script.indexOf("mktemp"));
        expect(script.indexOf("[ -L ")).toBeLessThan(script.indexOf("mktemp"));
    });

    it("rejects a directory target before the rename", () => {
        // `mv -f file dir` succeeds by moving the file *into* the directory.
        const script = buildWriteScript("/home/dev/app.conf", 5);
        expect(script).toContain("[ -d '/home/dev/app.conf' ]");
    });

    it("rejects a symlinked target so the link is not silently replaced", () => {
        const script = buildWriteScript("/home/dev/app.conf", 5);
        expect(script).toContain("[ -L '/home/dev/app.conf' ]");
    });

    it("verifies the transferred byte count before renaming", () => {
        // `cat` exits 0 on early EOF, so exit status alone does not prove the
        // content arrived.
        const script = buildWriteScript("/home/dev/app.conf", 4096);
        expect(script).toContain("wc -c");
        expect(script).toContain("4096");
    });

    it("removes the temp when the byte count does not match", () => {
        const script = buildWriteScript("/home/dev/app.conf", 4096);
        expect(script).toContain("short write");
    });

    it("quotes a target path containing a space", () => {
        const script = buildWriteScript("/home/dev/my app.conf", 5);
        expect(script).toContain("'/home/dev/my app.conf'");
    });

    it("does not use mv -T, which busybox and BSD mv lack", () => {
        expect(buildWriteScript("/home/dev/app.conf", 5)).not.toContain("mv -T");
    });
});

describe("buildProbeScript", () => {
    it("discriminates existence and readability in one round trip", () => {
        const script = buildProbeScript("/home/dev/app.conf", ["r"]);
        expect(script).toContain("[ -e '/home/dev/app.conf' ]");
        expect(script).toContain("[ -r '/home/dev/app.conf' ]");
        expect(script).toContain("NOENT");
        expect(script).toContain("NOACCESS");
    });

    it("checks writability too when asked for read-write access", () => {
        expect(buildProbeScript("/home/dev/app.conf", ["r", "w"])).toContain(
            "[ -w '/home/dev/app.conf' ]",
        );
    });
});

describe("sshExec", () => {
    it("sends payload over stdin instead of the command line", async () => {
        const harness = fakeLaunch();
        const pending = sshExec("devlab", buildWriteScript("/tmp/a", 5), {
            stdin: "hello",
            spawnFn: harness.launch,
        });
        harness.process.stdinWrites.forEach(() => undefined);
        await Promise.resolve();
        expect(harness.process.stdinWrites).toEqual(["hello"]);
        expect(harness.calls[0].join(" ")).not.toContain("hello");
        harness.process.emitClose(0);
        await pending;
    });

    it("closes stdin so the remote command sees EOF", async () => {
        const harness = fakeLaunch();
        const pending = sshExec("devlab", "cat", {
            stdin: "hello",
            spawnFn: harness.launch,
        });
        await Promise.resolve();
        expect(harness.process.stdinEnded).toBe(true);
        harness.process.emitClose(0);
        await pending;
    });

    it("collects stdout and stderr and the exit code", async () => {
        const harness = fakeLaunch();
        const pending = sshExec("devlab", "pwd", { spawnFn: harness.launch });
        harness.process.emitStdout("out");
        harness.process.emitStderr("err");
        harness.process.emitClose(0);
        const result = await pending;
        expect(result.stdout.toString()).toBe("out");
        expect(result.stderr.toString()).toBe("err");
        expect(result.exitCode).toBe(0);
    });

    it("rejects with the aborted message contract pi expects", async () => {
        const harness = fakeLaunch();
        const controller = new AbortController();
        const pending = sshExec("devlab", "sleep 60", {
            signal: controller.signal,
            spawnFn: harness.launch,
        });
        controller.abort();
        expect(harness.process.killSignals[0]).toBe("SIGTERM");
        harness.process.emitClose(null);
        await expect(pending).rejects.toThrow("aborted");
    });

    it("rejects with the timeout message contract pi expects", async () => {
        const harness = fakeLaunch();
        const pending = sshExec("devlab", "sleep 60", {
            timeoutSeconds: 0.02,
            spawnFn: harness.launch,
        });
        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(harness.process.killSignals[0]).toBe("SIGTERM");
        harness.process.emitClose(null);
        await expect(pending).rejects.toThrow("timeout:0.02");
    });

    it("surfaces a spawn failure instead of hanging", async () => {
        const harness = fakeLaunch();
        const pending = sshExec("devlab", "pwd", { spawnFn: harness.launch });
        harness.process.emitError(new Error("ssh not found"));
        await expect(pending).rejects.toThrow("ssh not found");
    });
});

describe("sshOk", () => {
    it("returns stdout on success", async () => {
        const harness = fakeLaunch();
        const pending = sshOk("devlab", "pwd", { spawnFn: harness.launch });
        harness.process.emitStdout("/home/dev");
        harness.process.emitClose(0);
        expect((await pending).toString()).toBe("/home/dev");
    });

    it("reports an ssh transport failure with the remote stderr verbatim", async () => {
        const harness = fakeLaunch();
        const pending = sshOk("devlab", "pwd", { spawnFn: harness.launch });
        harness.process.emitStderr(
            "Host key verification failed.\nPermission denied (publickey).",
        );
        harness.process.emitClose(255);
        await expect(pending).rejects.toThrow(
            "Host key verification failed.\nPermission denied (publickey).",
        );
    });

    it("names the remote host on a transport failure", async () => {
        const harness = fakeLaunch();
        const pending = sshOk("devlab", "pwd", { spawnFn: harness.launch });
        harness.process.emitStderr("Permission denied (publickey).");
        harness.process.emitClose(255);
        await expect(pending).rejects.toThrow("devlab");
    });

    it("never reports the placeholder unknown ssh error", async () => {
        const harness = fakeLaunch();
        const pending = sshOk("devlab", "test -r '/nope'", {
            spawnFn: harness.launch,
        });
        harness.process.emitClose(1);
        const message = await pending.then(
            () => "",
            (error: Error) => error.message,
        );
        expect(message).not.toContain("unknown ssh error");
        expect(message).toContain("devlab");
    });

    it("reports a non-zero remote exit with the remote exit code", async () => {
        const harness = fakeLaunch();
        const pending = sshOk("devlab", "false", { spawnFn: harness.launch });
        harness.process.emitClose(1);
        await expect(pending).rejects.toThrow("1");
    });
});

describe("remoteProbe", () => {
    it("returns OK for an accessible path", async () => {
        const harness = fakeLaunch();
        const pending = remoteProbe("devlab", "/home/dev/app.conf", ["r"], {
            spawnFn: harness.launch,
        });
        harness.process.emitStdout("OK");
        harness.process.emitClose(0);
        expect(await pending).toBe("OK");
    });

    it("returns NOENT for a missing path", async () => {
        const harness = fakeLaunch();
        const pending = remoteProbe("devlab", "/home/dev/gone", ["r"], {
            spawnFn: harness.launch,
        });
        harness.process.emitStdout("NOENT");
        harness.process.emitClose(0);
        expect(await pending).toBe("NOENT");
    });

    it("returns NOACCESS when the permission test fails", async () => {
        const harness = fakeLaunch();
        const pending = remoteProbe("devlab", "/etc/shadow", ["r"], {
            spawnFn: harness.launch,
        });
        harness.process.emitStdout("NOACCESS");
        harness.process.emitClose(0);
        expect(await pending).toBe("NOACCESS");
    });
});
