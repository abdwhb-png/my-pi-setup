import { afterAll, describe, expect, it } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
    chmodSync,
    existsSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellQuote } from "../remote-path.ts";
import { buildWriteScript } from "../transport.ts";

/**
 * Executes the generated write script with a real POSIX shell against a
 * disposable directory. The `SshProcess` fake verifies strings; only this can
 * establish that the script actually refuses, cleans up, and preserves the
 * previous file.
 */

const roots: string[] = [];

function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), "pi-ssh-write-"));
    roots.push(dir);
    return dir;
}

function commandEnvironment(
    commands: Record<string, string>,
): NodeJS.ProcessEnv {
    const bin = scratch();
    for (const [name, body] of Object.entries(commands)) {
        writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    }
    return { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` };
}

function statExecutable(): string {
    const executable = Bun.which("stat");
    if (!executable) throw new Error("These shell tests require stat in PATH");
    return shellQuote(executable);
}

/** Runs the script the same way ssh would: content on stdin. */
function runWrite(
    target: string,
    content: string | Buffer,
    mode?: string,
    env?: NodeJS.ProcessEnv,
): {
    status: number;
    stderr: string;
} {
    const expectedBytes = Buffer.byteLength(content);
    // No encoding: stdout/stderr stay Buffers so a large payload is never
    // transcoded, and stderr is decoded explicitly below.
    const result = spawnSync(
        "sh",
        ["-c", buildWriteScript(target, expectedBytes, mode)],
        {
            input: content,
            env,
        },
    );
    return {
        status: result.status ?? -1,
        stderr: result.stderr?.toString("utf8") ?? "",
    };
}

/**
 * Runs the script asynchronously so several can be in flight together. A `gate`
 * path blocks a writer until both have acknowledged readiness. A shell-side
 * deadline prevents failed gate release from leaving spinning processes.
 * Without a barrier the first writer can finish
 * before the second writes, and the test would pass even with a shared staging
 * path.
 */
function runWriteAsync(
    script: string,
    content: string,
    gate?: { path: string; ready: string },
): Promise<{ status: number; stderr: string }> {
    const prelude = gate ? `: > '${gate.ready}'\ncount=0\nuntil [ -e '${gate.path}' ]; do\n  count=$((count + 1))\n  if [ "$count" -gt 200 ]; then echo 'gate timed out' >&2; exit 1; fi\n  sleep 0.02\ndone\n` : "";
    return new Promise((resolve, reject) => {
        const child = spawn("sh", ["-c", `${prelude}${script}`], {
            stdio: ["pipe", "ignore", "pipe"],
        });
        const stderr: Buffer[] = [];
        child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
        child.on("close", (code) =>
            resolve({
                status: code ?? -1,
                stderr: Buffer.concat(stderr).toString("utf8"),
            }),
        );
        child.on("error", reject);
        // The gate may time out before this payload drains. EPIPE must reject
        // the test rather than surface as an unhandled stream error.
        child.stdin.on("error", reject);
        child.stdin.end(content);
    });
}

afterAll(() => {
    for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe("generated write script", () => {
    it.each([
        ["0000", 0o000],
        ["0644", 0o644],
        ["0755", 0o755],
        ["0777", 0o777],
    ] as const)(
        "publishes a new file with explicitly requested mode %s",
        (mode, expected) => {
            const dir = scratch();
            const target = join(dir, "shared.conf");
            const result = runWrite(target, "data", mode);
            expect(result.status).toBe(0);
            expect(statSync(target).mode & 0o7777).toBe(expected);
        },
    );

    it("overrides an existing mode only when explicitly requested", () => {
        const dir = scratch();
        const target = join(dir, "script");
        writeFileSync(target, "OLD\n", { mode: 0o600 });
        const before = statSync(target);
        const result = runWrite(target, "NEW\n", "0755");
        const after = statSync(target);
        expect(result.status).toBe(0);
        expect(after.mode & 0o7777).toBe(0o755);
        expect([after.uid, after.gid]).toEqual([before.uid, before.gid]);
    });

    it.each(["755", "4777", "0648", "0xFF", "0644; touch BAD"])(
        "rejects invalid mode %s before building a command",
        (mode) => {
            expect(() => buildWriteScript("/remote/file", 4, mode)).toThrow(
                "Invalid file mode",
            );
        },
    );

    it("preserves an existing file's permissions and numeric ownership", () => {
        const dir = scratch();
        const target = join(dir, "app.conf");
        writeFileSync(target, "OLD\n");
        chmodSync(target, 0o644);
        const before = statSync(target);
        const result = runWrite(target, "NEW\n");
        const after = statSync(target);
        expect(result.status).toBe(0);
        expect(readFileSync(target, "utf8")).toBe("NEW\n");
        expect(after.mode & 0o7777).toBe(before.mode & 0o7777);
        expect([after.uid, after.gid]).toEqual([before.uid, before.gid]);
        expect(readdirSync(dir)).toEqual(["app.conf"]);
    });

    it.each([0o755, 0o4644, 0o2644, 0o1644])(
        "preserves existing executable and special permission bits: %o",
        (mode) => {
            const target = join(scratch(), "script");
            writeFileSync(target, "OLD");
            expect(spawnSync("chmod", [mode.toString(8), target]).status).toBe(
                0,
            );
            expect(statSync(target).mode & 0o7777).toBe(mode);
            expect(runWrite(target, "NEW").status).toBe(0);
            expect(statSync(target).mode & 0o7777).toBe(mode);
        },
    );

    it("accepts BSD stat metadata including the file-type bits", () => {
        const target = join(scratch(), "script");
        writeFileSync(target, "OLD");
        expect(spawnSync("chmod", ["4755", target]).status).toBe(0);
        // Emulate BSD stat at the command boundary. The staged permissions
        // still come from the real file, so a missing chmod cannot pass.
        const env = commandEnvironment({
            stat: [
                '[ "$1" = -f ] || exit 1',
                `metadata=$(${statExecutable()} -c '%a %u %g' "$3") || exit 1`,
                "set -- $metadata",
                'printf "%o %s %s\\n" "$((0100000 | 0$1))" "$2" "$3"',
            ].join("\n"),
        });
        expect(runWrite(target, "NEW", undefined, env).status).toBe(0);
        expect(statSync(target).mode & 0o7777).toBe(0o4755);
        expect(readFileSync(target, "utf8")).toBe("NEW");
    });

    it("restores permission bits after changing the staged ownership", () => {
        const target = join(scratch(), "script");
        const marker = join(scratch(), "chowned");
        writeFileSync(target, "OLD");
        expect(spawnSync("chmod", ["4755", target]).status).toBe(0);
        // Emulate a different owner's file without requiring privileged tests.
        // chown clears the mode here just as a host may clear setuid/setgid.
        const env = commandEnvironment({
            stat: [
                "file=$3",
                `metadata=$(${statExecutable()} "$@") || exit 1`,
                "set -- $metadata",
                `if [ "$file" = ${shellQuote(target)} ] || [ -f ${shellQuote(marker)} ]; then`,
                '  printf "%s 999999 999998\\n" "$1"',
                'else printf "%s %s %s\\n" "$1" "$2" "$3"; fi',
            ].join("\n"),
            chown: [
                '[ "$1" = 999999:999998 ] || exit 1',
                'chmod 600 "$2" || exit 1',
                `: > ${shellQuote(marker)}`,
            ].join("\n"),
        });
        expect(runWrite(target, "NEW", undefined, env).status).toBe(0);
        expect(existsSync(marker)).toBe(true);
        expect(statSync(target).mode & 0o7777).toBe(0o4755);
        expect(readFileSync(target, "utf8")).toBe("NEW");
    });

    it.each([
        ["stat unavailable", "read existing metadata", { stat: "exit 1" }],
        [
            "malformed stat",
            "read existing metadata",
            { stat: "printf 'invalid 1 2\\n'" },
        ],
        ["chmod denied", "apply permissions", { chmod: "exit 1" }],
        [
            "chmod silently ineffective",
            "verify permissions",
            { chmod: "exit 0" },
        ],
    ] as const)(
        "leaves the original intact and removes staging when %s",
        (_label, failure, commands) => {
            const dir = scratch();
            const target = join(dir, "app.conf");
            writeFileSync(target, "OLD");
            chmodSync(target, 0o644);
            const before = statSync(target);
            const result = runWrite(
                target,
                "NEW",
                undefined,
                commandEnvironment(commands),
            );
            expect(result.status).not.toBe(0);
            expect(result.stderr).toContain(`Cannot ${failure}`);
            expect(result.stderr).toContain("No file was replaced");
            expect(readFileSync(target, "utf8")).toBe("OLD");
            const after = statSync(target);
            expect([after.ino, after.mode, after.uid, after.gid]).toEqual([
                before.ino,
                before.mode,
                before.uid,
                before.gid,
            ]);
            expect(readdirSync(dir)).toEqual(["app.conf"]);
        },
    );

    it.each([
        ["denied", "exit 1", "preserve ownership"],
        ["silently ineffective", "exit 0", "verify ownership"],
    ])(
        "leaves the original intact when chown is %s",
        (_label, chown, failure) => {
            const dir = scratch();
            const target = join(dir, "app.conf");
            writeFileSync(target, "OLD");
            chmodSync(target, 0o644);
            const before = statSync(target);
            const env = commandEnvironment({
                stat: `if [ "$3" = ${shellQuote(target)} ]; then printf '644 999999 999998\\n'; else exec ${statExecutable()} "$@"; fi`,
                chown,
            });
            const result = runWrite(target, "NEW", undefined, env);
            expect(result.status).not.toBe(0);
            expect(result.stderr).toContain(`Cannot ${failure}`);
            expect(readFileSync(target, "utf8")).toBe("OLD");
            const after = statSync(target);
            expect([after.ino, after.mode, after.uid, after.gid]).toEqual([
                before.ino,
                before.mode,
                before.uid,
                before.gid,
            ]);
            expect(readdirSync(dir)).toEqual(["app.conf"]);
        },
    );

    it("writes the content and leaves no temp file behind", () => {
        const dir = scratch();
        const target = join(dir, "app.conf");
        const result = runWrite(target, "PORT=3000\n");
        expect(result.status).toBe(0);
        expect(readFileSync(target, "utf8")).toBe("PORT=3000\n");
        expect(readdirSync(dir)).toEqual(["app.conf"]);
    });

    it("preserves the previous file when the transfer is short", () => {
        // Declares more bytes than are delivered: the rename must not happen.
        const dir = scratch();
        const target = join(dir, "app.conf");
        writeFileSync(target, "ORIGINAL\n");
        const script = buildWriteScript(target, 9999);
        const result = spawnSync("sh", ["-c", script], { input: "short" });
        expect(result.status).not.toBe(0);
        expect(result.stderr.toString("utf8")).toContain("short write");
        expect(readFileSync(target, "utf8")).toBe("ORIGINAL\n");
        expect(readdirSync(dir)).toEqual(["app.conf"]);
    });

    it("refuses a directory target and writes nothing", () => {
        const dir = scratch();
        const subdir = join(dir, "app");
        spawnSync("mkdir", [subdir]);
        const result = runWrite(subdir, "data");
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("is a directory");
        // The failure mode being guarded: mv into a directory succeeds.
        expect(readdirSync(subdir)).toEqual([]);
    });

    it("refuses a symlinked target instead of replacing the link", () => {
        const dir = scratch();
        const real = join(dir, "real.conf");
        const link = join(dir, "link.conf");
        writeFileSync(real, "REAL\n");
        symlinkSync(real, link);
        const result = runWrite(link, "REPLACED\n");
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("is a symlink");
        expect(readFileSync(real, "utf8")).toBe("REAL\n");
        // Still a link, not a regular file holding the new content.
        expect(readFileSync(link, "utf8")).toBe("REAL\n");
    });

    it("refuses a symlinked target for a new file that does not exist yet", () => {
        const dir = scratch();
        const link = join(dir, "dangling.conf");
        symlinkSync(join(dir, "missing.conf"), link);
        const result = runWrite(link, "data");
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("is a symlink");
    });

    it("gives two genuinely concurrent writers distinct temp files", async () => {
        const dir = scratch();
        const target = join(dir, "app.conf");
        // Payloads large enough that both transfers are in flight at the same
        // time: a shared staging path would interleave one writer's bytes into
        // the other's file instead of each writer publishing a whole payload.
        const payloadA = "a".repeat(400_000);
        const payloadB = "b".repeat(400_000);
        const script = buildWriteScript(target, 400_000);
        // In its own directory: the target directory is asserted to contain
        // nothing but the written file, so the gate must not live there.
        const barrier = scratch();
        const gate = join(barrier, "gate");
        const readyA = join(barrier, "ready-a");
        const readyB = join(barrier, "ready-b");
        // Both processes are started, not awaited: each parks on the gate with
        // nothing written yet, so releasing them together forces a real overlap
        // rather than leaving the ordering to chance.
        const first = runWriteAsync(script, payloadA, { path: gate, ready: readyA });
        const second = runWriteAsync(script, payloadB, { path: gate, ready: readyB });
        let bothReady = false;
        try {
            for (let attempt = 0; attempt < 200; attempt++) {
                bothReady = existsSync(readyA) && existsSync(readyB);
                if (bothReady) break;
                await Bun.sleep(20);
            }
        } finally {
            writeFileSync(gate, "");
        }
        // Even on failed readiness, wait for both shells to exit before
        // rejecting so the test cannot leave child processes behind.
        const [a, b] = await Promise.all([first, second]);
        expect(bothReady).toBe(true);
        expect(a.status).toBe(0);
        expect(b.status).toBe(0);
        // A failing writer reports why, instead of only an exit code.
        expect([a.stderr, b.stderr]).toEqual(["", ""]);
        // Last writer wins atomically; the file is never a mix of both.
        const final = readFileSync(target, "utf8");
        expect([payloadA, payloadB]).toContain(final);
        expect(readdirSync(dir)).toEqual(["app.conf"]);
    }, 20_000);

    it("stages the payload in a private directory, not a reopenable temp file", () => {
        const script = buildWriteScript("/home/dev/app.conf", 5);
        // `mktemp` alone creates a file whose name `cat` reopens, so on a
        // shared, non-sticky target directory another user can swap it for a
        // symlink in between and redirect the write. A 0700 directory the SSH
        // user owns cannot be modified that way.
        expect(script).toContain("mktemp -d");
        expect(script).toContain("umask 077");
    });

    it("leaves the published file unreadable by other users", () => {
        const dir = scratch();
        const target = join(dir, "app.conf");
        const result = runWrite(target, "data");
        expect(result.status).toBe(0);
        // mktemp creates the staging entry 0600 and the script sets umask 077
        // before writing, so the renamed file never widens permissions.
        expect(statSync(target).mode & 0o777).toBe(0o600);
    });

    it("handles a multi-byte payload by comparing wire bytes", () => {
        const dir = scratch();
        const target = join(dir, "utf8.txt");
        const content = "éé";
        const result = runWrite(target, content);
        expect(result.status).toBe(0);
        expect(readFileSync(target, "utf8")).toBe(content);
    });

    it("writes a file larger than the old argv ceiling", () => {
        const dir = scratch();
        const target = join(dir, "big.log");
        const content = "x".repeat(300_000);
        const result = runWrite(target, content);
        expect(result.status).toBe(0);
        expect(readFileSync(target, "utf8")).toHaveLength(300_000);
    });

    it("does not execute a command substitution embedded in the path", () => {
        // Regression: the refusal message used to interpolate the single-quoted
        // path inside a double-quoted echo, where $() is live. Single quotes
        // are literal inside double quotes, so the substitution ran. The
        // payload carries no slash, because remoteDirname would split on one
        // and fail at mktemp before the refusal is reached.
        const dir = scratch();
        const target = join(dir, "dir$(touch PWNED)");
        spawnSync("mkdir", [target]);
        const result = runWrite(target, "data");
        expect(result.status).not.toBe(0);
        // If the substitution had run, stderr would show its (empty) output
        // instead of the literal text.
        expect(result.stderr).toContain("dir$(touch PWNED)");
    });

    it("does not execute a backtick embedded in the path", () => {
        const dir = scratch();
        const target = join(dir, "dir`touch PWNED_TICK`");
        spawnSync("mkdir", [target]);
        const result = runWrite(target, "data");
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("dir`touch PWNED_TICK`");
    });

    it("re-checks the target immediately before the rename", () => {
        // The first refusal happens before staging, so the target has the whole
        // transfer to become a directory. Re-checking narrows that window to the
        // rename itself; the residual race is documented, not claimed gone.
        const script = buildWriteScript("/home/dev/app.conf", 5);
        const checks = script
            .split("\n")
            .filter((line) => line.includes("[ -d "));
        expect(checks.length).toBe(2);
        expect(script.indexOf(checks[1]!)).toBeLessThan(
            script.indexOf("mv -f"),
        );
    });

    it("replaces a symlink-free existing file atomically", () => {
        const dir = scratch();
        const target = join(dir, "app.conf");
        writeFileSync(target, "OLD\n");
        const result = runWrite(target, "NEW\n");
        expect(result.status).toBe(0);
        expect(readFileSync(target, "utf8")).toBe("NEW\n");
    });
});
