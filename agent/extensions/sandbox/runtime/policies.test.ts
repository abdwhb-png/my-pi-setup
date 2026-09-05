import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { SandboxExecutionError } from "./contracts.ts";
import {
    BASH_SAFE_PATH_SEGMENTS,
    buildBashPath,
    createAnalysisPolicy,
    createBashPolicy,
    isNetworkDestinationAllowed,
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
        expect(analysis.name).toBe("analysis-strict");
        expect(bash.strict).toBe(true);
        expect(analysis.strict).toBe(true);
        expect(bash.network.mode).toBe("domain-allowlist");
        expect(analysis.network).toEqual({
            mode: "deny-all",
            allow: [],
            deny: [],
        });
        expect(bash.filesystem.allowWrite).toContain(cwd);
        expect(bash.filesystem.allowWrite).toContain(lease.homeDir);
        expect(bash.filesystem.allowWrite).toContain(lease.tmpDir);
        expect(bash.filesystem.allowRead).toContain(lease.proxyRunsDir);
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

    it("rejects configured allows that override a more specific deny", () => {
        for (const filesystem of [
            { allowRead: ["/proc/1/root/etc/hostname"] },
            { allowWrite: ["/tmp/nested"] },
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

    it("builds a fixed Bash environment without host PATH or protected overrides", () => {
        expect(BASH_SAFE_PATH_SEGMENTS).toEqual([
            "~/.pi/bin",
            "~/.bun/bin",
            "~/miniconda3/condabin",
            "~/.local/share/pnpm",
            "~/.cargo/bin",
            "~/.local/bin",
            "~/.config/herd-lite/bin",
            "/home/linuxbrew/.linuxbrew/bin",
            "/home/linuxbrew/.linuxbrew/sbin",
            "/usr/local/go/bin",
            "/usr/local/bin",
            "/usr/local/sbin",
            "/usr/bin",
            "/usr/sbin",
            "/bin",
            "/sbin",
        ]);
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
            USER: "tester",
            LANG: "C.UTF-8",
            EXPLICIT: "captured-host-value",
            PATH: buildBashPath(),
            HOME: lease.homeDir,
            TMPDIR: lease.tmpDir,
        });
        expect(policy.environment.inherit).toEqual([
            "USER",
            "SHELL",
            "LANG",
            "COLORTERM",
            "NO_COLOR",
            "EXPLICIT",
        ]);
        expect(policy.environment.deny).toEqual(["TERM", "CUSTOM"]);
        expect(policy.environment.set.PATH).not.toContain("/mnt/c");
        expect(JSON.stringify(policy.environment)).not.toContain("SECRET");
        expect(JSON.stringify(policy.environment)).not.toContain("ZEROBOX_HOME");
        expect(JSON.stringify(policy.environment)).not.toContain("PROXY");
        expect(JSON.stringify(policy.environment)).not.toContain("proxy");
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
            { network: { allowLocalBinding: true } },
            { network: { allowAllUnixSockets: true } },
            { filesystem: { denyWrite: ["*.pem"] } },
            { filesystem: { denyRead: ["secret?.txt"] } },
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

    it("keeps the checked-in active config inside the v1 capability gate", async () => {
        const raw = JSON.parse(
            await readFile(join(import.meta.dir, "../../../sandbox.json"), "utf8"),
        );
        const config = validatePiSandboxConfig(raw);
        expect(config.enabled).toBe(true);
        expect(config.filesystem.allowWrite).not.toContain("/tmp");
        expect(config.filesystem.denyWrite).toEqual([".env"]);
        expect(config.network.allowedDomains).toEqual([
            "github.com",
            "*.github.com",
            "localhost:8317",
            "localhost:8320",
        ]);
    });
});
