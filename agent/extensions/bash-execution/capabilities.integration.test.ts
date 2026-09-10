import { expect, test } from "bun:test";
import { calls, createTestSession, says, when } from "@abdwhb-png/pi-test-harness";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import {
    CapabilityError,
    emptyGrants,
    HOST_CAPABILITIES,
} from "../sandbox/capabilities/authority.ts";
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

test.each([
    {
        code: "invalid-authority" as const,
        expected: "/sandbox capabilities",
        state: "throw" as const,
    },
    {
        code: "authorization-required" as const,
        expected: "/sandbox capabilities grant editor",
        state: "ready" as const,
        expectedProfile: "integrated" as const,
    },
    {
        code: "migration-required" as const,
        expected: "/sandbox capabilities migrate",
        state: "migration-required" as const,
        expectedProfile: "isolated" as const,
    },
    {
        code: "machine-mismatch" as const,
        expected: "/sandbox capabilities migrate",
        state: "machine-mismatch" as const,
        expectedProfile: "isolated" as const,
    },
    {
        code: "integration-unavailable" as const,
        expected: "/sandbox capabilities",
        state: "unavailable" as const,
        expectedProfile: "integrated" as const,
    },
    {
        code: "unsupported-command" as const,
        expected:
            "The editor may open existing files inside the approved project only",
        state: "missing-file" as const,
        expectedProfile: "integrated" as const,
    },
])(
    "real Pi surfaces actionable safe_bash capability failure $code",
    async ({ code, expected, state, expectedProfile }) => {
        const root = await mkdtemp(join(tmpdir(), "pi-capability-error-"));
        const cwd = join(root, "project");
        await mkdir(cwd);
        await writeFile(join(cwd, "existing.ts"), "export {};\n");
        const launcher = join(root, "zed");
        const marker = join(root, "spawned");
        await writeFile(
            launcher,
            `#!/bin/sh\nprintf spawned > '${marker}'\n`,
            { mode: 0o700 },
        );
        const owner = Symbol(`capability-error-${code}`);
        const grants = emptyGrants();
        if (state === "unavailable") grants.integrations.editor = {};
        if (state === "missing-file")
            grants.integrations.editor = { zed: launcher };
        publishShellRuntime(owner, () => {
            if (state === "throw")
                throw new CapabilityError(
                    "invalid-authority",
                    "Inspect the local authority with /sandbox capabilities.",
                );
            return {
                state:
                    state === "migration-required" ||
                    state === "machine-mismatch"
                        ? state
                        : "ready",
                projectRoot: cwd,
                profile:
                    state === "migration-required" ||
                    state === "machine-mismatch"
                        ? "isolated"
                        : "integrated",
                requestedProfile: "integrated",
                grants,
                requestedGrants: emptyGrants(),
                authorityPath: join(root, "sandbox.capabilities.json"),
                diagnostic:
                    state === "migration-required" ||
                    state === "machine-mismatch"
                        ? "Use /sandbox capabilities migrate."
                        : undefined,
            };
        });
        let session:
            | Awaited<ReturnType<typeof createTestSession>>
            | undefined;
        try {
            session = await createTestSession({
                cwd,
                extensions: [resolve(import.meta.dir, "index.ts")],
                propagateErrors: false,
            });
            await session.run(
                when("Open the approved project file", [
                    calls("safe_bash", {
                        command:
                            state === "unavailable"
                                ? "zed existing.ts"
                                : "zed absent.ts",
                        hostCapability: "editor",
                    }),
                    says("Observed refusal"),
                ]),
            );

            const result = session.events.toolResultsFor("safe_bash")[0];
            expect(result?.isError).toBe(true);
            expect(result?.text).toContain(code);
            expect(result?.text).toContain(expected);
            expect(result?.text).not.toContain(
                "Command failed (raw output redacted)",
            );
            if (expectedProfile)
                expect(result?.details).toMatchObject({
                    execution: { shellProfile: expectedProfile },
                });
            await expect(readFile(marker, "utf8")).rejects.toMatchObject({
                code: "ENOENT",
            });
        } finally {
            await session?.session.extensionRunner?.emit({
                type: "session_shutdown",
                reason: "quit",
            });
            session?.dispose();
            releaseShellRuntime(owner);
            await rm(root, { recursive: true, force: true });
        }
    },
    30_000,
);

test("real Pi runs every approved host integration through safe_bash and Bash permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-capability-success-"));
    const cwd = join(root, "project");
    await mkdir(cwd);
    const projectFile = join(cwd, "sample.ts");
    await writeFile(projectFile, "export {};\n");
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = root;
    const configDir = join(root, "extensions/pi-permission-system");
    await mkdir(configDir, { recursive: true });
    await writeFile(
        join(configDir, "config.json"),
        JSON.stringify({
            authorizerChain: [],
            shellTools: { safe_bash: { commandArgument: "command" } },
            permission: { "*": "allow" },
        }),
    );
    const markers = {
        editor: join(root, "editor.args"),
        dependencies: join(root, "dependencies.args"),
        "dev-services": join(root, "dev-services.args"),
    };
    const launcher = async (name: keyof typeof markers, output: string) => {
        const path = join(root, name);
        await writeFile(
            path,
            `#!/bin/sh\nprintf '%s\\n' "$@" > '${markers[name]}'\nprintf '${output}'\n`,
            { mode: 0o700 },
        );
        return path;
    };
    const editorLauncher = await launcher("editor", "editor-ok");
    const sfw = await launcher("dependencies", "dependencies-ok");
    const devServices = await launcher("dev-services", "dev-services-ok");
    const npm = join(root, "npm");
    await writeFile(npm, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const owner = Symbol("capability-success");
    publishShellRuntime(owner, () => ({
        state: "ready",
        projectRoot: cwd,
        profile: "integrated",
        requestedProfile: "integrated",
        grants: {
            ...emptyGrants(),
            integrations: {
                editor: { launcher: editorLauncher },
                dependencies: { sfw, npm },
                "dev-services": { "dev-services": devServices },
            },
        },
        requestedGrants: emptyGrants(),
        authorityPath: join(root, "sandbox.capabilities.json"),
    }));
    let session: Awaited<ReturnType<typeof createTestSession>> | undefined;
    try {
        session = await createTestSession({
            cwd,
            propagateErrors: false,
            extensions: [
                resolve(
                    import.meta.dir,
                    "../../npm/node_modules/@gotgenes/pi-permission-system/src/index.ts",
                ),
                resolve(import.meta.dir, "index.ts"),
            ],
        });
        await session.run(
            when("Use each approved local integration", [
                calls("safe_bash", {
                    command: "editor sample.ts",
                    hostCapability: "editor",
                }),
                calls("safe_bash", {
                    command: "npm install sample@1.0.0 --no-audit",
                    hostCapability: "dependencies",
                }),
                calls("safe_bash", {
                    command: "npm test",
                    hostCapability: "dev-services",
                }),
                says("All integrations completed"),
            ]),
        );

        const results = session.events.toolResultsFor("safe_bash");
        expect(results).toHaveLength(3);
        for (const [index, capability] of HOST_CAPABILITIES.entries()) {
            expect(results[index]).toMatchObject({
                isError: false,
                mocked: false,
                details: {
                    execution: {
                        status: "unsandboxed",
                        backend: "host",
                        shellProfile: "integrated",
                        hostCapability: capability,
                        tmpNamespace: "host",
                        exitCode: 0,
                        outcome: "succeeded",
                    },
                },
            });
            expect(results[index]?.text).toContain(`${capability}-ok`);
        }
        expect(await readFile(markers.editor, "utf8")).toBe(
            `${projectFile}\n`,
        );
        expect(await readFile(markers.dependencies, "utf8")).toBe(
            `${npm}\ninstall\nsample@1.0.0\n--no-audit\n--ignore-scripts\n`,
        );
        expect(await readFile(markers["dev-services"], "utf8")).toBe(
            `--path\n${cwd}\nrun\nnpm\ntest\n`,
        );
    } finally {
        await session?.session.extensionRunner?.emit({
            type: "session_shutdown",
            reason: "quit",
        });
        session?.dispose();
        releaseShellRuntime(owner);
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
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
