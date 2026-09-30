import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PackageSource } from "@earendil-works/pi-coding-agent";

// Opt-in: personal settings are read only. Runtime fixtures use their own HOME/agentDir.
test.skipIf(process.env.PI_SUBAGENTS_OFFICIAL_SMOKE !== "1")(
    "installed official package owns the public CLI subagent lifecycle",
    () => {
        const agentDir = resolve(import.meta.dir, "../..");
        const installedAgentDir =
            process.env.PI_TEST_INSTALLED_AGENT_DIR ?? agentDir;
        const settings: { packages?: PackageSource[] } = JSON.parse(
            readFileSync(join(installedAgentDir, "settings.json"), "utf8"),
        );
        const sources = (settings.packages ?? [])
            .map((entry) => (typeof entry === "string" ? entry : entry.source))
            .filter((source) => source.includes("pi-subagents"));
        expect(sources).toEqual(["npm:pi-subagents@0.73.1"]);
        const officialRoot = dirname(
            realpathSync(fileURLToPath(import.meta.resolve("pi-subagents"))),
        );
        expect(officialRoot).toBe(
            realpathSync(
                join(installedAgentDir, "npm/node_modules/pi-subagents"),
            ),
        );
        const packageInfo = JSON.parse(
            readFileSync(join(officialRoot, "package.json"), "utf8"),
        );
        expect(packageInfo.name).toBe("pi-subagents");
        expect(packageInfo.version).toBe("0.73.1");

        // Reuse the qualified public CLI scenario rather than a private entrypoint
        // or a second implementation of startup, tool/RPC, async MCP, and recovery checks.
        const child = spawnSync(
            process.execPath,
            [
                "test",
                "--isolate",
                "extensions/__tests__/integration/subagent-tool-groups-lifecycle.test.ts",
            ],
            {
                cwd: agentDir,
                env: {
                    PATH: process.env.PATH,
                    HOME: process.env.HOME,
                    PI_TEST_CLI: process.env.PI_TEST_CLI,
                    PI_SUBAGENTS_OFFICIAL_SMOKE: "1",
                },
                timeout: 200000,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
            },
        );
        const output = child.stdout + child.stderr;
        process.stderr.write(output);
        expect(child.status, output).toBe(0);
        expect(output).toMatch(/\b1 pass\b/);
        expect(output).not.toMatch(/\b[1-9]\d* skip\b/);
    },
    210000,
);
