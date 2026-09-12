import { describe, expect, it } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { SandboxExecutionError } from "./contracts.ts";
import {
    buildBashPath,
    createAnalysisPolicy,
    createBashPolicy,
    createThinkPolicy,
    isNetworkDestinationAllowed,
    SANDBOX_PRIVATE_HOME,
    validatePiSandboxConfig,
} from "./policies.ts";

const cwd = join(homedir(), "projects", "fixture");
const lease = {
    root: join(homedir(), ".pi", "zbx", "lease-1"),
    homeDir: join(homedir(), ".pi", "zbx", "lease-1", "home"),
    tmpDir: join(homedir(), ".pi", "zbx", "lease-1", "tmp"),
    zeroboxHome: join(
        homedir(),
        ".pi",
        "zbx",
        "lease-1",
        "zerobox-home",
    ),
    proxyRunsDir: join(
        homedir(),
        ".pi",
        "zbx",
        "lease-1",
        "zerobox-home",
        "tmp",
        "runs",
    ),
    profilesDir: join(
        homedir(),
        ".pi",
        "zbx",
        "lease-1",
        "zerobox-home",
        "profiles",
    ),
};

describe("sandbox policies", () => {
    it("limits an empty read configuration to the project and sandbox necessities", () => {
        const config = validatePiSandboxConfig({});
        const policy = createBashPolicy({ cwd, lease, config, hostEnv: {} });

        expect(policy.filesystem.allowRead).not.toContain("/");
        expect(policy.filesystem.allowRead).toContain(cwd);
    });

    it("does not reopen the project when an explicit empty read or write ceiling is compiled", () => {
        const config = validatePiSandboxConfig({
            filesystem: { allowRead: [], allowWrite: [] },
        });
        const policy = createBashPolicy({ cwd, lease, config, hostEnv: {} });

        expect(policy.filesystem.allowRead).not.toContain(cwd);
        expect(policy.filesystem.allowWrite).not.toContain(cwd);
    });

    it("isolates Bash temporary files by default while keeping Bash HOME and strict Think HOME", () => {
        const config = validatePiSandboxConfig({ filesystem: { allowWrite: ["."] } });
        const bash = createBashPolicy({ cwd, lease, config, hostEnv: {} });
        expect(bash.tmpNamespace).toBe("lease-private");
        expect(bash.filesystem.allowWrite).not.toContain("/tmp");
        expect(bash.environment.set.HOME).toBe(SANDBOX_PRIVATE_HOME);
        const shared = createBashPolicy({ cwd, lease, config: { ...config, tmpNamespace: "host" } });
        expect(shared.tmpNamespace).toBe("host");
        const think = createThinkPolicy({ cwd, lease, config: { ...config, tmpNamespace: "host" } });
        expect(think.tmpNamespace).toBe("lease-private");
        expect(think.environment.set.HOME).toBe(SANDBOX_PRIVATE_HOME);
    });
    it("honors an explicit project denial of the host tmp root", () => {
        const config = validatePiSandboxConfig({ filesystem: { allowWrite: ["."], denyRead: ["/tmp"] } });
        const policy = createBashPolicy({ cwd, lease, config });
        expect(policy.filesystem.allowRead).not.toContain("/tmp");
        expect(policy.filesystem.allowWrite).not.toContain("/tmp");
        expect(policy.filesystem.denyRead).toContain("/tmp");
    });
    it("shares host tmp for development while retaining explicit project restrictions", () => {
        const config = validatePiSandboxConfig({
            tmpNamespace: "host",
            filesystem: { allowWrite: ["."], denyRead: ["/tmp/project-secret"] },
        });
        const policy = createBashPolicy({ cwd, lease, config, hostEnv: {} });
        expect(policy.filesystem.allowRead).toContain("/tmp");
        expect(policy.filesystem.allowWrite).toContain("/tmp");
        expect(policy.filesystem.denyRead).not.toContain("/tmp");
        expect(policy.filesystem.denyWrite).not.toContain("/tmp");
        expect(policy.filesystem.denyRead).toContain("/tmp/project-secret");
        expect(policy.filesystem.denyRead).toContain(join(lease.root, ".."));
        expect(policy.strict).toBe(true);
    });

    it("builds distinct strict Bash and analysis policies", () => {
        const config = validatePiSandboxConfig({
            filesystem: {
                denyRead: ["~/.ssh"],
                allowWrite: ["."],
                denyWrite: [".env"],
            },
            network: {
                allowedDomains: ["example.com", "localhost:8317"],
                deniedDomains: ["blocked.example.com"],
            },
        });
        const bash = createBashPolicy({ cwd, lease, config, hostEnv: {} });
        const analysis = createAnalysisPolicy({
            cwd,
            lease,
            readablePaths: ["/usr/bin/node", "/usr/bin/prlimit"],
        });

        expect(bash.name).toBe("bash-general");
        const think = createThinkPolicy({ cwd, lease, config, hostEnv: {} });
        expect(think.environment.set.HOME).toBe(SANDBOX_PRIVATE_HOME);
        expect(analysis.environment.set.HOME).toBe(SANDBOX_PRIVATE_HOME);
        expect(bash.environment.set.DOCKER_CONFIG).toBe(SANDBOX_PRIVATE_HOME);
        expect(bash.filesystem.allowWrite).not.toContain(homedir());
        expect(analysis.name).toBe("analysis-strict");
        expect(bash.strict).toBe(true);
        expect(analysis.strict).toBe(true);
        expect(bash.network.mode).toBe("domain-allowlist");
        expect(bash.network.allowLocalBinding).toBe(true);
        expect(bash.environment.set.TMPDIR).toBe("/tmp");
        expect(analysis.network).toEqual({
            mode: "deny-all",
            allow: [],
            allowHost: [],
            deny: [],
        });
        expect(analysis.filesystem.denyReadGlobs).toEqual([]);
        expect(analysis.filesystem.denyWriteGlobs).toEqual([]);
        expect(analysis.docker).toEqual({ mode: "disabled" });
        expect(bash.filesystem.allowWrite).toContain(cwd);
        expect(bash.filesystem.allowWrite).toContain(lease.homeDir);
        expect(bash.filesystem.allowWrite).toContain(lease.tmpDir);
        expect(bash.filesystem.allowRead).not.toContain(lease.proxyRunsDir);
        expect(bash.filesystem.allowWrite).not.toContain(lease.proxyRunsDir);
        expect(bash.filesystem.allowWrite).not.toContain(lease.zeroboxHome);
        expect(bash.filesystem.allowWrite).not.toContain(lease.root);
        expect(bash.filesystem.denyRead).toContain(join(lease.root, ".."));
        expect(bash.filesystem.denyWrite).toContain(join(lease.root, ".."));
        expect(analysis.filesystem.allowRead).toEqual([
            "/usr/bin/node",
            "/usr/bin/prlimit",
            lease.homeDir,
            lease.tmpDir,
        ]);
        expect(analysis.filesystem.allowWrite).toEqual([
            lease.homeDir,
            lease.tmpDir,
        ]);
        expect(analysis.filesystem.allowRead).not.toContain(cwd);
        expect(JSON.stringify({ bash, analysis })).not.toContain("/tmp/claude");
        expect(JSON.stringify({ bash, analysis })).not.toContain('"use"');
    });

    it("keeps dynamic globs only in deny policies", () => {
        const policy = createBashPolicy({
            cwd,
            lease,
            config: validatePiSandboxConfig({
                filesystem: {
                    denyRead: ["*.pem", "private/**", "secret.txt"],
                    denyWrite: ["**/.env", "locked.txt"],
                },
            }),
            hostEnv: {},
        });

        expect(policy.filesystem.denyReadGlobs).toEqual([
            "*.pem",
            "private/**",
        ]);
        expect(policy.filesystem.denyWriteGlobs).toEqual(["**/.env"]);
        expect(policy.filesystem.denyRead).toContain(join(cwd, "secret.txt"));
        expect(policy.filesystem.denyWrite).toContain(join(cwd, "locked.txt"));
        expect(policy.filesystem.denyRead).not.toContain(join(cwd, "*.pem"));
    });

    it("canonicalizes IP socket addresses and applies Rust loopback semantics", () => {
        const config = validatePiSandboxConfig({
            resources: {
                tcpPublications: [
                    {
                        transport: "tcp",
                        scope: "host",
                        listen: "[0:0:0:0:0:0:0:1]:41001",
                        target: "[0:0:0:0:0:0:0:1]:41002",
                    },
                    {
                        transport: "tcp",
                        scope: "host",
                        listen: "127.0.0.2:41003",
                        target: "127.0.0.2:41004",
                    },
                ],
            },
        });
        expect(config.resources?.tcpPublications).toEqual([
            {
                transport: "tcp",
                scope: "host",
                listen: "[::1]:41001",
                target: "[::1]:41002",
            },
            {
                transport: "tcp",
                scope: "host",
                listen: "127.0.0.2:41003",
                target: "127.0.0.2:41004",
            },
        ]);
        expect(() =>
            validatePiSandboxConfig({
                resources: {
                    tcpPublications: [
                        {
                            transport: "tcp",
                            scope: "lan",
                            listen: "[0:0:0:0:0:0:0:0]:41005",
                            target: "127.0.0.1:41006",
                        },
                    ],
                },
            }),
        ).toThrow(SandboxExecutionError);
        expect(() =>
            validatePiSandboxConfig({
                resources: {
                    tcpPublications: [
                        {
                            transport: "tcp",
                            scope: "host",
                            listen: "192.168.1.20:41007",
                            target: "127.0.0.1:41008",
                        },
                    ],
                },
            }),
        ).toThrow(SandboxExecutionError);
        expect(() =>
            validatePiSandboxConfig({
                resources: {
                    tcpPublications: [
                        {
                            transport: "tcp",
                            scope: "lan",
                            listen: "[127.0.0.1]:41009",
                            target: "127.0.0.1:41010",
                        },
                    ],
                },
            }),
        ).toThrow(SandboxExecutionError);
    });

    it("always denies writes to the consolidated global authority", () => {
        const piRoot = join(homedir(), ".pi");
        const policy = createBashPolicy({
            cwd: piRoot,
            lease,
            config: validatePiSandboxConfig({
                filesystem: { allowWrite: ["."], denyWrite: [] },
            }),
            hostEnv: {},
        });

        expect(policy.filesystem.allowWrite).toContain(piRoot);
        expect(policy.filesystem.denyWrite).toContain(
            join(getAgentDir(), "sandbox.json"),
        );
    });

    it("passes the effective Docker policy only to Bash", () => {
        const docker = {
            mode: "targeted" as const,
            endpoint: "unix:///var/run/docker.sock",
            targets: [
                {
                    selector: {
                        type: "container-name" as const,
                        name: "api",
                    },
                    operations: ["logs" as const],
                    allowUnsafeTarget: false,
                },
            ],
        };
        const config = validatePiSandboxConfig({}, docker);

        expect(createBashPolicy({ cwd, lease, config, hostEnv: {} }).docker).toEqual(
            docker,
        );
        expect(
            createAnalysisPolicy({ cwd, lease, readablePaths: [] }).docker,
        ).toEqual({ mode: "disabled" });
    });

    it("rejects configured allows that override a more specific deny", () => {
        for (const filesystem of [
            { allowRead: ["/proc/1/root/etc/hostname"] },
            { allowWrite: ["/mnt/c/nested"] },
            { allowRead: ["private/child"], denyRead: ["private"] },
            { allowWrite: ["private/child"], denyWrite: ["private"] },
            { allowWrite: ["private/child"], denyRead: ["private"] },
        ]) {
            expect(() =>
                createBashPolicy({
                    cwd,
                    lease,
                    config: validatePiSandboxConfig({ filesystem }),
                    hostEnv: {},
                }),
            ).toThrow(SandboxExecutionError);
        }
    });

    it("fails closed when a user deny targets the logical private HOME", () => {
        try {
            createBashPolicy({
                cwd,
                lease,
                config: validatePiSandboxConfig({
                    filesystem: {
                        denyRead: [`${SANDBOX_PRIVATE_HOME}/credentials`],
                        denyWrite: [SANDBOX_PRIVATE_HOME],
                    },
                }),
            });
            throw new Error("expected logical HOME deny to be rejected");
        } catch (error) {
            expect(error).toMatchObject({ code: "invalid-policy" });
            expect((error as SandboxExecutionError).getCause()).toMatchObject({
                message: "A filesystem deny cannot target the logical private HOME",
            });
        }
    });

    it("keeps unrelated and cwd-relative deny globs while rejecting private HOME globs", () => {
        expect(() =>
            createBashPolicy({
                cwd: "/tmp/policy-glob-fixture",
                lease,
                config: validatePiSandboxConfig({
                    filesystem: { denyRead: ["/tmp/*.pem", "relative/*.pem"] },
                }),
            }),
        ).not.toThrow();
        for (const cwd of ["/tmp/policy-glob-fixture", SANDBOX_PRIVATE_HOME]) {
            try {
                createBashPolicy({
                    cwd,
                    lease,
                    config: validatePiSandboxConfig({
                        filesystem: {
                            denyWrite: [
                                `${SANDBOX_PRIVATE_HOME}/*.pem`,
                                ...(cwd === SANDBOX_PRIVATE_HOME
                                    ? ["*.token"]
                                    : []),
                            ],
                        },
                    }),
                });
                throw new Error("expected logical HOME glob to be rejected");
            } catch (error) {
                expect(error).toMatchObject({ code: "invalid-policy" });
            }
        }
    });

    it("implements explicit domain, wildcard, port, and deny precedence", () => {
        const policy = createBashPolicy({
            cwd,
            lease,
            config: validatePiSandboxConfig({
                network: {
                    allowedDomains: [
                        "example.com",
                        "api.example.net:443",
                        "*.packages.test",
                        "localhost:8317",
                    ],
                    deniedDomains: ["blocked.example.com", "bad.packages.test"],
                },
            }),
            hostEnv: {},
        });

        expect(isNetworkDestinationAllowed(policy.network, "example.com", 80)).toBe(true);
        expect(isNetworkDestinationAllowed(policy.network, "example.com", 443)).toBe(true);
        expect(isNetworkDestinationAllowed(policy.network, "api.example.net", 443)).toBe(true);
        expect(isNetworkDestinationAllowed(policy.network, "api.example.net", 80)).toBe(false);
        expect(isNetworkDestinationAllowed(policy.network, "cdn.packages.test", 443)).toBe(true);
        expect(isNetworkDestinationAllowed(policy.network, "packages.test", 443)).toBe(false);
        expect(isNetworkDestinationAllowed(policy.network, "bad.packages.test", 443)).toBe(false);
        expect(isNetworkDestinationAllowed(policy.network, "blocked.example.com", 443)).toBe(false);
        expect(isNetworkDestinationAllowed(policy.network, "localhost", 8317)).toBe(true);
        expect(isNetworkDestinationAllowed(policy.network, "127.0.0.1", 8317)).toBe(true);
        expect(isNetworkDestinationAllowed(policy.network, "::1", 8317)).toBe(true);
        expect(isNetworkDestinationAllowed(policy.network, "localhost", 8318)).toBe(false);
    });

    it("denies all network destinations when the allowlist is empty", () => {
        const policy = createBashPolicy({
            cwd,
            lease,
            config: validatePiSandboxConfig({
                network: { allowedDomains: [], deniedDomains: [] },
            }),
            hostEnv: {},
        });
        expect(policy.network.mode).toBe("deny-all");
        expect(isNetworkDestinationAllowed(policy.network, "example.com", 443)).toBe(false);
    });

    it("uses only explicit PATH entries without granting them filesystem access", () => {
        const config = validatePiSandboxConfig({
            environment: {
                path: ["/opt/project-tools/bin", "~/.local/bin"],
            },
        });
        const policy = createBashPolicy({ cwd, lease, config, hostEnv: {} });

        expect(policy.environment.set.PATH).toBe(
            buildBashPath(["/opt/project-tools/bin", join(homedir(), ".local/bin")]),
        );
        for (const path of ["/opt/project-tools/bin", join(homedir(), ".local/bin")]) {
            expect(policy.filesystem.allowRead).not.toContain(path);
            expect(policy.filesystem.allowWrite).not.toContain(path);
        }
    });

    it("allows an exact Windows read grant while keeping Windows writes blocked", () => {
        const windowsCache = "/mnt/c/Users/fixture/project-cache";
        const policy = createBashPolicy({
            cwd,
            lease,
            config: validatePiSandboxConfig({
                filesystem: { allowRead: [windowsCache] },
            }),
            hostEnv: {},
        });

        expect(policy.filesystem.allowRead).toContain(windowsCache);
        expect(policy.filesystem.denyRead).not.toContain("/mnt/c");
        expect(policy.filesystem.denyWrite).toContain("/mnt/c");
        expect(() =>
            createBashPolicy({
                cwd,
                lease,
                config: validatePiSandboxConfig({
                    filesystem: { allowWrite: [windowsCache] },
                }),
                hostEnv: {},
            }),
        ).toThrow(SandboxExecutionError);
    });

    it("accepts only absolute or home-relative PATH entries", () => {
        for (const path of [
            "relative/bin",
            "../bin",
            "~other/bin",
            "/opt/*/bin",
            "/usr/bin:relative",
        ]) {
            expect(() =>
                validatePiSandboxConfig({ environment: { path: [path] } }),
            ).toThrow(SandboxExecutionError);
        }
    });

    it("builds a fixed Bash environment without host PATH or protected overrides", () => {
        const policy = createBashPolicy({
            cwd,
            lease,
            config: validatePiSandboxConfig({
                environment: {
                    allowedVariables: [
                        "CUSTOM",
                        "EXPLICIT",
                        "PATH",
                        "ZEROBOX_HOME",
                        "HTTP_PROXY",
                        "http_proxy",
                        "HTTPS_PROXY",
                        "https_proxy",
                        "ALL_PROXY",
                        "all_proxy",
                        "DOCKER_HOST",
                        "DOCKER_CONTEXT",
                        "DOCKER_TLS_VERIFY",
                        "DOCKER_CERT_PATH",
                    ],
                    deniedVariables: ["TERM", "CUSTOM"],
                    variables: {
                        CUSTOM: "configured",
                        PATH: "/mnt/c/evil",
                        HOME: "/tmp/evil",
                        TMPDIR: "/tmp/evil",
                        ZEROBOX_HOME: "/tmp/evil",
                        HTTP_PROXY: "http://host-proxy.invalid:3128",
                        http_proxy: "http://host-proxy.invalid:3128",
                        HTTPS_PROXY: "http://host-proxy.invalid:3128",
                        https_proxy: "http://host-proxy.invalid:3128",
                        ALL_PROXY: "http://host-proxy.invalid:3128",
                        all_proxy: "http://host-proxy.invalid:3128",
                        DOCKER_HOST: "unix:///run/user/1000/docker.sock",
                        DOCKER_CONTEXT: "remote",
                        DOCKER_TLS_VERIFY: "1",
                        DOCKER_CERT_PATH: "/target/docker-certs",
                    },
                },
            }),
            hostEnv: {
                PATH: "/mnt/c/Windows/System32",
                USER: "tester",
                TERM: "xterm-256color",
                LANG: "C.UTF-8",
                CUSTOM: "host-custom",
                EXPLICIT: "captured-host-value",
                SECRET: "must-not-pass",
            },
        });

        expect(policy.environment.set).toEqual({
            USER: "sandbox",
            SHELL: "/__zerobox/runtime/bin/bash",
            LANG: "C.UTF-8",
            EXPLICIT: "captured-host-value",
            PATH: buildBashPath(),
            HOME: SANDBOX_PRIVATE_HOME,
            XDG_CACHE_HOME: join(SANDBOX_PRIVATE_HOME, ".cache"),
            BUN_INSTALL_CACHE_DIR: join(SANDBOX_PRIVATE_HOME, ".bun/install/cache"),
            npm_config_cache: join(SANDBOX_PRIVATE_HOME, ".npm"),
            DOCKER_CONFIG: SANDBOX_PRIVATE_HOME,
            TMPDIR: "/tmp",
        });
        expect(policy.environment.inherit).toEqual(["EXPLICIT"]);
        expect(policy.environment.deny).toEqual(["TERM", "CUSTOM"]);
        expect(policy.environment.set.PATH).not.toContain("/mnt/c");
        expect(JSON.stringify(policy.environment)).not.toContain("SECRET");
        expect(JSON.stringify(policy.environment)).not.toContain("ZEROBOX_HOME");
        expect(JSON.stringify(policy.environment)).not.toContain("PROXY");
        expect(JSON.stringify(policy.environment)).not.toContain("proxy");
        expect(policy.environment.inherit.some(name => name.startsWith("DOCKER_"))).toBe(false);
        expect(policy.environment.set.DOCKER_HOST).toBeUndefined();
        expect(policy.environment.set.DOCKER_CONTEXT).toBeUndefined();
    });

    it("normalizes loopback aliases and rejects unsupported capabilities", () => {
        expect(
            validatePiSandboxConfig({
                network: {
                    allowedDomains: [
                        "127.0.0.1:8317",
                        "[::1]:8317",
                        "localhost:8317",
                    ],
                },
            }).network.allowedDomains,
        ).toEqual(["localhost:8317"]);

        for (const raw of [
            { network: { allowedDomains: ["localhost"] } },
            { network: { allowedDomains: ["10.0.0.1:443"] } },
            { network: { allowedDomains: ["8.8.8.8:443"] } },
            { network: { allowedDomains: ["[fd00::1]:443"] } },
            { network: { allowAllUnixSockets: true } },
            { filesystem: { allowWrite: ["*.pem"] } },
            { filesystem: { allowRead: ["secret?.txt"] } },
            { ignoreViolations: {} },
            { enableWeakerNestedSandbox: true },
            { enableWeakerNetworkIsolation: true },
            { allowAppleEvents: ["Finder"] },
        ]) {
            expect(() => validatePiSandboxConfig(raw)).toThrow(SandboxExecutionError);
            try {
                validatePiSandboxConfig(raw);
            } catch (error) {
                expect((error as SandboxExecutionError).code).toBe("unsupported-capability");
            }
        }
    });

    it("accepts only explicit-port host domain rules", () => {
        const config = validatePiSandboxConfig({
            network: {
                allowedHostDomains: [
                    "*.DEV.TEST:443",
                    "dashboard.dev.test:8443",
                ],
            },
        });

        expect(config.network.allowedHostDomains).toEqual([
            "*.dev.test:443",
            "dashboard.dev.test:8443",
        ]);

        for (const rule of [
            "*.dev.test",
            "*:*",
            "localhost:443",
            "127.0.0.1:443",
            "https://app.dev.test:443",
        ]) {
            expect(() =>
                validatePiSandboxConfig({
                    network: { allowedHostDomains: [rule] },
                }),
            ).toThrow(SandboxExecutionError);
        }
    });

    it("keeps distribution-only fields outside raw execution policy validation", () => {
        expect(()=>validatePiSandboxConfig({runtimeBundle:"/untrusted/bundle"})).toThrow(SandboxExecutionError);
        expect(()=>validatePiSandboxConfig({environment:{installations:{unauthorized:[{root:"/usr",path:["bin"]}]}}})).toThrow(SandboxExecutionError);
    });
});
