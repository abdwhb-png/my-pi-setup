import { expect, test } from "bun:test";
import {
    calls,
    createTestSession,
    says,
    when,
} from "@abdwhb-png/pi-test-harness";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { discoverIntegration } from "../sandbox/capabilities/adapters.ts";
import { emptyGrants, type HostCapability } from "../sandbox/capabilities/authority.ts";
import type { ShellCapabilityResolution } from "../sandbox/capabilities/policy.ts";
import {
    publishShellRuntime,
    releaseShellRuntime,
} from "../sandbox/capabilities/runtime.ts";

// Explicit operator opt-in: these tests open a GUI, download a benign npm package,
// or execute a harmless command in an already registered Dev Services project.
const enabled = process.env.PI_SANDBOX_HOST_SMOKE === "1";
async function run(
    capability: HostCapability,
    cwd: string,
    command: string,
    environment: Record<string, string> = {},
) {
    const discovered = discoverIntegration(capability, cwd);
    const integration =
        capability === "editor"
            ? discovered.zed
                ? { launcher: discovered.zed }
                : {}
            : discovered;
    const policy: ShellCapabilityResolution = { state: "ready", projectRoot: cwd, profile: "integrated", requestedProfile: "integrated",
        grants: { ...emptyGrants(), integrations: { [capability]: integration } }, requestedGrants: emptyGrants(), authorityPath: join(cwd, "unused-authority") };
    const owner = Symbol(`installed-${capability}-smoke`);
    const previous = new Map(
        Object.keys(environment).map((name) => [name, process.env[name]]),
    );
    for (const [name, value] of Object.entries(environment))
        process.env[name] = value;
    publishShellRuntime(owner, () => policy);
    let session: Awaited<ReturnType<typeof createTestSession>> | undefined;
    try {
        session = await createTestSession({
            cwd,
            extensions: [resolve(import.meta.dir, "index.ts")],
            propagateErrors: false,
        });
        await session.run(
            when(`Run installed ${capability} smoke`, [
                calls("safe_bash", {
                    command,
                    hostCapability: capability,
                    timeout: 90,
                }),
                says("Smoke observed"),
            ]),
        );
        const result = session.events.toolResultsFor("safe_bash")[0];
        expect(result, result?.text).toMatchObject({
            mocked: false,
            isError: false,
            details: {
                execution: {
                    backend: "host",
                    shellProfile: "integrated",
                    hostCapability: capability,
                    exitCode: 0,
                    outcome: "succeeded",
                    tmpNamespace: "host",
                },
            },
        });
        return result?.text ?? "";
    } finally {
        await session?.session.extensionRunner?.emit({
            type: "session_shutdown",
            reason: "quit",
        });
        session?.dispose();
        releaseShellRuntime(owner);
        for (const [name, value] of previous)
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
    }
}

test.skipIf(!enabled)("installed SFW performs a benign npm installation with a fresh npm cache", async () => {
    const cwd = await mkdtemp(join(import.meta.dir, ".sfw-smoke-"));
    try {
        await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "pi-sandbox-capability-smoke", private: true, version: "1.0.0", packageManager: "npm@12.0.1" }));
        await writeFile(join(cwd, ".npmrc"), "ignore-scripts=true\nmin-release-age=7\nallow-git=none\n");
        await run("dependencies", cwd, "npm install is-number@7.0.0 --save-exact --no-audit --no-fund", { npm_config_cache: join(cwd, ".fresh-npm-cache") });
        const manifest = JSON.parse(await readFile(join(cwd, "node_modules/is-number/package.json"), "utf8"));
        expect({ name: manifest.name, version: manifest.version }).toEqual({ name: "is-number", version: "7.0.0" });
    } finally { await rm(cwd, { recursive: true, force: true }); }
}, 100_000);

test.skipIf(!enabled)("installed Zed accepts a named file from the approved project", async () => {
    const cwd = await mkdtemp(join(import.meta.dir, ".zed-smoke-"));
    try {
        await writeFile(join(cwd, "sandbox-capability-smoke.txt"), "Pi sandbox capability smoke test. This temporary file contains no project data.\n");
        await run("editor", cwd, "editor sandbox-capability-smoke.txt");
        // Zed forwards the request asynchronously. Keep the fixture available for
        // the optional manual UI observation instead of deleting it on CLI exit.
        if (process.env.PI_SANDBOX_ZED_OBSERVE === "1") await Bun.sleep(30_000);
    } finally { await rm(cwd, { recursive: true, force: true }); }
}, 100_000);

test.skipIf(!enabled || !process.env.PI_SANDBOX_DEV_SERVICES_PROJECT)("installed Dev Services executes in an already registered project with host provenance", async () => {
    const cwd = resolve(process.env.PI_SANDBOX_DEV_SERVICES_PROJECT!);
    expect(await run("dev-services", cwd, "printf pi-dev-services-host-smoke")).toContain("pi-dev-services-host-smoke");
}, 100_000);
