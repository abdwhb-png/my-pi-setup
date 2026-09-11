import { describe, expect, it, mock } from "bun:test";
import {
    chmod,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { createPrivateTempLease } from "./private-temp.ts";
import {
    createAnalysisPolicy,
    createBashPolicy,
    validatePiSandboxConfig,
} from "./policies.ts";
import {
    createZeroboxBackend,
    type ZeroboxCommandResult,
} from "./zerobox-backend.ts";

import expectedProvenance from "./zerobox-provenance.json";
const EXPECTED_SHA = expectedProvenance.binarySha256;

function successfulRun(
    _file: string,
    args: string[],
): ZeroboxCommandResult {
    if (args.includes("--version"))
        return { exitCode: 0, stdout: "zerobox 0.3.3-fork.17\n", stderr: "" };
    if (args.includes("--help"))
        return { exitCode: 0, stdout: "--allow-unix-socket PATH\n--publish-tcp RULE\n", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
}

describe("Zerobox backend", () => {
    it("writes a private profile and returns exact public CLI argv", async () => {
        const parent = await mkdtemp(join(tmpdir(), "z-"));
        const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
        process.env.PI_CODING_AGENT_DIR = join(parent, "agent");
        await mkdir(getAgentDir());
        await writeFile(join(getAgentDir(), "sandbox.global.json"), "{}", { mode: 0o600 });
        const binaryPath = join(parent, "zerobox");
        await writeFile(binaryPath, "fixture", { mode: 0o755 });
        await chmod(binaryPath, 0o755);
        const lease = await createPrivateTempLease({ rootDir: join(parent, "r") });
        const runCommand = mock(successfulRun);
        try {
            const backend = createZeroboxBackend({
                binaryPath,
                platform: "linux",
                hashFile: async () => EXPECTED_SHA,
                runCommand,
            });
            await backend.probe();
            const policy = createBashPolicy({
                cwd: parent,
                lease,
                config: validatePiSandboxConfig(
                    {
                        filesystem: {
                            denyRead: [join(parent, "secret"), "*.pem"],
                            denyWrite: [join(parent, ".env"), "private/**"],
                        },
                        network: {
                            allowedDomains: ["example.com", "localhost:8317"],
                            allowedHostDomains: ["*.dev.test:443"],
                            deniedDomains: ["blocked.example.com"],
                        },
                        environment: {
                            allowedVariables: ["CUSTOM"],
                            variables: {
                                LD_PRELOAD: "/target/inject.so",
                                BASH_ENV: "/target/bash-env",
                                NODE_OPTIONS: "--require=/target/hook.cjs",
                            },
                        },
                        resources: {
                            unixSockets: [join(parent, "service.sock")],
                            tcpPublications: [{ transport: "tcp", scope: "host", listen: "127.0.0.1:41001", target: "127.0.0.1:41002" }],
                        },
                    },
                    {
                        mode: "targeted",
                        endpoint: "unix:///var/run/docker.sock",
                        targets: [
                            {
                                selector: {
                                    type: "container-name",
                                    name: "api",
                                },
                                operations: ["logs", "inspect"],
                                allowUnsafeTarget: false,
                            },
                        ],
                    },
                ),
                hostEnv: {
                    USER: "tester",
                    CUSTOM: "target-only",
                    SECRET: "must-not-pass",
                },
            });
            const spec = await backend.prepare(
                {
                    file: "/bin/bash",
                    args: ["-c", "printf ok"],
                    cwd: parent,
                    stdin: "input",
                },
                policy,
                lease,
            );

            expect(spec.file).toBe(binaryPath);
            expect(spec.args).toEqual([
                expect.stringMatching(/^--profile=bash-general-[a-f0-9]{24}$/),
                "--strict-sandbox",
                "--status-fd=3",
                `--private-tmp=${lease.tmpDir}`,
                `--private-home=${lease.homeDir}`,
                "--allow-local-binding",
                `--allow-unix-socket=${join(parent, "service.sock")}`,
                "--publish-tcp=host@127.0.0.1:41001->127.0.0.1:41002",
                "-C",
                parent,
                "--",
                "/bin/bash",
                "-c",
                "printf ok",
            ]);
            expect(spec.cwd).toBe(parent);
            expect(spec.statusProtocol).toEqual({ fd: 3, version: 1 });
            expect(spec.extraStdio).toHaveLength(1);
            expect(spec.extraStdio[0]).toBeNumber();
            expect(spec.env).toEqual({
                ZEROBOX_HOME: lease.zeroboxHome,
                PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            });
            expect(JSON.stringify(spec)).not.toContain("must-not-pass");
            expect(spec.sandboxContext).toMatchObject({
                version: 1,
                profile: "bash-general",
                network: {
                    allow: ["example.com", "localhost:8317"],
                    allowHost: ["*.dev.test:443"],
                    deny: ["blocked.example.com"],
                    domainClientProxyRequired: true,
                    loopback: {
                        hostNamespace: "isolated",
                        hostBridgePorts: [8317],
                        hostBridgeTransport: "managed-policy-proxy",
                        unlistedHostPorts: "blocked",
                        localListeners: "sandbox-only",
                    },
                },
                environment: {
                    inherit: expect.arrayContaining(["USER", "CUSTOM"]),
                    set: expect.arrayContaining(["CUSTOM", "HOME", "PATH"]),
                    deny: [],
                },
            });
            expect(JSON.stringify(spec.sandboxContext)).not.toContain(
                "target-only",
            );
            expect(JSON.stringify(spec.sandboxContext)).not.toContain(
                lease.root,
            );
            expect(JSON.stringify(spec.args)).not.toContain("bwrap");
            expect(JSON.stringify(spec.args)).not.toContain("disable-userns");

            const profileName = spec.args[0]!.slice("--profile=".length);
            const profilePath = join(lease.profilesDir, `${profileName}.json`);
            expect((await lstat(profilePath)).mode & 0o777).toBe(0o600);
            const profile = JSON.parse(await readFile(profilePath, "utf8"));
            expect(profile).toEqual({
                description: "Pi private bash-general sandbox policy",
                strict_sandbox: true,
                allow_read: [
                    "/usr/bin",
                    "/usr/sbin",
                    "/usr",
                    "/usr/lib",
                    "/usr/lib64",
                    "/etc/ld.so.cache",
                    "/etc/ld.so.conf",
                    "/etc/ld.so.conf.d",
                    parent,
                    lease.homeDir,
                    lease.tmpDir,
                    lease.proxyRunsDir,
                ],
                deny_read: [
                    "/proc/1/root",
                    join(parent, "r"),
                ],
                deny_read_globs: ["*.pem", join(parent, "secret"), join(getAgentDir(), "sandbox.json")],
                allow_write: [
                    parent,
                    lease.homeDir,
                    lease.tmpDir,
                ],
                deny_write: [
                    "/mnt/c",
                    "/proc/1/root",
                    join(parent, "r"),
                ],
                deny_write_globs: ["private/**", join(parent, ".env"), join(getAgentDir(), "sandbox.json")],
                allow_net: ["example.com", "localhost:8317"],
                allow_host_net: ["*.dev.test:443"],
                deny_net: ["blocked.example.com"],
                allow_env: [
                    "USER",
                    "SHELL",
                    "TERM",
                    "LANG",
                    "COLORTERM",
                    "NO_COLOR",
                    "CUSTOM",
                ],
                set_env: policy.environment.set,
                docker: policy.docker,
            });
            expect(profile.use).toBeUndefined();
            expect(profile.secret_hosts).toBeUndefined();
            expect(JSON.stringify(profile)).not.toContain("ZEROBOX_HOME");
            expect(profile.set_env).toMatchObject({
                USER: "tester",
                CUSTOM: "target-only",
                LD_PRELOAD: "/target/inject.so",
                BASH_ENV: "/target/bash-env",
                NODE_OPTIONS: "--require=/target/hook.cjs",
            });
            await spec.cleanup?.();
            await expect(lstat(profilePath)).rejects.toMatchObject({ code: "ENOENT" });

            const protectedTarget = join(parent, "protected-target");
            await writeFile(protectedTarget, "protected");
            const predictableProfilePath = join(
                lease.profilesDir,
                "bash-general.json",
            );
            await symlink(protectedTarget, predictableProfilePath);
            const replacement = await backend.prepare(
                { file: "/bin/true", args: [], cwd: parent },
                policy,
                lease,
            );
            expect(await readFile(protectedTarget, "utf8")).toBe("protected");
            expect((await lstat(predictableProfilePath)).isSymbolicLink()).toBe(
                true,
            );
            expect(replacement.args[0]).not.toBe(spec.args[0]);
            await replacement.cleanup?.();
        } finally {
            if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
            else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
            await lease.dispose();
            await rm(parent, { recursive: true, force: true });
        }
    });

    it("pins concurrent prepares to distinct immutable profiles", async () => {
        const parent = await mkdtemp(join(tmpdir(), "z-"));
        const binaryPath = join(parent, "zerobox");
        await writeFile(binaryPath, "fixture", { mode: 0o755 });
        await chmod(binaryPath, 0o755);
        const lease = await createPrivateTempLease({
            rootDir: join(parent, "r"),
        });
        try {
            const backend = createZeroboxBackend({
                binaryPath,
                platform: "linux",
                hashFile: async () => EXPECTED_SHA,
                runCommand: successfulRun,
            });
            const policy = createBashPolicy({
                cwd: parent,
                lease,
                config: validatePiSandboxConfig({}),
                hostEnv: {},
            });

            const [first, second] = await Promise.all([
                backend.prepare(
                    { file: "/bin/true", args: [], cwd: parent },
                    policy,
                    lease,
                ),
                backend.prepare(
                    { file: "/bin/true", args: [], cwd: parent },
                    policy,
                    lease,
                ),
            ]);
            expect(first.args[0]).not.toBe(second.args[0]);
            for (const spec of [first, second]) {
                const name = spec.args[0]!.slice("--profile=".length);
                expect((await lstat(join(lease.profilesDir, `${name}.json`))).isFile()).toBe(
                    true,
                );
            }
            await Promise.all([first.cleanup?.(), second.cleanup?.()]);
        } finally {
            await lease.dispose();
            await rm(parent, { recursive: true, force: true });
        }
    });

    it("rejects an allowed symlink that reopens the lease control root", async () => {
        const parent = await mkdtemp(join(tmpdir(), "z-"));
        const binaryPath = join(parent, "zerobox");
        await writeFile(binaryPath, "fixture", { mode: 0o755 });
        await chmod(binaryPath, 0o755);
        const lease = await createPrivateTempLease({ rootDir: join(parent, "r") });
        const cwd = join(parent, "project");
        await mkdir(cwd);
        const alias = join(cwd, "lease-alias");
        await symlink(lease.root, alias);
        try {
            const backend = createZeroboxBackend({
                binaryPath,
                platform: "linux",
                hashFile: async () => EXPECTED_SHA,
                runCommand: successfulRun,
            });
            const policy = createBashPolicy({
                cwd,
                lease,
                config: validatePiSandboxConfig({
                    filesystem: { allowWrite: [alias] },
                }),
                hostEnv: {},
            });

            await expect(
                backend.prepare(
                    { file: "/bin/true", args: [], cwd },
                    policy,
                    lease,
                ),
            ).rejects.toMatchObject({ code: "invalid-policy" });
        } finally {
            await rm(alias, { force: true });
            await lease.dispose();
            await rm(parent, { recursive: true, force: true });
        }
    });

    it("rejects Analysis readable paths inside lease control data", async () => {
        const parent = await mkdtemp(join(tmpdir(), "z-"));
        const binaryPath = join(parent, "zerobox");
        await writeFile(binaryPath, "fixture", { mode: 0o755 });
        await chmod(binaryPath, 0o755);
        const lease = await createPrivateTempLease({
            rootDir: join(parent, "r"),
        });
        try {
            const backend = createZeroboxBackend({
                binaryPath,
                platform: "linux",
                hashFile: async () => EXPECTED_SHA,
                runCommand: successfulRun,
            });
            const policy = createAnalysisPolicy({
                cwd: parent,
                lease,
                readablePaths: [lease.profilesDir],
            });

            await expect(
                backend.prepare(
                    { file: "/bin/true", args: [], cwd: parent },
                    policy,
                    lease,
                ),
            ).rejects.toMatchObject({ code: "invalid-policy" });
        } finally {
            await lease.dispose();
            await rm(parent, { recursive: true, force: true });
        }
    });

    it("removes a published profile when status-channel setup fails", async () => {
        const parent = await mkdtemp(join(tmpdir(), "z-"));
        const binaryPath = join(parent, "zerobox");
        await writeFile(binaryPath, "fixture", { mode: 0o755 });
        await chmod(binaryPath, 0o755);
        const lease = await createPrivateTempLease({
            rootDir: join(parent, "r"),
        });
        try {
            const backend = createZeroboxBackend({
                binaryPath,
                platform: "linux",
                hashFile: async () => EXPECTED_SHA,
                runCommand: successfulRun,
                createStatusChannel: async () => {
                    throw new Error("status setup failed");
                },
            });
            const policy = createBashPolicy({
                cwd: parent,
                lease,
                config: validatePiSandboxConfig({}),
                hostEnv: {},
            });

            await expect(
                backend.prepare(
                    { file: "/bin/true", args: [], cwd: parent },
                    policy,
                    lease,
                ),
            ).rejects.toMatchObject({ code: "setup-failed" });
            expect(
                (await readdir(lease.profilesDir)).filter((name) =>
                    name.endsWith(".json"),
                ),
            ).toEqual([]);
        } finally {
            await lease.dispose();
            await rm(parent, { recursive: true, force: true });
        }
    });

    it("rejects a probe root symlink without touching its target", async () => {
        const parent = await mkdtemp(join(tmpdir(), "z-"));
        const binaryPath = join(parent, "zerobox");
        const protectedDirectory = join(parent, "protected");
        const probeRoot = join(parent, "probe-root");
        await writeFile(binaryPath, "fixture", { mode: 0o755 });
        await mkdir(protectedDirectory, { mode: 0o700 });
        await writeFile(join(protectedDirectory, "keep"), "kept");
        await symlink(protectedDirectory, probeRoot);
        try {
            const backend = createZeroboxBackend({
                binaryPath,
                platform: "linux",
                probeRoot,
                expectedProvenance: {
                    version: "0.3.3-fork.17",
                    binarySha256: EXPECTED_SHA,
                },
                hashFile: async () => EXPECTED_SHA,
                runCommand: successfulRun,
            });

            await expect(backend.probe()).rejects.toMatchObject({
                code: "invalid-policy",
            });
            expect(await readFile(join(protectedDirectory, "keep"), "utf8")).toBe(
                "kept",
            );
        } finally {
            await rm(parent, { recursive: true, force: true });
        }
    });

    it("fails closed for platform, missing binary, provenance, spawn, and strict failures", async () => {
        const parent = await mkdtemp(join(tmpdir(), "z-"));
        const binaryPath = join(parent, "zerobox");
        await writeFile(binaryPath, "fixture", { mode: 0o755 });
        try {
            const cases = [
                {
                    options: { binaryPath, platform: "darwin" as NodeJS.Platform },
                    code: "unsupported-platform",
                },
                {
                    options: { binaryPath: join(parent, "missing"), platform: "linux" as NodeJS.Platform },
                    code: "backend-unavailable",
                },
                {
                    options: { binaryPath, platform: "linux" as NodeJS.Platform, hashFile: async () => "wrong" },
                    code: "provenance-mismatch",
                },
                {
                    options: {
                        binaryPath,
                        platform: "linux" as NodeJS.Platform,
                        hashFile: async () => EXPECTED_SHA,
                        runCommand: () => ({ exitCode: 0, stdout: "zerobox 9.9.9\n", stderr: "" }),
                    },
                    code: "provenance-mismatch",
                },
                {
                    options: {
                        binaryPath,
                        platform: "linux" as NodeJS.Platform,
                        hashFile: async () => EXPECTED_SHA,
                        runCommand: () => {
                            throw new Error("private spawn detail");
                        },
                    },
                    code: "spawn-failed",
                },
                {
                    options: {
                        binaryPath,
                        platform: "linux" as NodeJS.Platform,
                        hashFile: async () => EXPECTED_SHA,
                        runCommand: (file: string, args: string[]) =>
                            args.includes("--version")
                                ? successfulRun(file, args)
                                : { exitCode: 125, stdout: "", stderr: "private strict detail" },
                    },
                    code: "strict-unavailable",
                },
            ];
            for (const testCase of cases) {
                try {
                    await createZeroboxBackend(testCase.options).probe();
                    throw new Error("expected probe failure");
                } catch (error) {
                    expect(error).toMatchObject({ code: testCase.code });
                    expect((error as Error).message).not.toContain("private");
                }
            }
        } finally {
            await rm(parent, { recursive: true, force: true });
        }
    });
});
