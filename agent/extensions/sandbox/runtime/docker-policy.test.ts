import { expect, test } from "bun:test";
import { resolveDockerPolicy } from "./docker-policy.ts";
test("projects choose independent Docker targets without a global target registry", () => {
    for (const name of ["project-a", "project-b"]) {
        expect(resolveDockerPolicy({
            globalConfig: { allowed: true },
            projectConfig: {
                enabled: true,
                targets: [{ selector: { type: "container-name", name }, operations: ["logs"] }],
            },
        })).toEqual({
            mode: "targeted",
            endpoint: "unix:///var/run/docker.sock",
            targets: [{ selector: { type: "container-name", name }, operations: ["logs"], allowUnsafeTarget: false }],
        });
    }
});
const global = { allowed: true, mode: "targeted", operations: ["logs", "inspect"] };
test("only exact globally declared unsafe exceptions decorate project-selected targets", () => {
    const privileged = { type: "compose-service", project: "fixture", service: "api" };
    const ordinary = { type: "container-name", name: "ordinary" };
    const ceiling = { allowed: true, unsafeTargets: [privileged] };
    const project = { enabled: true, targets: [{ selector: privileged, operations: ["inspect"] }, { selector: ordinary, operations: ["logs"] }] };
    expect(resolveDockerPolicy({ globalConfig: ceiling, projectConfig: project })).toMatchObject({
        targets: [{ selector: privileged, allowUnsafeTarget: true }, { selector: ordinary, allowUnsafeTarget: false }],
    });
    expect(resolveDockerPolicy({ globalConfig: ceiling, projectConfig: { enabled: true } })).toMatchObject({ mode: "targeted", targets: [] });
    expect(resolveDockerPolicy({ globalConfig: { allowed: true }, projectConfig: project })).toMatchObject({
        targets: [{ allowUnsafeTarget: false }, { allowUnsafeTarget: false }],
    });
    expect(() => resolveDockerPolicy({ globalConfig: ceiling, projectConfig: { ...project, unsafeTargets: [ordinary] } })).toThrow("Unknown project docker field");
});
test("Docker requires both global allowance and explicit project activation", () => {
    expect(resolveDockerPolicy({ globalConfig: {}, projectConfig: {} })).toEqual({ mode: "disabled" });
    expect(resolveDockerPolicy({ globalConfig: global })).toEqual({ mode: "disabled" });
    expect(resolveDockerPolicy({ globalConfig: { allowed: false }, projectConfig: { enabled: true } })).toEqual({ mode: "disabled" });
    expect(resolveDockerPolicy({ globalConfig: global, projectConfig: { enabled: false } })).toEqual({ mode: "disabled" });
    expect(resolveDockerPolicy({ globalConfig: global, projectConfig: { enabled: true } }).mode).toBe("targeted");
    expect(resolveDockerPolicy({ globalConfig: { allowed: true, mode: "full" }, projectConfig: { enabled: true } }).mode).toBe("full");
    expect(resolveDockerPolicy({ globalConfig: { allowed: false, mode: "full", endpoint: "unix:///run/docker.sock" }, projectConfig: { enabled: true } })).toEqual({ mode: "disabled" });
});
test("global operation limits apply to targets selected by any project", () => {
    expect(resolveDockerPolicy({ globalConfig: global, projectConfig: { enabled: true, targets: [{ selector: { type: "container-name", name: "api" }, operations: ["logs"] }] } })).toMatchObject({ mode: "targeted", targets: [{ operations: ["logs"] }] });
    expect(resolveDockerPolicy({ globalConfig: global, projectConfig: { enabled: true, targets: [{ selector: { type: "container-name", name: "other" } }] } })).toMatchObject({ targets: [{ selector: { name: "other" }, operations: ["logs", "inspect"] }] });
    expect(() => resolveDockerPolicy({ globalConfig: global, projectConfig: { enabled: true, targets: [{ selector: { type: "container-name", name: "api" }, operations: ["exec"] }] } })).toThrow("added a Docker operation");
    expect(() => resolveDockerPolicy({ globalConfig: global, projectConfig: { enabled: true, targets: [{ selector: { type: "container-name", name: "api" }, allowUnsafeTarget: true }] } })).toThrow("cannot add a Docker unsafe exception");
});
test("rejects wrong Docker scope and non-booleans", () => {
    expect(() => resolveDockerPolicy({ globalConfig: { allowed: "true" }, projectConfig: { enabled: true } })).toThrow("global docker.allowed must be boolean");
    expect(() => resolveDockerPolicy({ globalConfig: global, projectConfig: { enabled: "true" } })).toThrow("project docker.enabled must be boolean");
});
test("rejects duplicate project selectors even when Docker is inactive", () => {
    const target = { selector: { type: "container-name", name: "api" } };
    expect(() => resolveDockerPolicy({ globalConfig: { allowed: false }, projectConfig: { enabled: false, targets: [target, target] } })).toThrow("Duplicate Docker target");
});
test("rejects invalid global policy and sensitive fields even while disabled", () => {
    for (const globalConfig of [null, { allowed: false, operations: ["unknown"] }, { allowed: false, unsafeTargets: "all" }, { allowed: false, unsafeTargets: [{ type: "container-name", name: "api" }, { type: "container-name", name: "api" }] }, { allowed: false, mode: "full", operations: ["logs"] }, { allowed: false, targets: [] }]) {
        expect(() => resolveDockerPolicy({ globalConfig })).toThrow();
    }
    expect(resolveDockerPolicy({ globalConfig: { allowed: true, operations: [] }, projectConfig: { enabled: true, targets: [{ selector: { type: "container-name", name: "api" } }] } })).toMatchObject({ targets: [{ operations: [] }] });
});
test("validates disabled Docker sections and project-only exceptions before activation", () => {
    expect(() => resolveDockerPolicy({
        globalConfig: { mode: "invalid" },
        projectConfig: { enabled: true },
    })).toThrow("global docker.mode");
    expect(() => resolveDockerPolicy({
        globalConfig: global,
        projectConfig: { enabled: false, targets: "invalid" },
    })).toThrow("project docker.targets must be an array");
    expect(() => resolveDockerPolicy({
        globalConfig: global,
        projectConfig: {
            enabled: false,
            targets: [{
                selector: { type: "container-name", name: "fixture" },
                allowUnsafeTarget: true,
            }],
        },
    })).toThrow("Project cannot add a Docker unsafe exception");
    expect(() => resolveDockerPolicy({
        globalConfig: global,
        projectConfig: {
            enabled: false,
            targets: [{
                selector: { type: "container-name", name: "fixture" },
                allowUnsafeTarget: false,
            }],
        },
    })).toThrow("Project cannot add a Docker unsafe exception");
});
