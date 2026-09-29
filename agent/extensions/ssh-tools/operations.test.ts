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
        expect(harness.process.killed).toBe(true);
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
        expect(commandOf(harness)).toContain(
            "mv -f '/home/dev/app.conf.pi-ssh.tmp' '/home/dev/app.conf'",
        );
        expect(harness.process.stdinWrites[0]?.toString()).toBe("PORT=3000\n");
        harness.process.emitClose(0);
        await pending;
    });

    it("keeps large content off the command line", async () => {
        const harness = fakeLaunch();
        const ops = createRemoteWriteOps(target, { spawnFn: harness.launch });
        const content = "x".repeat(200_000);
        const pending = ops.writeFile("/home/dev/big.log", content);
        expect(commandOf(harness).length).toBeLessThan(200);
        expect(harness.process.stdinWrites[0]?.toString()).toHaveLength(200_000);
        harness.process.emitClose(0);
        await pending;
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
        expect(commandOf(harness)).toContain(
            "mv -f '/home/dev/app.conf.pi-ssh.tmp' '/home/dev/app.conf'",
        );
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
