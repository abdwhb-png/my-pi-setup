import { test, expect } from "bun:test";
import {
    mkdtempSync,
    mkdirSync,
    writeFileSync,
    readFileSync,
    existsSync,
    rmSync,
    chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("CLI resolves one portable profile against two different home directories without host discovery", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-portable-cli-"));
    try {
        const profile = join(root, "profile.json");
        writeFileSync(
            profile,
            JSON.stringify({
                environment: {
                    installations: {
                        tools: [{ root: "~/tools", path: ["bin"] }],
                    },
                    variables: { XDG_CACHE_HOME: "~/.cache/pi/dev-tools/xdg" },
                },
                filesystem: { allowWrite: ["~/.cache/pi/dev-tools"] },
            }),
        );
        for (const name of ["one", "two"]) {
            const home = join(root, name);
            mkdirSync(join(home, "tools/bin"), { recursive: true });
            const agent = join(home, "agent");
            const run = (mode: string) =>
                Bun.spawnSync(
                    [
                        process.execPath,
                        join(import.meta.dir, "configure-sandbox.ts"),
                        mode,
                        "--profile",
                        profile,
                        "--agent-dir",
                        agent,
                    ],
                    {
                        env: { ...process.env, HOME: home },
                        timeout: 20000,
                        stdout: "pipe",
                        stderr: "pipe",
                    },
                );
            const preview = run("preview");
            expect(preview.exitCode).toBe(0);
            expect(existsSync(agent)).toBe(false);
            const applied = run("apply");
            expect(
                applied.exitCode,
                new TextDecoder().decode(applied.stderr),
            ).toBe(0);
            const saved = JSON.parse(
                readFileSync(join(agent, "config/sandbox.json"), "utf8"),
            );
            expect(saved.environment.installations.tools[0].root).toBe(
                "~/tools",
            );
            expect(saved.environment.variables.XDG_CACHE_HOME).toBe(
                "~/.cache/pi/dev-tools/xdg",
            );
            expect(run("check").exitCode).toBe(0);
            expect(new TextDecoder().decode(run("apply").stdout)).toContain(
                "Already configured",
            );
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}, 120000);

test("logical profiles can be inspected, applied and explicitly rediscovered through the CLI", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-logical-cli-"));
    try {
        const bin = join(root, "tools");
        mkdirSync(bin);
        const executable = join(bin, "bun");
        writeFileSync(
            executable,
            `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ executable, version: "1.2.3", resources: [] })}'\n`,
            { mode: 0o700 },
        );
        const profile = join(root, "profile.json");
        writeFileSync(profile, JSON.stringify({ tools: { bun: ["bun"] } }));
        const agent = join(root, "agent");
        const run = (mode: string, ...flags: string[]) =>
            Bun.spawnSync(
                [
                    process.execPath,
                    join(import.meta.dir, "configure-sandbox.ts"),
                    mode,
                    "--profile",
                    profile,
                    "--agent-dir",
                    agent,
                    ...flags,
                ],
                {
                    env: { ...process.env, HOME: root, PATH: bin },
                    stdout: "pipe",
                    stderr: "pipe",
                    timeout: 20000,
                },
            );
        const preview = run("preview", "--rediscover");
        expect(preview.exitCode, new TextDecoder().decode(preview.stderr)).toBe(
            0,
        );
        expect(existsSync(agent)).toBe(false);
        expect(new TextDecoder().decode(preview.stdout)).toContain(executable);
        expect(run("apply").exitCode).toBe(0);
        expect(run("check").exitCode).toBe(0);
        const authority = join(agent, "config/sandbox.json");
        const beforePermissionLoss = readFileSync(authority);
        chmodSync(executable, 0o600);
        expect(run("check").exitCode).toBe(1);
        expect(run("apply").exitCode).toBe(1);
        expect(readFileSync(authority)).toEqual(beforePermissionLoss);
        chmodSync(executable, 0o700);
        expect(run("check", "--rediscover").exitCode).toBe(1);
        rmSync(executable);
        expect(run("preview", "--rediscover").exitCode).toBe(1);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}, 120000);
