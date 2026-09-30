import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
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

/** Runs the script the same way ssh would: content on stdin. */
function runWrite(target: string, content: string | Buffer): {
    status: number;
    stderr: string;
} {
    const expectedBytes = Buffer.byteLength(content);
    // No encoding: stdout/stderr stay Buffers so a large payload is never
    // transcoded, and stderr is decoded explicitly below.
    const result = spawnSync("sh", ["-c", buildWriteScript(target, expectedBytes)], {
        input: content,
    });
    return {
        status: result.status ?? -1,
        stderr: result.stderr?.toString("utf8") ?? "",
    };
}

/**
 * Runs the script asynchronously so several can be in flight together. A `gate`
 * path makes the command block until that file exists, which is what forces the
 * transfers to actually overlap: without a barrier the first writer can finish
 * before the second writes, and the test would pass even with a shared staging
 * path.
 */
function runWriteAsync(
    script: string,
    content: string,
    gate?: string,
): Promise<{ status: number; stderr: string }> {
    const prelude = gate ? `while [ ! -e '${gate}' ]; do :; done\n` : "";
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
        child.stdin.end(content);
    });
}

afterAll(() => {
    for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe("generated write script", () => {
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
        const gate = join(scratch(), "gate");
        // Both processes are started, not awaited: each parks on the gate with
        // nothing written yet, so releasing them together forces a real overlap
        // rather than leaving the ordering to chance.
        const first = runWriteAsync(script, payloadA, gate);
        const second = runWriteAsync(script, payloadB, gate);
        await new Promise((resolve) => setTimeout(resolve, 150));
        writeFileSync(gate, "");
        const [a, b] = await Promise.all([first, second]);
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
