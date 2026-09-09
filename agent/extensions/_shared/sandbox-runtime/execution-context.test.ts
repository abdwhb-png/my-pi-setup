import { describe, expect, test } from "bun:test";

import type {
    SandboxLeasePaths,
    SandboxPolicy,
} from "../../sandbox/runtime/contracts.ts";
import {
    createSandboxExecutionContext,
    formatSandboxSystemContext,
    injectSandboxSystemContext,
    type SandboxModelContextSnapshotV1,
} from "./execution-context.ts";

const lease: SandboxLeasePaths = {
    root: "/run/user/1000/pi-sandbox-random/lease-random",
    homeDir: "/run/user/1000/pi-sandbox-random/lease-random/home",
    tmpDir: "/run/user/1000/pi-sandbox-random/lease-random/tmp",
    zeroboxHome: "/run/user/1000/pi-sandbox-random/lease-random/home/.zerobox",
    proxyRunsDir:
        "/run/user/1000/pi-sandbox-random/lease-random/proxy-runs",
    profilesDir: "/run/user/1000/pi-sandbox-random/lease-random/profiles",
};

const policy: SandboxPolicy = {
    name: "bash-general",
    strict: true,
    tmpNamespace: "host",
    filesystem: {
        allowRead: ["/workspace", lease.homeDir, lease.proxyRunsDir],
        denyRead: ["/run/user/1000/pi-sandbox-random", "/home/test/.ssh"],
        denyReadGlobs: ["/workspace/**/*.pem"],
        allowWrite: ["/workspace", lease.tmpDir],
        denyWrite: ["/workspace/.env"],
        denyWriteGlobs: ["/workspace/**/.env.*"],
    },
    network: {
        mode: "domain-allowlist",
        allow: ["github.com", "localhost:18740"],
        allowHost: ["*.dev.test:443"],
        deny: ["blocked.test"],
        allowLocalBinding: true,
    },
    environment: {
        inherit: ["LANG", "TERM"],
        set: {
            LANG: "secret-locale-value",
            API_TOKEN: "top-secret-value",
            HOME: lease.homeDir,
        },
        deny: ["SSH_AUTH_SOCK"],
    },
    docker: { mode: "disabled" },
};

describe("SandboxExecutionContextV1", () => {
    test("is derived from the final policy with stable aliases and names only", () => {
        const context = createSandboxExecutionContext(policy, lease, {
            homeDir: "/home/test",
            nowMs: 0,
        });

        expect(context).toEqual({
            version: 1,
            profile: "bash-general",
            filesystem: {
                allowRead: [
                    "/workspace",
                    "<sandbox-home>",
                    "<sandbox-proxy-runs>",
                ],
                denyRead: ["<sandbox-runtime>", "~/.ssh"],
                denyReadGlobs: ["/workspace/**/*.pem"],
                allowWrite: ["/workspace", "<sandbox-tmp>"],
                denyWrite: ["/workspace/.env"],
                denyWriteGlobs: ["/workspace/**/.env.*"],
            },
            network: {
                mode: "domain-allowlist",
                allow: ["github.com", "localhost:18740"],
                allowHost: ["*.dev.test:443"],
                deny: ["blocked.test"],
                domainClientProxyRequired: true,
                loopback: {
                    hostNamespace: "isolated",
                    hostBridgePorts: [18740],
                    hostBridgeTransport: "managed-policy-proxy",
                    unlistedHostPorts: "blocked",
                    localListeners: "sandbox-only",
                },
            },
            tmp: { path: "/tmp", namespace: "host" },
            ipc: {
                hostUserDbus: "unavailable",
                hostUnixSockets: "unavailable",
            },
            docker: {
                mode: "off",
                profile: "None",
                targets: [],
                hostAccessException: false,
            },
            environment: {
                inherit: ["LANG", "TERM"],
                set: ["API_TOKEN", "HOME", "LANG"],
                deny: ["SSH_AUTH_SOCK"],
            },
        });
        const serialized = JSON.stringify(context);
        expect(serialized).not.toContain("secret-locale-value");
        expect(serialized).not.toContain("top-secret-value");
        expect(serialized).not.toContain("pi-sandbox-random");
        expect(serialized).not.toContain("lease-random");
    });

    test("formats compact facts and injects one idempotent section", () => {
        const context = createSandboxExecutionContext(policy, lease, {
            homeDir: "/home/test",
            nowMs: 0,
        });
        const snapshot: SandboxModelContextSnapshotV1 = {
            version: 1,
            state: "enabled",
            profiles: {
                "bash-general": context,
                "think-strict": {
                    ...context,
                    profile: "think-strict",
                    tmp: { path: "/tmp", namespace: "lease-private" },
                },
                "analysis-strict": {
                    ...context,
                    profile: "analysis-strict",
                    network: {
                        ...context.network,
                        mode: "deny-all",
                        allow: [],
                        allowHost: [],
                        domainClientProxyRequired: false,
                        loopback: {
                            ...context.network.loopback,
                            hostBridgePorts: [],
                            hostBridgeTransport: "disabled",
                        },
                    },
                    tmp: { path: "/tmp", namespace: "lease-private" },
                },
            },
        };
        const section = formatSandboxSystemContext(snapshot);
        const once = injectSandboxSystemContext("base prompt", snapshot);
        const twice = injectSandboxSystemContext(once, snapshot);

        expect(section).toContain("Sandbox execution context v1");
        expect(section).toContain('"state":"enabled"');
        expect(section).toContain('"analysis-strict"');
        expect(section).toContain("facts, not a causal diagnosis");
        expect(section).toContain(
            "loopback.hostBridgePorts accept raw TCP only through the managed policy proxy",
        );
        expect(section).toContain("unlisted host loopback ports are blocked");
        expect(twice).toBe(once);
        expect(twice.match(/Sandbox execution context v1/g)).toHaveLength(1);
    });

    test("states that disabled removes OS isolation but not safe_bash guards", () => {
        const section = formatSandboxSystemContext({
            version: 1,
            state: "disabled",
        });

        expect(section).toContain("OS isolation is absent");
        expect(section).toContain("safe_bash guards are independent");
    });
});
