import { expect, test } from "bun:test";
import { inspectDockerAccess, formatDockerAccess } from "./docker-access.ts";
import { validatePiSandboxConfig } from "./runtime/policies.ts";
import { PRIVATE_BASH } from "./runtime/shell-baseline.ts";
import { SANDBOX_CAPABILITIES } from "./runtime/contracts.ts";
import type { SandboxService } from "./runtime/service.ts";

const selector = { type: "compose-service", project: "cliproxy", service: "cli-proxy-api" } as const;
const policy = { mode: "targeted", endpoint: "unix:///var/run/docker.sock", targets: [{ selector, operations: ["ps"], allowUnsafeTarget: false }] } as const;

test("Docker inspection succeeds when the runtime exposes only its private shell", async () => {
    const id = "a".repeat(64);
    const config = validatePiSandboxConfig({}, {
        mode: "targeted", endpoint: "unix:///fixture.sock",
        targets: [{ selector: { type: "container-name", name: "fixture" }, operations: ["ps"], allowUnsafeTarget: false }],
    });
    let closed = false;
    const unexpected = () => { throw new Error("Unexpected sandbox operation"); };
    const service: SandboxService = {
        probe: async () => SANDBOX_CAPABILITIES,
        startBashSession: async () => {},
        getProfileContexts: unexpected,
        prepareThinkBash: unexpected,
        prepareAnalysis: unexpected,
        prepareBash: async command => {
            if (command.file !== PRIVATE_BASH) throw new Error("The host shell is unavailable in this runtime");
            // Substitute the external runtime process while exercising the real inspection pipeline.
            return {
                file: process.execPath,
                args: ["-e", `process.stdout.write(${JSON.stringify(id + "\n")})`],
                cwd: command.cwd,
                env: {},
                statusProtocol: { fd: 3, version: 2 },
                extraStdio: [],
                supervise: () => ({ ready: Promise.resolve(), settled: Promise.resolve() }),
            };
        },
        shutdown: async () => { closed = true; },
    };
    const result = await inspectDockerAccess(process.cwd(), config, {
        request: async path => path.startsWith("/containers/json") ? [{ Id: id, Names: ["/fixture"] }] : {},
        createService: () => service,
    });

    expect(result[0].containers[0].access).toBe("accessible");
    expect(closed).toBe(true);
});

test("preserves this for injected inspection and service factory methods", async () => {
    const config = validatePiSandboxConfig({}, { mode: "targeted", endpoint: "unix:///fixture.sock", targets: [
        { selector: { type: "container-name", name: "fixture" }, operations: ["ps"], allowUnsafeTarget: false },
    ] });
    const dependencies = {
        calls: 0,
        visible: new Set(["abc"]),
        async request(path: string) {
            this.calls += 1;
            return path.startsWith("/containers/json") ? [{ Id: "abc", Names: ["/fixture"] }] : {};
        },
        async visibleIds() { this.calls += 1; return this.visible; },
    };
    expect((await inspectDockerAccess("/fixture", config, dependencies))[0]?.containers[0]?.access).toBe("accessible");
    expect(dependencies.calls).toBe(3);
    const factory = {
        calls: 0,
        request: (path: string) => dependencies.request(path),
        createService(): never {
            this.calls += 1;
            throw new Error("fixture service factory reached");
        },
    };
    await expect(inspectDockerAccess("/fixture", config, factory)).rejects.toThrow("fixture service factory reached");
    expect(factory.calls).toBe(1);
});

test("reports a matching container excluded by the broker and only displays access facts", async () => {
    const paths: string[] = [];
    const result = await inspectDockerAccess("/tmp", validatePiSandboxConfig({}, { ...policy, targets: [{ ...policy.targets[0], operations: ["ps"] }] }), {
        request: async path => {
            paths.push(path);
            return path.startsWith("/containers/json")
                ? [{ Id: "abc123", Names: ["/cliproxy"], State: "running", Labels: { "com.docker.compose.project": "cliproxy", "com.docker.compose.service": "cli-proxy-api" } }]
                : { HostConfig: {}, Config: { Env: ["SECRET=never-display"] }, Mounts: [{ Type: "bind", Source: "/host/config", Destination: "/app/config", RW: false }] };
        },
        visibleIds: async () => new Set(),
    });
    expect(result[0].containers[0]).toMatchObject({ id: "abc123", access: "excluded", mounts: [{ source: "/host/config", destination: "/app/config", writable: false }] });
    expect(formatDockerAccess(result).join("\n")).toContain("Host: /host/config → Container: /app/config (read-only)");
    expect(formatDockerAccess(result).join("\n")).toContain("Docker container cliproxy: running");
    expect(formatDockerAccess(result).join("\n")).toContain("Target access: blocked by the broker for this grant");
    expect(paths[0]).toContain("filters=");
    expect(paths[1]).toBe("/containers/abc123/json");
    expect(JSON.stringify(result)).not.toContain("SECRET");
});

test("uses the broker verdict even when inspection contains host mounts", async () => {
    const result = await inspectDockerAccess("/tmp", validatePiSandboxConfig({}, { ...policy, targets: [{ ...policy.targets[0], operations: ["ps"], allowUnsafeTarget: true }] }), {
        request: async path => path.startsWith("/containers/json")
            ? [{ Id: "abc123", Names: ["/cliproxy"], State: "running", Labels: { "com.docker.compose.project": "cliproxy", "com.docker.compose.service": "cli-proxy-api" } }]
            : { Mounts: [{ Type: "bind", Destination: "/auths", RW: true }] },
        visibleIds: async () => new Set(["abc123"]),
    });
    expect(result[0].containers[0]).toMatchObject({ access: "accessible", mounts: [{ source: "(not reported)", destination: "/auths", writable: true }] });
});

test("reports an absent exact container name without probing unrelated containers", async () => {
    const result = await inspectDockerAccess("/tmp", validatePiSandboxConfig({}, { mode: "targeted", endpoint: policy.endpoint, targets: [{ selector: { type: "container-name", name: "api" }, operations: ["ps"], allowUnsafeTarget: false }] }), {
        request: async () => [{ Id: "abc", Names: ["/api-other"], Labels: {} }],
        visibleIds: async () => { throw new Error("unrelated container was probed"); },
    });
    expect(result[0].containers).toEqual([]);
});

test.each(["engine", "broker"])("does not report a target absent when %s inspection fails", async boundary => {
    await expect(inspectDockerAccess("/tmp", validatePiSandboxConfig({}, { ...policy, targets: [{ ...policy.targets[0], operations: ["ps"] }] }), {
        request: async path => {
            if (boundary === "engine") throw new Error("fixture inspection unavailable");
            return path.startsWith("/containers/json") ? [{ Id: "abc", Names: ["/cliproxy"], Labels: { "com.docker.compose.project": "cliproxy", "com.docker.compose.service": "cli-proxy-api" } }] : {};
        },
        visibleIds: async () => { throw new Error("fixture inspection unavailable"); },
    })).rejects.toThrow("fixture inspection unavailable");
});
