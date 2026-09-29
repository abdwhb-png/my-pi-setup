import { test } from "bun:test";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Opt-in gate, matching the `PI_*_TEST` convention used by the other
 * runtime-dependent checks in this repository.
 *
 * This check loads both shell extensions through the real Pi extension loader
 * in a child Node process. It needs a Node runtime plus the installed Pi
 * package on disk, which a sandboxed shell does not expose: there the child
 * never finishes and the check reports a 20s timeout instead of a verdict about
 * the loader. Run it from a host shell with `PI_SHELL_LOADER_TEST=1`.
 */
const enabled = process.env.PI_SHELL_LOADER_TEST === "1";

function assertPrerequisites(): void {
    try {
        execFileSync("node", ["--version"], {
            stdio: "ignore",
            timeout: 5_000,
        });
    } catch {
        throw new Error(
            "PI_SHELL_LOADER_TEST=1 requires a `node` binary on PATH. Run this check from a host shell; a sandboxed shell does not provide one.",
        );
    }
}

test.skipIf(!enabled)(
    "Node Pi loads Sandbox and Bash with the public capability schema",
    async () => {
        assertPrerequisites();
        const agentDir = await mkdtemp(join(tmpdir(), "pi-shell-loader-"));
        const entry = fileURLToPath(
            import.meta.resolve("@earendil-works/pi-coding-agent"),
        );
        const loader = join(dirname(entry), "core/extensions/loader.js");
        const script = `
import assert from "node:assert/strict";
const [loader, agentDir, ...paths] = process.argv.slice(1);
const { loadExtensions } = await import(loader);
const loaded = await loadExtensions(paths, agentDir);
assert.deepEqual(loaded.errors, [], JSON.stringify(loaded.errors));
assert.equal(loaded.extensions.length, 2);
const shell = loaded.extensions.find(extension => extension.tools.has("safe_bash"));
const definition = shell.tools.get("safe_bash").definition;
const schema = definition.parameters;
assert.deepEqual(schema.required, ["command"]);
assert.deepEqual(Object.keys(schema.properties).sort(), ["command", "stdin", "timeout"]);
assert.equal(Object.hasOwn(schema.properties, "hostCapability"), false);
assert.doesNotMatch(definition.promptGuidelines.join("\\n"), /editor|dev-services|dependencies/);
`;
        try {
            await execFileAsync(
                "node",
                [
                    "--input-type=module",
                    "-e",
                    script,
                    loader,
                    agentDir,
                    join(import.meta.dir, "../sandbox/index.ts"),
                    join(import.meta.dir, "index.ts"),
                ],
                {
                    cwd: agentDir,
                    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
                    timeout: 20_000,
                    killSignal: "SIGKILL",
                    maxBuffer: 1024 * 1024,
                },
            );
        } finally {
            await rm(agentDir, { recursive: true, force: true });
        }
    },
    25_000,
);
