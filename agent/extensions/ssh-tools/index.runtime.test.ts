import { describe, expect, it } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    calls,
    createTestSession,
    says,
    when,
    type TestSession,
} from "@abdwhb-png/pi-test-harness";
import { createToolPolicyCoordinator } from "../_shared/tool-policy/index.ts";
import { shellQuote } from "./remote-path.ts";

// Only the SSH executable is replaced. Pi validates arguments and runs the
// real registered tools and generated remote scripts against disposable files.
async function withSshSession(
    run: (session: TestSession, remote: string, log: string) => Promise<void>,
) {
    const previousPath = process.env.PATH;
    const key = Symbol.for("pi.tool-policy.coordinator.v1");
    const previousPolicy = Object.getOwnPropertyDescriptor(globalThis, key);
    let root: string | undefined;
    let session: TestSession | undefined;
    let detach: (() => void) | undefined;
    try {
        root = mkdtempSync(join(tmpdir(), "ssh-runtime-test-"));
        const bin = join(root, "bin");
        const remote = join(root, "remote");
        const log = join(root, "ssh-calls");
        mkdirSync(bin);
        mkdirSync(remote);
        writeFileSync(
            join(bin, "ssh"),
            [
                "#!/bin/sh",
                'while [ "$#" -gt 2 ]; do shift; done',
                '[ "$1" = fixture ] || exit 99',
                `printf '%s\\n' "$2" >> ${shellQuote(log)}`,
                'exec /bin/sh -c "$2"',
            ].join("\n"),
            { mode: 0o755 },
        );
        process.env.PATH = `${bin}:${previousPath ?? ""}`;
        const policy = createToolPolicyCoordinator();
        Object.defineProperty(globalThis, key, {
            configurable: true,
            writable: true,
            value: policy,
        });
        detach = policy.bind(
            {
                registered: () =>
                    session?.session.getAllTools() ??
                    [],
                active: () => session?.session.getActiveToolNames() ?? [],
                apply: (names) => session?.session.setActiveToolsByName(names),
            },
            { groups: {}, resolveMcp: () => [] },
        );
        session = await createTestSession({
            cwd: join(root, "agent"),
            extensions: [join(import.meta.dir, "index.ts")],
            propagateErrors: false,
        });
        policy.start();
        expect(session.session.getActiveToolNames()).not.toContain("ssh_write");
        await session.session.prompt(`/ssh fixture:${remote}`);
        expect(session.session.getActiveToolNames()).toContain("ssh_write");
        await run(session, remote, log);
    } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        if (previousPolicy)
            Object.defineProperty(globalThis, key, previousPolicy);
        else Reflect.deleteProperty(globalThis, key);
        try {
            session?.dispose();
        } finally {
            detach?.();
            if (root) rmSync(root, { recursive: true, force: true });
        }
    }
}

describe("SSH tools through Pi's execution pipeline", () => {
    it("accepts an explicit write mode and preserves it through a later edit", async () => {
        await withSshSession(async (session, remote) => {
            await session.run(
                when("write a file", [
                    calls("ssh_write", {
                        path: "app.conf",
                        content: "OLD\n",
                        mode: "0644",
                    }),
                    calls("ssh_write", {
                        path: "private.conf",
                        content: "private",
                    }),
                    says("done"),
                ]),
            );
            expect(session.events.toolResultsFor("ssh_write")[0]).toMatchObject(
                { isError: false, mocked: false },
            );
            const path = join(remote, "app.conf");
            expect(statSync(path).mode & 0o7777).toBe(0o644);
            expect(statSync(join(remote, "private.conf")).mode & 0o7777).toBe(
                0o600,
            );
            const before = statSync(path);
            await session.run(
                when("rewrite the file", [
                    calls("ssh_write", {
                        path: "app.conf",
                        content: "REWRITTEN\n",
                    }),
                    says("done"),
                ]),
            );
            expect(session.events.toolResultsFor("ssh_write")[2]).toMatchObject(
                { isError: false, mocked: false },
            );
            expect(statSync(path).mode & 0o7777).toBe(0o644);
            await session.run(
                when("edit the file", [
                    calls("ssh_edit", {
                        path: "app.conf",
                        edits: [{ oldText: "REWRITTEN", newText: "NEW" }],
                    }),
                    says("done"),
                ]),
            );
            expect(session.events.toolResultsFor("ssh_edit")[0]).toMatchObject({
                isError: false,
                mocked: false,
            });
            expect(readFileSync(path, "utf8")).toBe("NEW\n");
            const after = statSync(path);
            expect([after.mode & 0o7777, after.uid, after.gid]).toEqual([
                0o644,
                before.uid,
                before.gid,
            ]);
        });
    }, 20_000);

    it("rejects an invalid write mode before launching SSH", async () => {
        await withSshSession(async (session, remote, log) => {
            await session.run(
                when("invalid mode", [
                    calls("ssh_write", {
                        path: "app.conf",
                        content: "data",
                        mode: "755",
                    }),
                    says("done"),
                ]),
            );
            expect(session.events.toolResultsFor("ssh_write")[0]?.isError).toBe(
                true,
            );
            expect(existsSync(log)).toBe(false);
            expect(existsSync(join(remote, "app.conf"))).toBe(false);
        });
    }, 20_000);

    it("reports a failed pipeline as an error and accepts the failFast opt-out", async () => {
        await withSshSession(async (session, remote) => {
            const command = "false | true\nprintf SHOULD_NOT_RUN > marker";
            await session.run(
                when("stop on failure", [
                    calls("ssh_bash", { command }),
                    says("done"),
                ]),
            );
            expect(session.events.toolResultsFor("ssh_bash")[0]).toMatchObject({
                isError: true,
                mocked: false,
            });
            expect(existsSync(join(remote, "marker"))).toBe(false);
            await session.run(
                when("allow failure", [
                    calls("ssh_bash", { command, failFast: false }),
                    says("done"),
                ]),
            );
            expect(session.events.toolResultsFor("ssh_bash")[1]).toMatchObject({
                isError: false,
                mocked: false,
            });
            expect(readFileSync(join(remote, "marker"), "utf8")).toBe(
                "SHOULD_NOT_RUN",
            );
        });
    }, 20_000);

    it("rejects an invalid failFast value before launching SSH", async () => {
        await withSshSession(async (session, _remote, log) => {
            await session.run(
                when("invalid failFast", [
                    calls("ssh_bash", { command: "true", failFast: "invalid" }),
                    says("done"),
                ]),
            );
            expect(session.events.toolResultsFor("ssh_bash")[0]?.isError).toBe(
                true,
            );
            expect(existsSync(log)).toBe(false);
        });
    }, 20_000);
});
