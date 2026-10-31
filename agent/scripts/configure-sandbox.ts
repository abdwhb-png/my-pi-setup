#!/usr/bin/env bun
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import {
    prepareDevelopmentSetup,
    applyDevelopmentSetup,
} from "../extensions/sandbox/index.ts";
const usage =
    "Usage: bun scripts/configure-sandbox.ts <preview|apply|check> [--profile FILE] [--bindings FILE] [--agent-dir DIR]";
export function configureSandbox(args: string[]): number {
    try {
        if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) {
            console.log(usage);
            return 0;
        }
        const mode = args[0];
        if (!mode || !["preview", "apply", "check"].includes(mode))
            throw new Error(usage);
        const flags: Record<string, string> = {};
        for (let i = 1; i < args.length; i += 2) {
            const key = args[i]!;
            if (
                !["--profile", "--bindings", "--agent-dir"].includes(key) ||
                !args[i + 1] ||
                Object.hasOwn(flags, key)
            )
                throw new Error(usage);
            flags[key] = args[i + 1]!;
        }
        const profile = JSON.parse(
            readFileSync(
                flags["--profile"] ??
                    resolve(
                        import.meta.dir,
                        "../config/sandbox.development.example.json",
                    ),
                "utf8",
            ),
        );
        const bindings = flags["--bindings"]
            ? JSON.parse(readFileSync(flags["--bindings"], "utf8"))
            : undefined;
        const setup = prepareDevelopmentSetup({
            profile,
            bindings,
            agentDir:
                flags["--agent-dir"] ??
                process.env.PI_CODING_AGENT_DIR ??
                join(homedir(), ".pi/agent"),
        });
        console.log(`Configuration: ${setup.path}`);
        for (const item of setup.unavailable)
            console.log(`Unavailable: ${item.name}: ${item.reason}`);
        const environment = setup.next.environment as {
            installations: Record<string, unknown>;
            variables: Record<string, unknown>;
        };
        console.log(
            `Installations: ${Object.keys(environment.installations).join(", ") || "(none)"}`,
        );
        for (const [name, roots] of Object.entries(environment.installations)) {
            console.log(`Installation ${name}: ${JSON.stringify(roots)}`);
        }
        console.log(
            `Configured variable names: ${Object.keys(environment.variables).join(", ") || "(none)"}`,
        );
        for (const directory of setup.directories)
            console.log(`Writable cache: ${directory}`);
        if (mode === "apply")
            console.log(
                applyDevelopmentSetup(setup)
                    ? "Applied; previous authority backed up."
                    : "Already configured.",
            );
        if (
            mode === "check" &&
            (setup.unavailable.length ||
                setup.directories.some((dir) => !existsSync(dir)) ||
                !setup.before ||
                JSON.stringify(JSON.parse(setup.before.toString())) !==
                    JSON.stringify(setup.next))
        )
            return 1;
        return 0;
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        return 1;
    }
}
if (import.meta.main)
    process.exitCode = configureSandbox(process.argv.slice(2));
