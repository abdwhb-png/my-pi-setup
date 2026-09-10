import { expect, test } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createBashProcessSupervisor } from "../_shared/command-execution/exec.ts";
import { discoverIntegration, prepareHostIntegration } from "../sandbox/capabilities/adapters.ts";
import { emptyGrants, type HostCapability } from "../sandbox/capabilities/authority.ts";
import type { ShellCapabilityResolution } from "../sandbox/capabilities/policy.ts";

// Explicit operator opt-in: these tests open a GUI, download a benign npm package,
// or execute a harmless command in an already registered Dev Services project.
const enabled = process.env.PI_SANDBOX_HOST_SMOKE === "1";
async function run(capability: HostCapability, cwd: string, command: string, env: NodeJS.ProcessEnv = process.env) {
    const policy: ShellCapabilityResolution = { state: "ready", projectRoot: cwd, profile: "integrated", requestedProfile: "integrated",
        grants: { ...emptyGrants(), integrations: { [capability]: discoverIntegration(capability, cwd) } }, requestedGrants: emptyGrants(), authorityPath: join(cwd, "unused-authority") };
    const supervisor = createBashProcessSupervisor(); const events: object[] = []; let output = "";
    try {
        const operations = supervisor.createOperations({ env, onExecution: event => events.push(event),
            prepareSpawn: context => prepareHostIntegration(policy, capability, context.command, context.cwd, context.env) });
        const result = await operations.exec(command, cwd, { timeout: 90, onData: chunk => { output += chunk.toString(); } });
        expect(result.exitCode, output).toBe(0);
        expect(events.at(-1)).toMatchObject({ backend: "host", shellProfile: "integrated", hostCapability: capability, exitCode: 0, outcome: "succeeded", tmpNamespace: "host" });
        return output;
    } finally { supervisor.shutdown(); }
}

test.skipIf(!enabled)("installed SFW performs a benign npm installation with a fresh npm cache", async () => {
    const cwd = await mkdtemp(join(import.meta.dir, ".sfw-smoke-"));
    try {
        await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "pi-sandbox-capability-smoke", private: true, version: "1.0.0", packageManager: "npm@12.0.1" }));
        await writeFile(join(cwd, ".npmrc"), "ignore-scripts=true\nmin-release-age=7\nallow-git=none\n");
        await run("dependencies", cwd, "npm install is-number@7.0.0 --save-exact --no-audit --no-fund", { ...process.env, npm_config_cache: join(cwd, ".fresh-npm-cache") });
        const manifest = JSON.parse(await readFile(join(cwd, "node_modules/is-number/package.json"), "utf8"));
        expect({ name: manifest.name, version: manifest.version }).toEqual({ name: "is-number", version: "7.0.0" });
    } finally { await rm(cwd, { recursive: true, force: true }); }
}, 100_000);

test.skipIf(!enabled)("installed Zed accepts a named file from the approved project", async () => {
    const cwd = await mkdtemp(join(import.meta.dir, ".zed-smoke-"));
    try {
        await writeFile(join(cwd, "sandbox-capability-smoke.txt"), "Pi sandbox capability smoke test. This temporary file contains no project data.\n");
        await run("editor", cwd, "zed sandbox-capability-smoke.txt");
        // Zed forwards the request asynchronously. Keep the fixture available for
        // the optional manual UI observation instead of deleting it on CLI exit.
        if (process.env.PI_SANDBOX_ZED_OBSERVE === "1") await Bun.sleep(30_000);
    } finally { await rm(cwd, { recursive: true, force: true }); }
}, 100_000);

test.skipIf(!enabled || !process.env.PI_SANDBOX_DEV_SERVICES_PROJECT)("installed Dev Services executes in an already registered project with host provenance", async () => {
    const cwd = resolve(process.env.PI_SANDBOX_DEV_SERVICES_PROJECT!);
    expect(await run("dev-services", cwd, "printf pi-dev-services-host-smoke")).toContain("pi-dev-services-host-smoke");
}, 100_000);
