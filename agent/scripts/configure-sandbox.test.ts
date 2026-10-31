import { test, expect } from "bun:test";
import {
    mkdtempSync,
    mkdirSync,
    writeFileSync,
    readFileSync,
    existsSync,
    rmSync,
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
