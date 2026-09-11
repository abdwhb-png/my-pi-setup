import { test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("Node Pi loads Sandbox and Bash with the public capability schema", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-shell-loader-"));
    const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
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
        await execFileAsync("node", ["--input-type=module", "-e", script, loader, agentDir,
            join(import.meta.dir, "../sandbox/index.ts"), join(import.meta.dir, "index.ts")], {
            cwd: agentDir,
            env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
            timeout: 20_000,
            killSignal: "SIGKILL",
            maxBuffer: 1024 * 1024,
        });
    } finally {
        await rm(agentDir, { recursive: true, force: true });
    }
}, 25_000);
