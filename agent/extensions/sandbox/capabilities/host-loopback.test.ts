import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import {
    createSandboxExecutionContext,
    parseSandboxExecutionContext,
} from "../../_shared/sandbox-runtime/execution-context.ts";
import { loadSandboxConfig } from "../index.ts";
import { validatePiSandboxConfig } from "../runtime/policies.ts";
import { resolveShellPolicy } from "./policy.ts";
import { sandboxAccessRemoved } from "./revocation.ts";

const roots: string[] = [];
afterEach(() =>
    roots
        .splice(0)
        .forEach((root) => rmSync(root, { recursive: true, force: true })),
);
function fixture(allowed?: boolean) {
    const root = mkdtempSync(join(tmpdir(), "pi-host-loopback-"));
    roots.push(root);
    const agentDir = join(root, "agent"),
        cwd = join(root, "project");
    mkdirSync(join(agentDir, "config"), { recursive: true });
    mkdirSync(join(cwd, ".pi/config"), { recursive: true });
    const authorityPath = join(agentDir, "config/sandbox.json");
    const global = {
        version: 2,
        machineId: "fixture",
        network: allowed === undefined ? {} : { hostLoopback: { allowed } },
    };
    writeFileSync(authorityPath, JSON.stringify(global), { mode: 0o600 });
    new ProjectTrustStore(agentDir).set(cwd, true);
    return {
        cwd,
        agentDir,
        authorityPath,
        global,
        load: () => loadSandboxConfig(cwd, { agentDir, machineId: "fixture" }),
    };
}
test("global host loopback permission is explicit, inherited and revocable", () => {
    const off = fixture();
    expect(off.load().config.network.hostLoopback).not.toBe(true);
    const on = fixture(true);
    const enabled = on.load().config;
    expect(enabled.network.hostLoopback).toBe(true);
    expect(enabled.network.allowedDomains).toEqual([]);
    expect(
        sandboxAccessRemoved(enabled, {
            ...enabled,
            network: { ...enabled.network, hostLoopback: false },
        }),
    ).toBe(true);
});
test.each([true, false])(
    "projects and sessions reject host loopback declaration %s",
    (allowed) => {
        const f = fixture(true);
        writeFileSync(
            join(f.cwd, ".pi/config/sandbox.json"),
            JSON.stringify({ network: { hostLoopback: { allowed } } }),
        );
        expect(f.load).toThrow("hostLoopback");
        expect(() =>
            resolveShellPolicy({
                cwd: f.cwd,
                authorityPath: f.authorityPath,
                global: f.global,
                session: { network: { hostLoopback: { allowed } } },
                baseline: validatePiSandboxConfig({}),
            }),
        ).toThrow("hostLoopback");
    },
);

test("host alias grants arbitrary ports without external egress and explicit denials revoke access", async () => {
    const { createBashPolicy, isNetworkDestinationAllowed } =
        await import("../runtime/policies.ts");
    const f = fixture(true);
    const config = f.load().config;
    const base = join(f.cwd, "..", "leases", "lease");
    const lease = {
        root: base,
        homeDir: join(base, "home"),
        tmpDir: join(base, "tmp"),
        proxyRunsDir: join(base, "proxy"),
        zeroboxHome: join(base, "zerobox"),
        profilesDir: join(base, "profiles"),
    };
    const policy = createBashPolicy({ cwd: f.cwd, config, lease });
    const context = createSandboxExecutionContext(policy, lease, {
        homeDir: join(f.cwd, ".."),
    });
    expect(context.network.hostLoopback).toBe(true);
    expect(
        parseSandboxExecutionContext(JSON.parse(JSON.stringify(context))),
    ).toEqual(context);
    expect(
        parseSandboxExecutionContext({
            ...context,
            network: { ...context.network, hostLoopback: "true" },
        }),
    ).toBeUndefined();
    for (const port of [1, 3216, 5173, 65000, 65535])
        expect(
            isNetworkDestinationAllowed(policy.network, "host.localhost", port),
        ).toBe(true);
    expect(
        isNetworkDestinationAllowed(policy.network, "example.org", 443),
    ).toBe(false);
    expect(
        isNetworkDestinationAllowed(policy.network, "HOST.LOCALHOST", 3216),
    ).toBe(true);
    for (const port of [0, 65536])
        expect(
            isNetworkDestinationAllowed(policy.network, "host.localhost", port),
        ).toBe(false);
    const restricted = {
        ...config,
        network: { ...config.network, deniedDomains: ["localhost:3216"] },
    };
    expect(sandboxAccessRemoved(config, restricted)).toBe(true);
    const denied = createBashPolicy({ cwd: f.cwd, config: restricted, lease });
    expect(
        isNetworkDestinationAllowed(denied.network, "host.localhost", 3216),
    ).toBe(false);
    expect(
        isNetworkDestinationAllowed(denied.network, "host.localhost", 5173),
    ).toBe(true);
});

test("runtime defaults cannot enable host loopback without global authorization", () => {
    const f = fixture();
    const baseline = validatePiSandboxConfig({
        network: { hostLoopback: true },
    });
    expect(
        resolveShellPolicy({
            cwd: f.cwd,
            authorityPath: f.authorityPath,
            global: f.global,
            baseline,
        }).config.network.hostLoopback,
    ).not.toBe(true);
});

test.each([
    true,
    {},
    { allowed: "true" },
    { enabled: true },
    { allowed: true, ports: [3216] },
])("rejects malformed global host loopback declaration %j", (hostLoopback) => {
    const f = fixture();
    writeFileSync(
        f.authorityPath,
        JSON.stringify({ ...f.global, network: { hostLoopback } }),
        { mode: 0o600 },
    );
    expect(f.load).toThrow("hostLoopback");
});
