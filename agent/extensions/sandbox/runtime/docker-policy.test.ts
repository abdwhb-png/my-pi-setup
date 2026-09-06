import { afterEach, describe, expect, it } from "bun:test";
import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    SandboxExecutionError,
    type DockerTargetGrant,
} from "./contracts.ts";
import {
    dockerPolicyHasUnsafeTargets,
    expandDockerProjectRoot,
    resolveDockerPolicy,
} from "./docker-policy.ts";

const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) {
        rmSync(root, { force: true, recursive: true });
    }
});

function fixture() {
    const root = mkdtempSync(join(tmpdir(), "pi-docker-policy-"));
    roots.push(root);
    const agentDir = join(root, "agent");
    const projectRoot = join(root, "project");
    mkdirSync(agentDir, { mode: 0o700 });
    mkdirSync(projectRoot);
    const globalConfigPath = join(agentDir, "sandbox.global.json");
    const writeGlobal = (value: unknown, mode = 0o600) => {
        writeFileSync(globalConfigPath, `${JSON.stringify(value)}\n`, {
            mode,
        });
        chmodSync(globalConfigPath, mode);
    };
    const resolve = (projectOverride?: unknown) =>
        resolveDockerPolicy({
            cwd: projectRoot,
            globalConfigPath,
            projectOverride,
        });
    return { root, agentDir, projectRoot, globalConfigPath, writeGlobal, resolve };
}

const composeTarget: DockerTargetGrant = {
    selector: {
        type: "compose-service",
        project: "app",
        service: "api",
    },
    operations: ["logs", "inspect"],
    allowUnsafeTarget: true,
};

describe("global Docker authority", () => {
    it("defaults to disabled when the global grant file is absent", () => {
        const { resolve } = fixture();

        expect(resolve()).toEqual({ mode: "disabled" });
    });

    it("activates only the grant whose canonical project root matches exactly", () => {
        const { projectRoot, root, writeGlobal, resolve } = fixture();
        const other = join(root, "other");
        mkdirSync(other);
        writeGlobal({
            docker: {
                grants: [
                    { projectRoot: other, mode: "full" },
                    {
                        projectRoot,
                        mode: "targeted",
                        targets: [composeTarget],
                    },
                ],
            },
        });

        expect(resolve()).toEqual({
            mode: "targeted",
            endpoint: "unix:///var/run/docker.sock",
            targets: [composeTarget],
        });
        expect(dockerPolicyHasUnsafeTargets(resolve())).toBe(true);
    });

    it("does not let a child directory inherit a parent project grant", () => {
        const { projectRoot, writeGlobal, globalConfigPath } = fixture();
        const child = join(projectRoot, "child");
        mkdirSync(child);
        writeGlobal({
            docker: { grants: [{ projectRoot, mode: "full" }] },
        });

        expect(resolveDockerPolicy({ cwd: child, globalConfigPath })).toEqual({
            mode: "disabled",
        });
    });

    it("rejects project roots that are still relative after home expansion", () => {
        const { root, projectRoot, globalConfigPath, writeGlobal } = fixture();
        mkdirSync(join(root, "relative"));
        writeGlobal({
            docker: {
                grants: [{ projectRoot: "relative", mode: "full" }],
            },
        });

        expect(() =>
            resolveDockerPolicy({
                cwd: projectRoot,
                globalConfigPath,
                homeDir: root,
            }),
        ).toThrow(SandboxExecutionError);
    });

    it("rejects duplicate roots, unknown fields, symlinks, and writable authority files", () => {
        const { projectRoot, globalConfigPath, writeGlobal, resolve, agentDir } =
            fixture();
        for (const value of [
            {
                docker: {
                    grants: [
                        { projectRoot, mode: "full" },
                        { projectRoot: `${projectRoot}/.`, mode: "targeted", targets: [] },
                    ],
                },
            },
            {
                docker: {
                    grants: [{ projectRoot, mode: "full", surprise: true }],
                },
            },
            { docker: { grants: [], surprise: true } },
        ]) {
            writeGlobal(value);
            expect(resolve).toThrow(SandboxExecutionError);
        }

        writeGlobal({ docker: { grants: [] } }, 0o622);
        expect(resolve).toThrow(SandboxExecutionError);

        rmSync(globalConfigPath);
        const target = join(agentDir, "authority-target.json");
        writeFileSync(target, '{"docker":{"grants":[]}}\n', { mode: 0o600 });
        symlinkSync(target, globalConfigPath);
        expect(resolve).toThrow(SandboxExecutionError);
    });
});

describe("project Docker narrowing", () => {
    it("can disable or reduce a targeted grant", () => {
        const { projectRoot, writeGlobal, resolve } = fixture();
        writeGlobal({
            docker: {
                grants: [
                    {
                        projectRoot,
                        mode: "targeted",
                        endpoint: "unix:///run/user/1000/docker.sock",
                        targets: [
                            composeTarget,
                            {
                                selector: { type: "container-name", name: "worker" },
                                operations: ["logs"],
                                allowUnsafeTarget: false,
                            },
                        ],
                    },
                ],
            },
        });

        expect(resolve({ mode: "disabled" })).toEqual({ mode: "disabled" });
        expect(
            resolve({
                mode: "targeted",
                targets: [
                    {
                        selector: composeTarget.selector,
                        operations: ["inspect"],
                        allowUnsafeTarget: false,
                    },
                ],
            }),
        ).toEqual({
            mode: "targeted",
            endpoint: "unix:///run/user/1000/docker.sock",
            targets: [
                {
                    selector: composeTarget.selector,
                    operations: ["inspect"],
                    allowUnsafeTarget: false,
                },
            ],
        });
    });

    it("can reduce full access to targeted access without granting unsafe targets", () => {
        const { projectRoot, writeGlobal, resolve } = fixture();
        writeGlobal({
            docker: { grants: [{ projectRoot, mode: "full" }] },
        });

        expect(
            resolve({
                mode: "targeted",
                targets: [
                    {
                        selector: { type: "container-name", name: "api" },
                        operations: ["logs"],
                        allowUnsafeTarget: false,
                    },
                ],
            }),
        ).toEqual({
            mode: "targeted",
            endpoint: "unix:///var/run/docker.sock",
            targets: [
                {
                    selector: { type: "container-name", name: "api" },
                    operations: ["logs"],
                    allowUnsafeTarget: false,
                },
            ],
        });
    });

    it("fails closed on every project escalation attempt", () => {
        const { projectRoot, writeGlobal, resolve } = fixture();
        writeGlobal({
            docker: {
                grants: [
                    {
                        projectRoot,
                        mode: "targeted",
                        targets: [composeTarget],
                    },
                ],
            },
        });

        for (const override of [
            { mode: "full" },
            {
                mode: "targeted",
                endpoint: "unix:///var/run/docker.sock",
                targets: [],
            },
            {
                mode: "targeted",
                targets: [
                    { selector: composeTarget.selector, operations: ["start"] },
                ],
            },
            {
                mode: "targeted",
                targets: [
                    {
                        selector: { type: "container-name", name: "new" },
                        operations: ["logs"],
                    },
                ],
            },
        ]) {
            expect(() => resolve(override)).toThrow(SandboxExecutionError);
        }
    });

    it("cannot introduce an unsafe exception while narrowing a full grant", () => {
        const { projectRoot, writeGlobal, resolve } = fixture();
        writeGlobal({
            docker: { grants: [{ projectRoot, mode: "full" }] },
        });

        expect(() =>
            resolve({
                mode: "targeted",
                targets: [
                    {
                        selector: { type: "container-name", name: "api" },
                        allowUnsafeTarget: true,
                    },
                ],
            }),
        ).toThrow(SandboxExecutionError);
    });
});

it("expands only the leading home token in global project roots", () => {
    expect(expandDockerProjectRoot("~/projects/app", "/users/me")).toBe(
        "/users/me/projects/app",
    );
    expect(expandDockerProjectRoot("~other/app", "/users/me")).toBe(
        "~other/app",
    );
});
