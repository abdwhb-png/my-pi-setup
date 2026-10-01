import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarizeDockerAccess } from "../../_shared/sandbox-runtime/docker-summary.ts";
import type { SandboxExecutionContextV3 } from "../../_shared/sandbox-runtime/execution-context.ts";
import type { SandboxDashboardSnapshot } from "../command-ui.ts";
import { inspectSandboxDoctor } from "../doctor.ts";
import { loadSandboxConfig } from "../index.ts";

const unavailable = () => {
    throw new Error("Renderer fixture must not execute a command");
};

/** Isolated policy and external engine receipt for renderer tests and previews. */
export function dashboardFixture() {
    const root = mkdtempSync(join(tmpdir(), "sandbox-dashboard-"));
    try {
        const cwd = join(root, "example-project");
        const agentDir = join(root, "agent");
        mkdirSync(cwd);
        mkdirSync(agentDir);
        writeFileSync(
            join(agentDir, "sandbox.json"),
            JSON.stringify({
                version: 2,
                machineId: "fixture",
                host: { allowed: true },
                filesystem: {
                    allowRead: Array.from({ length: 30 }, (_, index) =>
                        join(cwd, `grant-${index}`),
                    ),
                },
                environment: {
                    variables: { FIXTURE_SECRET: "NEVER_DISPLAY_SECRET" },
                },
            }),
            { mode: 0o600 },
        );
        const resolved = loadSandboxConfig(cwd, {
            agentDir,
            machineId: "fixture",
        });
        const docker = summarizeDockerAccess(resolved.config.docker);
        const receipt: SandboxExecutionContextV3 = {
            version: 3,
            profile: "bash-general",
            admission: "admitted",
            admissionSha256: "a".repeat(64),
            helperSha256: "b".repeat(64),
            runtime: {
                target: "x86_64-unknown-linux-gnu",
                version: "fixture",
                manifestSha256: "c".repeat(64),
                component: "shell",
            },
            filesystem: {
                allowRead: resolved.config.filesystem.allowRead,
                allowWrite: resolved.config.filesystem.allowWrite,
                denyRead: [],
                denyWrite: [],
                denyReadGlobs: [],
                denyWriteGlobs: [],
            },
            network: {
                mode: "deny-all",
                allow: [],
                allowHost: [],
                deny: [],
                domainClientProxyRequired: false,
                loopback: {
                    hostNamespace: "isolated",
                    hostBridgePorts: [],
                    hostBridgeTransport: "disabled",
                    unlistedHostPorts: "blocked",
                    localListeners: "sandbox-only",
                    publications: [],
                },
            },
            home: { path: "/home/sandbox", namespace: "lease-private" },
            tmp: { path: "/tmp", namespace: "lease-private" },
            ipc: { hostUserDbus: "not-inherited", hostUnixSockets: [] },
            environment: {
                inherit: [],
                set: ["HOME"],
                deny: [],
                path: ["/__zerobox/runtime/bin"],
            },
            mounts: [],
            kernelMounts: [],
            docker,
        };
        const snapshot: SandboxDashboardSnapshot = {
            resolved,
            runtime: {
                state: "enabled",
                sandboxFingerprint: resolved.shell.sandboxFingerprint,
                dockerAccess: docker,
                contexts: {
                    "bash-general": receipt,
                    "think-strict": { ...receipt, profile: "think-strict" },
                    "analysis-strict": {
                        ...receipt,
                        profile: "analysis-strict",
                    },
                },
                createBashOperations: unavailable,
                createThinkBashOperations: unavailable,
                analysis: { state: "ready" },
            },
        };
        return {
            root,
            snapshot,
            report: inspectSandboxDoctor(resolved, undefined, receipt),
        };
    } catch (error) {
        rmSync(root, { recursive: true, force: true });
        throw error;
    }
}
