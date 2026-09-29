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

describe("buildWriteScript", () => {
    it("never inlines file content in the remote command", () => {
        expect(buildWriteScript("/home/dev/app.conf")).not.toContain("base64");
    });

    it("writes through a temporary sibling then renames", () => {
        const script = buildWriteScript("/home/dev/app.conf");
        expect(script).toContain("cat > '/home/dev/app.conf.pi-ssh.tmp'");
        expect(script).toContain(
            "mv -f '/home/dev/app.conf.pi-ssh.tmp' '/home/dev/app.conf'",
        );
    });

    it("cleans the temporary file and fails when the write fails", () => {
        const script = buildWriteScript("/home/dev/app.conf");
        expect(script).toContain("rm -f '/home/dev/app.conf.pi-ssh.tmp'");
        expect(script).toContain("exit 1");
    });

    it("quotes a target path containing a space", () => {
        const script = buildWriteScript("/home/dev/my app.conf");
        expect(script).toContain("'/home/dev/my app.conf.pi-ssh.tmp'");
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
        const pending = sshExec("devlab", buildWriteScript("/tmp/a"), {
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
        expect(harness.process.killed).toBe(true);
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
        expect(harness.process.killed).toBe(true);
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
