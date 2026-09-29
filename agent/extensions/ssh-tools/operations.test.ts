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
    it("reads a remote file with cat", async () => {
        const harness = fakeLaunch();
        const ops = createRemoteReadOps(target, { spawnFn: harness.launch });
        const pending = ops.readFile("/home/dev/ufw.conf");
        expect(commandOf(harness)).toBe("cat '/home/dev/ufw.conf'");
        harness.process.emitStdout("ENABLED=yes");
        harness.process.emitClose(0);
        expect((await pending).toString()).toBe("ENABLED=yes");
    });

    it("quotes a path containing a single quote", async () => {
        const harness = fakeLaunch();
        const ops = createRemoteReadOps(target, { spawnFn: harness.launch });
        const pending = ops.readFile("/home/dev/it's.conf");
        expect(commandOf(harness)).toBe(`cat '/home/dev/it'"'"'s.conf'`);
        harness.process.emitClose(0);
        await pending;
    });

    it("reports a missing remote file by name and host", async () => {
        const harness = fakeLaunch();
        const ops = createRemoteReadOps(target, { spawnFn: harness.launch });
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
        const ops = createRemoteReadOps(target, { spawnFn: harness.launch });
        const pending = ops.access("/etc/shadow");
        harness.process.emitStdout("NOACCESS");
        harness.process.emitClose(0);
        await expect(pending).rejects.toThrow(
            "Remote path is not readable on devlab: /etc/shadow",
        );
    });

    it("detects image types by extension without touching the host", async () => {
        const ops = createRemoteReadOps(target);
        expect(await ops.detectImageMimeType?.("/home/dev/a.png")).toBe(
            "image/png",
        );
        expect(await ops.detectImageMimeType?.("/home/dev/a.txt")).toBeNull();
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
        const ops = createRemoteReadOps(target, { spawnFn: harness.launch });
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
