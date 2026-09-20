import { describe, expect, test } from "bun:test";

import type {
    SandboxLeasePaths,
    SandboxPolicy,
} from "./policy-contracts.ts";
import {
    createSandboxExecutionContext,
    createAdmittedSandboxExecutionContext,
    formatSandboxSystemContext,
    injectSandboxSystemContext,
    parseSandboxExecutionContext,
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

describe("Sandbox execution context", () => {
    test("v3 records engine admission without presenting planned v2 rules as applied", () => {
        const report = {schema: 1 as const, runtime: {target: "x86_64-unknown-linux-gnu" as const, version: "test", manifestSha256: "a".repeat(64), component: "shell" as const}, helperSha256: "b".repeat(64),
            kernelMounts: [{ destination: "/__zerobox/runtime", root: "/bundle/shell", source: "/dev/test", filesystem: "ext4", access: "ro" as const }], mounts:[{source:"/bundle/shell",destination:"/__zerobox/runtime",access:"ro" as const,origin:"runtime" as const}],filesystem:{...policy.filesystem,allowRead:["/observed"]}, network:{...policy.network,allowLocalBinding:true}, resources:{unixSockets:[],tcpPublications:[]},path:["/__zerobox/runtime/bin"],environment:{inherit:[],set:["PATH","HOME"],deny:[]},home:{path:"/home/sandbox",namespace:"lease-private" as const},tmp:{path:"/tmp" as const,namespace:"lease-private" as const},docker:{mode:"disabled" as const}};
        const context = createAdmittedSandboxExecutionContext({report,sha256:"c".repeat(64)}, "bash-general",lease,{homeDir:"/home/test"});
        expect(context.version).toBe(3);
        expect(context.filesystem.allowRead).toEqual(["/observed"]);
        expect(context.admissionSha256).toBe("c".repeat(64));
        expect(context.mounts).toEqual(report.mounts);
        expect(parseSandboxExecutionContext(context)).toEqual(context);
        expect(parseSandboxExecutionContext({...context,admissionSha256:"invalid"})).toBeUndefined();
        expect(formatSandboxSystemContext({version:1,state:"enabled",profiles:{"bash-general":createSandboxExecutionContext(policy,lease,{homeDir:"/home/test"}),"think-strict":context,"analysis-strict":context}})).toContain("planned");
    });
    test("v3 preserves admitted path aliases through the shared context boundary", () => {
        const report = {
            schema: 1 as const,
            runtime: { target: "x86_64-unknown-linux-gnu" as const, version: "test", manifestSha256: "a".repeat(64), component: "shell" as const },
            helperSha256: "b".repeat(64),
            kernelMounts: [{ destination: "/__zerobox/runtime", root: "/bundle/shell", source: "/dev/test", filesystem: "ext4", access: "ro" as const }], mounts: [{ source: "/bundle/shell", destination: "/__zerobox/runtime", access: "ro" as const, origin: "runtime" as const }],
            pathAliases: [{ destination: "/lib", target: "/usr/lib", directory: true }],
            filesystem: policy.filesystem, network: { ...policy.network, allowLocalBinding: true },
            resources: { unixSockets: [], tcpPublications: [] }, path: ["/__zerobox/runtime/bin"],
            environment: { inherit: [], set: ["PATH", "HOME"], deny: [] },
            home: { path: "/home/sandbox", namespace: "lease-private" as const },
            tmp: { path: "/tmp" as const, namespace: "lease-private" as const }, docker: { mode: "disabled" as const },
        };
        const context = createAdmittedSandboxExecutionContext({ report, sha256: "c".repeat(64) }, "bash-general", lease, { homeDir: "/home/test" });
        expect(context.pathAliases).toEqual(report.pathAliases);
        expect(parseSandboxExecutionContext(context)).toEqual(context);
        expect(parseSandboxExecutionContext({ ...context, pathAliases: [{ destination: "/lib", target: 3, directory: true }] })).toBeUndefined();
    });
    test("reports configured resource openings and private HOME in v2", () => {
        const context = createSandboxExecutionContext({
            ...policy,
            environment: { ...policy.environment, set: { ...policy.environment.set, HOME: "/home/sandbox", PATH: "/usr/bin:/home/test/bin" } },
            resources: {
                unixSockets: ["/run/user/1000/service.sock"],
                tcpPublications: [
                    { transport: "tcp", scope: "host", listen: "127.0.0.1:8080", target: "127.0.0.1:3000" },
                    { transport: "tcp", scope: "lan", listen: "192.168.1.10:8081", target: "127.0.0.1:3001" },
                ],
            },
        }, lease, { homeDir: "/home/test" });
        expect(context.version).toBe(2);
        expect(context).toMatchObject({
            home: { path: "/home/sandbox", namespace: "lease-private" },
            environment: { path: ["/usr/bin", "~/bin"] },
            ipc: { hostUserDbus: "not-inherited", hostUnixSockets: ["/run/user/1000/service.sock"] },
            network: { loopback: { localListeners: "published", publications: [
                { transport: "tcp", scope: "host", listen: "127.0.0.1:8080", target: "127.0.0.1:3000" },
                { transport: "tcp", scope: "lan", listen: "192.168.1.10:8081", target: "127.0.0.1:3001" },
            ] } },
        });
        expect(parseSandboxExecutionContext(context)).toEqual(context);
        expect(JSON.stringify(context)).not.toContain("top-secret-value");
        expect(parseSandboxExecutionContext({ ...context, ipc: { hostUnixSockets: "*" } })).toBeUndefined();
    });
    test("is derived from the final policy with stable aliases and names only", () => {
        const context = createSandboxExecutionContext(policy, lease, {
            homeDir: "/home/test",
            nowMs: 0,
        });

        expect(context).toEqual({
            version: 2,
            home: { path: "<sandbox-home>", namespace: "lease-private" },
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
                    publications: [],
                },
            },
            tmp: { path: "/tmp", namespace: "host" },
            ipc: {
                hostUserDbus: "not-inherited",
                hostUnixSockets: [],
            },
            docker: {
                mode: "off",
                profile: "None",
                targets: [],
                hostAccessException: false,
            },
            environment: {
                path: [],
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
        expect(parseSandboxExecutionContext(context)).toEqual(context);
        const legacy = {
            ...context, version: 1,
            ipc: { hostUserDbus: "unavailable", hostUnixSockets: "unavailable" },
            network: { ...context.network, loopback: { ...context.network.loopback } },
            environment: { inherit: ["LANG", "TERM"], set: ["API_TOKEN", "HOME", "LANG"], deny: ["SSH_AUTH_SOCK"] },
        };
        Reflect.deleteProperty(legacy, "home");
        Reflect.deleteProperty(legacy.network.loopback, "publications");
        const original = structuredClone(legacy);
        expect<unknown>(parseSandboxExecutionContext(legacy)).toEqual(original);
        expect(legacy).toEqual(original);
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
