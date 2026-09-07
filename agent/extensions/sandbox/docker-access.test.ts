import { expect, test } from "bun:test";
import { inspectDockerAccess, formatDockerAccess } from "./docker-access.ts";

const selector = { type: "compose-service", project: "cliproxy", service: "cli-proxy-api" } as const;
const policy = { mode: "targeted", endpoint: "unix:///var/run/docker.sock", targets: [{ selector, operations: ["ps"], allowUnsafeTarget: false }] } as const;

test("reports a matching container excluded by the broker and only displays access facts", async () => {
    const paths: string[] = [];
    const result = await inspectDockerAccess("/tmp", { ...policy, targets: [{ ...policy.targets[0], operations: ["ps"] }] }, {
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
    const result = await inspectDockerAccess("/tmp", { ...policy, targets: [{ ...policy.targets[0], operations: ["ps"], allowUnsafeTarget: true }] }, {
        request: async path => path.startsWith("/containers/json")
            ? [{ Id: "abc123", Names: ["/cliproxy"], State: "running", Labels: { "com.docker.compose.project": "cliproxy", "com.docker.compose.service": "cli-proxy-api" } }]
            : { Mounts: [{ Type: "bind", Destination: "/auths", RW: true }] },
        visibleIds: async () => new Set(["abc123"]),
    });
    expect(result[0].containers[0]).toMatchObject({ access: "accessible", mounts: [{ source: "(not reported)", destination: "/auths", writable: true }] });
});

test("reports an absent exact container name without probing unrelated containers", async () => {
    const result = await inspectDockerAccess("/tmp", { mode: "targeted", endpoint: policy.endpoint, targets: [{ selector: { type: "container-name", name: "api" }, operations: ["ps"], allowUnsafeTarget: false }] }, {
        request: async () => [{ Id: "abc", Names: ["/api-other"], Labels: {} }],
        visibleIds: async () => { throw new Error("unrelated container was probed"); },
    });
    expect(result[0].containers).toEqual([]);
});

test.each(["engine", "broker"])("does not report a target absent when %s inspection fails", async boundary => {
    await expect(inspectDockerAccess("/tmp", { ...policy, targets: [{ ...policy.targets[0], operations: ["ps"] }] }, {
        request: async path => {
            if (boundary === "engine") throw new Error("fixture inspection unavailable");
            return path.startsWith("/containers/json") ? [{ Id: "abc", Names: ["/cliproxy"], Labels: { "com.docker.compose.project": "cliproxy", "com.docker.compose.service": "cli-proxy-api" } }] : {};
        },
        visibleIds: async () => { throw new Error("fixture inspection unavailable"); },
    })).rejects.toThrow("fixture inspection unavailable");
});
