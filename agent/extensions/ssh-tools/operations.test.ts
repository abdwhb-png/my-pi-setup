import { describe, expect, it } from "bun:test";
import { fakeLaunch } from "./testing/ssh-double.ts";
import {
    type ActiveSshTarget,
    createRemoteBashOps,
    createRemoteEditOps,
    createRemoteReadOps,
    createRemoteWriteOps,
} from "./operations.ts";

const LOCAL_CWD = "/home/abdwhb/projects/cryptoLoan/crypto-vault";

const target: ActiveSshTarget = {
    name: "devlab",
    remote: "devlab",
    remoteCwd: "/home/dev",
};

const noData = () => undefined;

function commandOf(harness: ReturnType<typeof fakeLaunch>, index = 0) {
    return harness.calls[index]?.at(-1) ?? "";
}

describe("interrupted write reporting", () => {
    it("reports the outcome as unknown when the write is aborted", async () => {
        const harness = fakeLaunch();
        const controller = new AbortController();
        const ops = createRemoteWriteOps(target, {
            spawnFn: harness.launch,
            signal: controller.signal,
        });
        const pending = ops.writeFile("/home/dev/app.conf", "PORT=3000\n");
        controller.abort();
        harness.process.emitClose(null);
        await expect(pending).rejects.toThrow("UNKNOWN");
    });

    it("tells the model not to retry blindly", async () => {
        const harness = fakeLaunch();
        const controller = new AbortController();
        const ops = createRemoteEditOps(target, {
            spawnFn: harness.launch,
            signal: controller.signal,
        });
        const pending = ops.writeFile("/home/dev/app.conf", "PORT=3000\n");
        controller.abort();
        harness.process.emitClose(null);
        await expect(pending).rejects.toThrow("Do not retry blindly");
    });

    it("does not claim unknown outcome on a clean non-zero exit", async () => {
        const harness = fakeLaunch();
        const ops = createRemoteWriteOps(target, { spawnFn: harness.launch });
        const pending = ops.writeFile("/home/dev/app.conf", "x");
        // A reported failure is a real failure: the remote script ran to
        // completion, so it is known whether the rename happened.
        harness.process.emitClose(1);
        const message = await pending.then(
            () => "",
            (error: Error) => error.message,
        );
        expect(message).not.toContain("UNKNOWN");
    });

    it("reports unknown outcome when the child is killed by an external signal", async () => {
        const harness = fakeLaunch();
        const ops = createRemoteWriteOps(target, { spawnFn: harness.launch });
        const pending = ops.writeFile("/home/dev/app.conf", "x");
        // A null exit code means no code was reported at all, so whether the
        // remote rename committed is unknown, exactly as for a dropped transfer.
        harness.process.emitClose(null);
        await expect(pending).rejects.toThrow("UNKNOWN");
    });

    it("states that a committed write landed when the turn is aborted first", async () => {
        const harness = fakeLaunch();
        const controller = new AbortController();
        const ops = createRemoteWriteOps(target, {
            spawnFn: harness.launch,
            signal: controller.signal,
        });
        const pending = ops.writeFile("/home/dev/app.conf", "x");
        harness.process.emitClose(0);
        // The rename committed. pi's write factory re-checks the signal after
        // writeFile returns and would throw a bare "Operation aborted", which
        // reads as "nothing happened" and invites a duplicate write.
        controller.abort();
        await expect(pending).rejects.toThrow("completed on the remote");
    });

    it("tells the model not to retry a write that already committed", async () => {
        const harness = fakeLaunch();
        const controller = new AbortController();
        const ops = createRemoteEditOps(target, {
            spawnFn: harness.launch,
            signal: controller.signal,
        });
        const pending = ops.writeFile("/home/dev/app.conf", "x");
        harness.process.emitClose(0);
        controller.abort();
        await expect(pending).rejects.toThrow("Do not retry");
    });

    it("reports unknown outcome when the connection dies after the rename", async () => {
        const harness = fakeLaunch();
        const ops = createRemoteWriteOps(target, { spawnFn: harness.launch });
        const pending = ops.writeFile("/home/dev/app.conf", "x");
        // ssh reserves 255 for its own failures, so a connection that drops
        // after the remote rename already committed is indistinguishable from
        // a session that never started. Reporting a plain failure would invite
        // a retry against a file that may already hold the new content.
        harness.process.emitStderr("Connection closed by remote host.");
        harness.process.emitClose(255);
        await expect(pending).rejects.toThrow("UNKNOWN");
    });

    it("keeps the underlying 255 detail as the cause of an unknown outcome", async () => {
        const harness = fakeLaunch();
        const ops = createRemoteWriteOps(target, { spawnFn: harness.launch });
        const pending = ops.writeFile("/home/dev/app.conf", "x");
        harness.process.emitStderr("Connection closed by remote host.");
        harness.process.emitClose(255);
        const error = await pending.then(
            () => undefined,
            (thrown: Error) => thrown,
        );
        // The remote's own diagnostic must survive into the structured cause
        // even though the outcome itself is unknown.
        const cause = error?.cause;
        const causeMessage = cause instanceof Error ? cause.message : String(cause);
        expect(causeMessage).toContain("Connection closed by remote host.");
        // And the exit code that made it an unknown outcome, not a known
        // failure, must be stated where the model reads it.
        expect(error?.message).toContain("255");
    });

    it("reports unknown outcome on a timeout", async () => {
        const harness = fakeLaunch();
        // A timeout has to be armed; without it a null exit code is just an
        // abnormal close, not an interrupted transfer.
        const ops = createRemoteWriteOps(target, {
            spawnFn: harness.launch,
            timeoutSeconds: 0.02,
        });
        const pending = ops.writeFile("/home/dev/app.conf", "x");
        await new Promise((resolve) => setTimeout(resolve, 60));
        harness.process.emitClose(null);
        await expect(pending).rejects.toThrow("UNKNOWN");
    });
});

describe("createRemoteBashOps", () => {
    it("rejects a non-positive timeout the way pi does", async () => {
        const harness = fakeLaunch();
        const ops = createRemoteBashOps(target, { spawnFn: harness.launch });
        const outcome = ops.exec("sleep 600", LOCAL_CWD, {
            onData: noData,
            timeout: -1,
        });
        // pi enforces this inside the LOCAL shell operations, which this
        // extension replaces. Validation must reject before spawning, which
        // also keeps this test from awaiting a call that never returns.
        expect(harness.calls).toHaveLength(0);
        await expect(outcome).rejects.toThrow(
            "Invalid timeout: must be a finite number of seconds",
        );
    });

    it("rejects a zero timeout", async () => {
        const harness = fakeLaunch();
        const ops = createRemoteBashOps(target, { spawnFn: harness.launch });
        const outcome = ops.exec("sleep 600", LOCAL_CWD, {
            onData: noData,
            timeout: 0,
        });
        expect(harness.calls).toHaveLength(0);
        await expect(outcome).rejects.toThrow(
            "Invalid timeout: must be a finite number of seconds",
        );
    });

    it("rejects a non-finite timeout", async () => {
        const harness = fakeLaunch();
        const ops = createRemoteBashOps(target, { spawnFn: harness.launch });
        const outcome = ops.exec("sleep 600", LOCAL_CWD, {
            onData: noData,
            timeout: Number.POSITIVE_INFINITY,
        });
        expect(harness.calls).toHaveLength(0);
        await expect(outcome).rejects.toThrow(
            "Invalid timeout: must be a finite number of seconds",
        );
    });

    it("rejects a timeout beyond the timer range", async () => {
        const harness = fakeLaunch();
        const ops = createRemoteBashOps(target, { spawnFn: harness.launch });
        const outcome = ops.exec("sleep 600", LOCAL_CWD, {
            onData: noData,
            timeout: 3_000_000,
        });
        expect(harness.calls).toHaveLength(0);
        await expect(outcome).rejects.toThrow("Invalid timeout: maximum is");
    });

    it("changes into the remote working directory, not the local one", async () => {
        const harness = fakeLaunch();
        const ops = createRemoteBashOps(target, { spawnFn: harness.launch });
        const pending = ops.exec("uname -a", LOCAL_CWD, { onData: noData });
        const script = harness.process.stdinWrites[0]?.toString() ?? "";
        expect(script).toContain("cd '/home/dev'");
        expect(script).not.toContain("crypto-vault");
        harness.process.emitClose(0);
        await pending;
    });

    it("still honours a cd written inside the command", async () => {
        const harness = fakeLaunch();
        const ops = createRemoteBashOps(target, { spawnFn: harness.launch });
        const pending = ops.exec("cd /tmp\npwd", LOCAL_CWD, { onData: noData });
        const script = harness.process.stdinWrites[0]?.toString() ?? "";
        expect(script).toContain("cd /tmp");
        expect(script.indexOf("cd '/home/dev'")).toBeLessThan(
            script.indexOf("cd /tmp"),
        );
        harness.process.emitClose(0);
        await pending;
    });

    it("keeps the command off the ssh command line", async () => {
        const harness = fakeLaunch();
        const ops = createRemoteBashOps(target, { spawnFn: harness.launch });
        const pending = ops.exec("rm -rf /important", LOCAL_CWD, {
            onData: noData,
        });
        expect(commandOf(harness)).toBe("exec bash -se");
        harness.process.emitClose(0);
        await pending;
    });

    it("explains an exit 255 instead of passing a bare code to the shell formatter", async () => {
        const harness = fakeLaunch();
        const ops = createRemoteBashOps(target, { spawnFn: harness.launch });
        const pending = ops.exec("false", LOCAL_CWD, { onData: noData });
        harness.process.emitStderr("Permission denied (publickey).");
        harness.process.emitClose(255);
        await expect(pending).rejects.toThrow(
            "SSH transport, host-key, or authentication failure",
        );
    });

    it("includes the remote output in the exit 255 message", async () => {
        const harness = fakeLaunch();
        const ops = createRemoteBashOps(target, { spawnFn: harness.launch });
        const pending = ops.exec("false", LOCAL_CWD, { onData: noData });
        harness.process.emitStderr("Permission denied (publickey).");
        harness.process.emitClose(255);
        const message = await pending.then(
            () => "",
            (error: Error) => error.message,
        );
        expect(message).toContain("Permission denied (publickey).");
    });

    it("still returns an ordinary non-zero exit code unchanged", async () => {
        const harness = fakeLaunch();
        const ops = createRemoteBashOps(target, { spawnFn: harness.launch });
        const pending = ops.exec("false", LOCAL_CWD, { onData: noData });
        harness.process.emitClose(1);
        expect(await pending).toEqual({ exitCode: 1 });
    });

    it("reports the remote exit code", async () => {
        const harness = fakeLaunch();
        const ops = createRemoteBashOps(target, { spawnFn: harness.launch });
        const pending = ops.exec("false", LOCAL_CWD, { onData: noData });
        harness.process.emitClose(3);
        expect(await pending).toEqual({ exitCode: 3 });
    });

    it("streams remote output to the caller's onData", async () => {
        const harness = fakeLaunch();
        const seen: string[] = [];
        const ops = createRemoteBashOps(target, { spawnFn: harness.launch });
        const pending = ops.exec("uname -a", LOCAL_CWD, {
            onData: (chunk) => seen.push(chunk.toString()),
        });
        harness.process.emitStdout("Linux devlab");
        harness.process.emitClose(0);
        await pending;
        expect(seen.join("")).toContain("Linux devlab");
    });

    it("forwards the caller's timeout to the transport", async () => {
        const harness = fakeLaunch();
        const ops = createRemoteBashOps(target, { spawnFn: harness.launch });
        const pending = ops.exec("sleep 60", LOCAL_CWD, {
            onData: noData,
            timeout: 0.02,
        });
        await new Promise((resolve) => setTimeout(resolve, 60));
        expect(harness.process.killSignals[0]).toBe("SIGTERM");
        harness.process.emitClose(null);
        await expect(pending).rejects.toThrow("timeout:0.02");
    });
});

describe("createRemoteReadOps", () => {
    it("refuses a path pi substituted from the local filesystem", async () => {
        const harness = fakeLaunch();
        const ops = createRemoteReadOps(target, "/home/dev/shot.png", {
            spawnFn: harness.launch,
        });
        // pi resolves the path against its LOCAL cwd and then probes the local
        // filesystem for macOS AM/PM, NFD, and curly-quote variants. A local
        // file can therefore become the path that reaches the remote, which
        // would read a file the extension never resolved.
        await expect(
            ops.readFile("/home/dev/shot\u202FAM.png"),
        ).rejects.toThrow("Refusing to read");
        // The guard must run before any ssh I/O.
        expect(harness.calls).toHaveLength(0);
    });

    it("refuses a substituted path on the access check too", async () => {
        const harness = fakeLaunch();
        const ops = createRemoteReadOps(target, "/home/dev/app.conf", {
            spawnFn: harness.launch,
        });
        await expect(ops.access("/home/dev/app’conf")).rejects.toThrow(
            "Refusing to read",
        );
        expect(harness.calls).toHaveLength(0);
    });

    it("reads the resolved path unchanged", async () => {
        const harness = fakeLaunch();
        const ops = createRemoteReadOps(target, "/home/dev/ufw.conf", {
            spawnFn: harness.launch,
        });
        const pending = ops.readFile("/home/dev/ufw.conf");
        expect(commandOf(harness)).toBe("cat '/home/dev/ufw.conf'");
        harness.process.emitStdout("rules\n");
        harness.process.emitClose(0);
        expect((await pending).toString()).toBe("rules\n");
    });

    it("reads a remote file with cat", async () => {
        const harness = fakeLaunch();
        const ops = createRemoteReadOps(target, "/home/dev/ufw.conf", {
            spawnFn: harness.launch,
        });
        const pending = ops.readFile("/home/dev/ufw.conf");
        expect(commandOf(harness)).toBe("cat '/home/dev/ufw.conf'");
        harness.process.emitStdout("ENABLED=yes");
        harness.process.emitClose(0);
        expect((await pending).toString()).toBe("ENABLED=yes");
    });

    it("quotes a path containing a single quote", async () => {
        const harness = fakeLaunch();
        const ops = createRemoteReadOps(target, "/home/dev/it's.conf", {
            spawnFn: harness.launch,
        });
        const pending = ops.readFile("/home/dev/it's.conf");
        expect(commandOf(harness)).toBe(`cat '/home/dev/it'"'"'s.conf'`);
        harness.process.emitClose(0);
        await pending;
    });

    it("reports a missing remote file by name and host", async () => {
        const harness = fakeLaunch();
        const ops = createRemoteReadOps(target, "/home/dev/gone.conf", {
            spawnFn: harness.launch,
        });
        const pending = ops.access("/home/dev/gone.conf");
        expect(commandOf(harness)).toContain("[ -e '/home/dev/gone.conf' ]");
        harness.process.emitStdout("NOENT");
        harness.process.emitClose(0);
        await expect(pending).rejects.toThrow(
            "Remote path not found on devlab: /home/dev/gone.conf",
        );
    });

    it("distinguishes an unreadable file from a missing one", async () => {
        const harness = fakeLaunch();
        const ops = createRemoteReadOps(target, "/etc/shadow", {
            spawnFn: harness.launch,
        });
        const pending = ops.access("/etc/shadow");
        harness.process.emitStdout("NOACCESS");
        harness.process.emitClose(0);
        await expect(pending).rejects.toThrow(
            "Remote path is not readable on devlab: /etc/shadow",
        );
    });

    it("detects image types by extension without touching the host", async () => {
        // One pinned path per ops, since the guard rejects anything else.
        const image = createRemoteReadOps(target, "/home/dev/a.png");
        expect(await image.detectImageMimeType?.("/home/dev/a.png")).toBe(
            "image/png",
        );
        const text = createRemoteReadOps(target, "/home/dev/a.txt");
        expect(await text.detectImageMimeType?.("/home/dev/a.txt")).toBeNull();
    });
});

describe("createRemoteWriteOps", () => {
    it("sends content on stdin and renames into place", async () => {
        const harness = fakeLaunch();
        const ops = createRemoteWriteOps(target, { spawnFn: harness.launch });
        const pending = ops.writeFile("/home/dev/app.conf", "PORT=3000\n");
        expect(commandOf(harness)).not.toContain("base64");
        expect(commandOf(harness)).toContain("mktemp");
        expect(commandOf(harness)).toContain("mv -f");
        expect(harness.process.stdinWrites[0]?.toString()).toBe("PORT=3000\n");
        harness.process.emitClose(0);
        await pending;
    });

    it("passes the wire byte length, not the string length", async () => {
        const harness = fakeLaunch();
        const ops = createRemoteWriteOps(target, { spawnFn: harness.launch });
        // "é" is 2 UTF-8 bytes, so the remote check must expect 4, not 3.
        const pending = ops.writeFile("/home/dev/utf8.txt", "éé");
        expect(commandOf(harness)).toContain("-eq 4");
        harness.process.emitClose(0);
        await pending;
    });

    it("uses the mktemp template in the target directory", async () => {
        const harness = fakeLaunch();
        const ops = createRemoteWriteOps(target, { spawnFn: harness.launch });
        const pending = ops.writeFile("/home/dev/nested/app.conf", "x");
        expect(commandOf(harness)).toContain("'/home/dev/nested/.pi-ssh.XXXXXX'");
        harness.process.emitClose(0);
        await pending;
    });

    it("keeps large content off the command line", async () => {
        const small = fakeLaunch();
        const smallOps = createRemoteWriteOps(target, {
            spawnFn: small.launch,
        });
        const smallPending = smallOps.writeFile("/home/dev/big.log", "x");
        small.process.emitClose(0);
        await smallPending;

        const large = fakeLaunch();
        const largeOps = createRemoteWriteOps(target, {
            spawnFn: large.launch,
        });
        const content = "x".repeat(200_000);
        const largePending = largeOps.writeFile("/home/dev/big.log", content);
        // The command grows only by the byte-count number, not by the payload,
        // so the ~96KB argv ceiling does not come back.
        expect(commandOf(large)).toContain("-eq 200000");
        expect(commandOf(large).length).toBeLessThan(
            commandOf(small).length + 16,
        );
        expect(large.process.stdinWrites[0]?.toString()).toHaveLength(200_000);
        large.process.emitClose(0);
        await largePending;
    });

    it("creates parent directories recursively", async () => {
        const harness = fakeLaunch();
        const ops = createRemoteWriteOps(target, { spawnFn: harness.launch });
        const pending = ops.mkdir("/home/dev/app");
        expect(commandOf(harness)).toBe("mkdir -p '/home/dev/app'");
        harness.process.emitClose(0);
        await pending;
    });
});

describe("createRemoteEditOps", () => {
    it("reads through cat", async () => {
        const harness = fakeLaunch();
        const ops = createRemoteEditOps(target, { spawnFn: harness.launch });
        const pending = ops.readFile("/home/dev/app.conf");
        expect(commandOf(harness)).toBe("cat '/home/dev/app.conf'");
        harness.process.emitClose(0);
        await pending;
    });

    it("writes through the atomic temp-and-rename path", async () => {
        const harness = fakeLaunch();
        const ops = createRemoteEditOps(target, { spawnFn: harness.launch });
        const pending = ops.writeFile("/home/dev/app.conf", "PORT=4000\n");
        expect(commandOf(harness)).toContain("mktemp");
        expect(commandOf(harness)).toContain("mv -f");
        expect(harness.process.stdinWrites[0]?.toString()).toBe("PORT=4000\n");
        harness.process.emitClose(0);
        await pending;
    });

    it("requires read-write access, not just read access", async () => {
        const harness = fakeLaunch();
        const ops = createRemoteEditOps(target, { spawnFn: harness.launch });
        const pending = ops.access("/home/dev/app.conf");
        const command = commandOf(harness);
        expect(command).toContain("[ -r '/home/dev/app.conf' ]");
        expect(command).toContain("[ -w '/home/dev/app.conf' ]");
        harness.process.emitStdout("OK");
        harness.process.emitClose(0);
        await pending;
    });

    it("rejects a symlinked target rather than replacing the link", async () => {
        const harness = fakeLaunch();
        const ops = createRemoteEditOps(target, { spawnFn: harness.launch });
        const pending = ops.access("/home/dev/link.conf");
        expect(commandOf(harness)).toContain("[ -L '/home/dev/link.conf' ]");
        harness.process.emitStdout("LINK");
        harness.process.emitClose(0);
        await expect(pending).rejects.toThrow(
            "Remote path is a symlink on devlab: /home/dev/link.conf",
        );
    });

    it("does not probe for links on the read path, where following one is fine", async () => {
        const harness = fakeLaunch();
        const ops = createRemoteReadOps(target, "/home/dev/link.conf", {
            spawnFn: harness.launch,
        });
        const pending = ops.access("/home/dev/link.conf");
        expect(commandOf(harness)).not.toContain("[ -L ");
        harness.process.emitStdout("OK");
        harness.process.emitClose(0);
        await pending;
    });

    it("reports a read-only remote file as not writable", async () => {
        const harness = fakeLaunch();
        const ops = createRemoteEditOps(target, { spawnFn: harness.launch });
        const pending = ops.access("/etc/ufw/ufw.conf");
        harness.process.emitStdout("NOACCESS");
        harness.process.emitClose(0);
        await expect(pending).rejects.toThrow(
            "Remote path is not readable and writable on devlab: /etc/ufw/ufw.conf",
        );
    });
});
