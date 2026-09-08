import { request as httpRequest } from "node:http";
import { createBashOperations } from "../_shared/command-execution/exec.ts";
import type {
    DockerTargetSelector,
    SandboxDockerPolicy,
} from "./runtime/contracts.ts";
import { validatePiSandboxConfig } from "./runtime/policies.ts";
import { createSandboxService } from "./runtime/service.ts";
import { createZeroboxBackend } from "./runtime/zerobox-backend.ts";

/* oxlint-disable typescript/no-restricted-types -- Docker Engine responses are untrusted JSON. */

export interface DockerTargetAccess {
    selector: DockerTargetSelector;
    containers: {
        id: string;
        name: string;
        state: string;
        access: "accessible" | "excluded";
        facts: string[];
        mounts: { source: string; destination: string; writable: boolean }[];
    }[];
}

export interface DockerInspectionDependencies {
    request(path: string, endpoint: string): Promise<unknown>;
    visibleIds(
        cwd: string,
        policy: Exclude<SandboxDockerPolicy, { mode: "disabled" }>,
    ): Promise<Set<string>>;
}

export async function inspectDockerAccess(
    cwd: string,
    policy: Exclude<SandboxDockerPolicy, { mode: "disabled" }>,
    dependencies: DockerInspectionDependencies = {
        request: requestEngine,
        visibleIds: probeVisibleIds,
    },
): Promise<DockerTargetAccess[]> {
    if (policy.mode !== "targeted") return [];
    const targets: DockerTargetAccess[] = [];
    for (const target of policy.targets) {
        const { selector } = target;
        const filters =
            selector.type === "compose-service"
                ? {
                      label: [
                          `com.docker.compose.project=${selector.project}`,
                          `com.docker.compose.service=${selector.service}`,
                      ],
                  }
                : selector.type === "container-name"
                  ? { name: [selector.name] }
                  : { id: [selector.id] };
        // oxlint-disable-next-line no-await-in-loop -- bound concurrent Docker requests; a selector may match many replicas.
        const response = await dependencies.request(
            `/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify(filters))}`,
            policy.endpoint,
        );
        if (!Array.isArray(response))
            throw new Error("Docker container list is invalid");
        const containers: DockerTargetAccess["containers"] = [];
        for (const value of response) {
            const summary = object(value);
            const names = strings(summary.Names).map((name) =>
                name.replace(/^\//, ""),
            );
            const labels = object(summary.Labels ?? {});
            const matches =
                selector.type === "container-name"
                    ? names.includes(selector.name)
                    : selector.type === "compose-service"
                      ? labels["com.docker.compose.project"] ===
                            selector.project &&
                        labels["com.docker.compose.service"] ===
                            selector.service
                      : summary.Id === selector.id;
            if (!matches) continue;
            if (
                typeof summary.Id !== "string" ||
                !/^[a-f0-9]+$/.test(summary.Id)
            )
                throw new Error("Docker container ID is invalid");
            const inspect = object(
                // oxlint-disable-next-line no-await-in-loop -- inspect matching containers sequentially to avoid flooding the local Engine.
                await dependencies.request(
                    `/containers/${summary.Id}/json`,
                    policy.endpoint,
                ),
            );
            containers.push({
                id: summary.Id,
                name: names[0] ?? summary.Id,
                state:
                    typeof summary.State === "string"
                        ? summary.State
                        : "unknown",
                access: "excluded",
                facts: describeAccessFacts(inspect),
                mounts: Array.isArray(inspect.Mounts)
                    ? inspect.Mounts.map(object)
                          .filter((mount) => mount.Type === "bind")
                          .map((mount) => ({
                              source:
                                  typeof mount.Source === "string"
                                      ? mount.Source
                                      : "(not reported)",
                              destination:
                                  typeof mount.Destination === "string"
                                      ? mount.Destination
                                      : "(not reported)",
                              writable: mount.RW === true,
                          }))
                    : [],
            });
        }
        targets.push({ selector, containers });
    }
    if (targets.some((target) => target.containers.length > 0)) {
        // Ask the real broker. The UI never duplicates its authorization rules.
        const visible = await dependencies.visibleIds(cwd, policy);
        for (const target of targets)
            for (const container of target.containers) {
                container.access = visible.has(container.id)
                    ? "accessible"
                    : "excluded";
            }
    }
    return targets;
}

function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Docker inspection is invalid");
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- checked object, its fields remain untrusted.
    return value as Record<string, unknown>;
}

function strings(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
}

// These are explanations only. Eligibility comes exclusively from the broker.
function describeAccessFacts(inspect: Record<string, unknown>): string[] {
    const facts: string[] = [];
    const host = object(inspect.HostConfig ?? {});
    if (host.Privileged === true) facts.push("Privileged container");
    for (const key of [
        "PidMode",
        "IpcMode",
        "NetworkMode",
        "UTSMode",
        "UsernsMode",
        "CgroupnsMode",
    ]) {
        const value = host[key];
        if (typeof value === "string" && /^(host$|container:)/i.test(value))
            facts.push(`${key}: ${value}`);
    }
    for (const key of ["Devices", "DeviceRequests"]) {
        if (Array.isArray(host[key]) && host[key].length)
            facts.push(`Host ${key}: ${host[key].length}`);
    }
    for (const key of ["CapAdd", "SecurityOpt"]) {
        const values = strings(host[key]);
        if (values.length) facts.push(`${key}: ${values.join(", ")}`);
    }
    if (Array.isArray(inspect.Mounts))
        for (const value of inspect.Mounts) {
            const mount = object(value);
            if (
                mount.Type !== "bind" &&
                typeof mount.Destination === "string" &&
                /(?:docker|podman|containerd)\.sock$/i.test(mount.Destination)
            )
                facts.push(`Runtime socket mount: ${mount.Destination}`);
        }
    return facts;
}

function requestEngine(path: string, endpoint: string): Promise<unknown> {
    if (!endpoint.startsWith("unix:///"))
        throw new Error("Docker inspection requires a local Unix endpoint");
    return new Promise((resolve, reject) => {
        const request = httpRequest(
            {
                socketPath: endpoint.slice("unix://".length),
                path,
                method: "GET",
            },
            (response) => {
                const chunks: Buffer[] = [];
                let size = 0;
                response.on("data", (chunk: Buffer) => {
                    size += chunk.length;
                    if (size > 8 * 1024 * 1024)
                        request.destroy(
                            new Error(
                                "Docker inspection exceeds its output limit",
                            ),
                        );
                    else chunks.push(chunk);
                });
                response.on("error", reject);
                response.on("end", () => {
                    if (response.statusCode !== 200) {
                        reject(
                            new Error(
                                `Docker inspection failed (HTTP ${response.statusCode})`,
                            ),
                        );
                        return;
                    }
                    try {
                        resolve(
                            JSON.parse(Buffer.concat(chunks).toString("utf8")),
                        );
                    } catch {
                        reject(
                            new Error(
                                "Docker inspection returned invalid JSON",
                            ),
                        );
                    }
                });
            },
        );
        const timer = setTimeout(
            () => request.destroy(new Error("Docker inspection timed out")),
            5000,
        );
        request.on("close", () => clearTimeout(timer));
        request.on("error", (error) =>
            reject(
                new Error(`Docker inspection unavailable: ${error.message}`),
            ),
        );
        request.end();
    });
}

async function probeVisibleIds(
    cwd: string,
    policy: Exclude<SandboxDockerPolicy, { mode: "disabled" }>,
): Promise<Set<string>> {
    // A temporary read-only diagnostic grant tests target eligibility, even when
    // the real grant intentionally omits ps. No authority file is changed.
    const diagnosticPolicy =
        policy.mode === "targeted"
            ? {
                  ...policy,
                  targets: policy.targets.map((target) => ({
                      ...target,
                      operations: ["ps" as const],
                  })),
              }
            : policy;
    const service = createSandboxService({
        backend: createZeroboxBackend(),
        config: validatePiSandboxConfig({}, diagnosticPolicy),
    });
    try {
        await service.startBashSession(cwd);
        const operations = createBashOperations({
            detached: true,
            prepareSpawn: ({ command, cwd: commandCwd }) =>
                service.prepareBash({
                    file: "/bin/bash",
                    args: ["-c", command],
                    cwd: commandCwd,
                }),
        });
        let output = "";
        const result = await operations.exec(
            "docker ps -a --no-trunc --format '{{.ID}}'",
            cwd,
            {
                timeout: 15,
                onData: (chunk) => {
                    output += chunk.toString();
                },
            },
        );
        if (result.exitCode !== 0)
            throw new Error(
                "Docker broker inspection failed; check Sandbox runtime and Docker CLI availability",
            );
        const ids = output
            .split(/\r?\n/)
            .filter((line) => /^[a-f0-9]{64}$/.test(line));
        return new Set(ids);
    } finally {
        await service.shutdown();
    }
}

export function formatDockerAccess(targets: DockerTargetAccess[]): string[] {
    return targets.flatMap((target) => {
        const selector =
            target.selector.type === "compose-service"
                ? `${target.selector.project} / ${target.selector.service}`
                : target.selector.type === "container-name"
                  ? target.selector.name
                  : target.selector.id;
        return target.containers.length === 0
            ? [`Docker target ${selector}: absent`]
            : target.containers.flatMap((container) => [
                  `Docker container ${container.name}: ${container.state}`,
                  `  Target access: ${container.access === "excluded" ? "blocked by the broker for this grant" : "eligible for this grant (operation execution not tested)"}`,
                  ...container.facts.map((fact) => `  ${fact}`),
                  ...container.mounts.map(
                      (mount) =>
                          `  Host: ${mount.source} → Container: ${mount.destination} (${mount.writable ? "read-write" : "read-only"})`,
                  ),
                  ...(container.access === "excluded"
                      ? [
                            "  Review the reported host access and confirm a target exception with /sandbox docker grant to authorize this target.",
                        ]
                      : []),
              ]);
    });
}
