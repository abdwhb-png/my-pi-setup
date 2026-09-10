import { expect, test } from "bun:test";
import { calls, createTestSession, says, when } from "@abdwhb-png/pi-test-harness";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { emptyGrants, HOST_CAPABILITIES } from "../sandbox/capabilities/authority.ts";
import { publishShellRuntime, releaseShellRuntime } from "../sandbox/capabilities/runtime.ts";

test.each([true, false])("real Pi blocks native write and edit of local authority and aliases (exists=%s)", async exists => {
    const root = await mkdtemp(join(tmpdir(), "pi-authority-tools-"));
    const cwd = join(root, "project"); await mkdir(cwd);
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    const authority = join(root, "sandbox.capabilities.json");
    const original = JSON.stringify({ version: 1, machineId: "foreign-fixture", projects: [] });
    if (exists) await writeFile(authority, original, { mode: 0o600 });
    await symlink(authority, join(cwd, "alias"));
    if (exists) await link(authority, join(cwd, "hardlink"));
    else await symlink(authority, join(cwd, "hardlink"));
    let session: Awaited<ReturnType<typeof createTestSession>> | undefined;
    try {
        session = await createTestSession({ cwd, extensions: [resolve(import.meta.dir, "../sandbox/index.ts")], propagateErrors: false });
        await session.run(when("Attempt native authority changes", [
            calls("write", { path: authority, content: "changed" }),
            calls("write", { path: join(cwd, "alias"), content: "changed" }),
            calls("edit", { path: join(cwd, "hardlink"), oldText: "foreign-fixture", newText: "local" }),
            says("All changes refused"),
        ]));
        for (const tool of ["write", "edit"]) for (const result of session.events.toolResultsFor(tool)) {
            expect(result.isError).toBe(true);
            expect(result.text).toContain("/sandbox capabilities");
        }
        expect(session.events.toolResultsFor("write")).toHaveLength(2);
        expect(session.events.toolResultsFor("edit")).toHaveLength(1);
        if (exists) expect(await readFile(authority, "utf8")).toBe(original);
        else await expect(readFile(authority, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
        await session?.session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }); session?.dispose();
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
        await rm(root, { recursive: true, force: true });
    }
}, 30_000);

test("real Pi keeps safe_bash on the Bash permission surface for every host capability", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-permission-capabilities-"));
    const cwd = join(root, "project"); await mkdir(cwd);
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    const owner = Symbol("permissions-capabilities");
    const launcher = join(root, "launcher");
    const marker = join(root, "spawned");
    await writeFile(launcher, `#!/bin/sh\nprintf spawned > '${marker}'\n`, { mode: 0o700 });
    const configDir = join(root, "extensions/pi-permission-system"); await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "config.json"), JSON.stringify({
        authorizerChain: [], shellTools: { safe_bash: { commandArgument: "command" } },
        permission: { "*": "allow", bash: { "git *": "deny" } },
    }));
    publishShellRuntime(owner, () => ({ state: "ready", projectRoot: cwd, profile: "integrated", requestedProfile: "integrated",
        grants: { ...emptyGrants(), integrations: { editor: { zed: launcher }, dependencies: { sfw: launcher, npm: launcher }, "dev-services": { "dev-services": launcher } } },
        requestedGrants: emptyGrants(), authorityPath: join(root, "sandbox.capabilities.json") }));
    let session: Awaited<ReturnType<typeof createTestSession>> | undefined;
    try {
        session = await createTestSession({ cwd, propagateErrors: false,
            extensions: [resolve(import.meta.dir, "../../npm/node_modules/@gotgenes/pi-permission-system/src/index.ts"), resolve(import.meta.dir, "index.ts")] });
        await session.run(when("Try the denied Git operation through each capability", [
            ...HOST_CAPABILITIES.map(hostCapability => calls("safe_bash", { command: "git checkout HEAD -- sample.ts", hostCapability })),
            says("All refusals observed"),
        ]));
        expect(session.events.toolResultsFor("safe_bash")).toHaveLength(3);
        // Harness 0.7 infers `blocked` from the English word "blocked" in output.
        // Assert the real permission result and absence of execution instead.
        for (const result of session.events.toolResultsFor("safe_bash")) {
            expect(result.isError).toBe(true);
            expect(result.text).toContain("[pi-permission-system] is not permitted to run 'bash' command");
            expect(result.text).toContain("matched 'git *'");
            expect(result.text).not.toContain("unsupported-command");
        }
        await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
        await session?.session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
        session?.dispose(); releaseShellRuntime(owner);
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
        await rm(root, { recursive: true, force: true });
    }
}, 30_000);

test("real Pi preserves a failed SFW exit and never invokes an unwrapped manager", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-sfw-failure-"));
    const cwd = join(root, "project"); await mkdir(cwd);
    const sfw = join(root, "sfw"); const npm = join(root, "npm"); const marker = join(root, "manager-ran");
    await writeFile(sfw, "#!/bin/sh\nprintf 'SFW fixture refusal\\n' >&2\nexit 31\n", { mode: 0o700 });
    await writeFile(npm, `#!/bin/sh\nprintf ran > '${marker}'\n`, { mode: 0o700 });
    const owner = Symbol("sfw-failure");
    publishShellRuntime(owner, () => ({ state: "ready", projectRoot: cwd, profile: "integrated", requestedProfile: "integrated",
        grants: { ...emptyGrants(), integrations: { dependencies: { sfw, npm } } }, requestedGrants: emptyGrants(), authorityPath: join(root, "authority") }));
    const session = await createTestSession({ cwd, extensions: [resolve(import.meta.dir, "index.ts")], propagateErrors: false });
    try {
        await session.run(when("Install with the approved SFW integration", [calls("safe_bash", { command: "npm install is-number@7.0.0", hostCapability: "dependencies" }), says("Observed failure")]));
        expect(session.events.toolResultsFor("safe_bash")[0]).toMatchObject({ isError: true, mocked: false, details: {
            execution: { status: "unsandboxed", backend: "host", shellProfile: "integrated", hostCapability: "dependencies", tmpNamespace: "host", exitCode: 31, outcome: "failed" },
        } });
        expect(session.events.toolResultsFor("safe_bash")[0].text).toContain("SFW fixture refusal");
        await expect(readFile(marker, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
        await session.session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); releaseShellRuntime(owner);
        await rm(root, { recursive: true, force: true });
    }
}, 30_000);
