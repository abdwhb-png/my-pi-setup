import { expect, test } from "bun:test";
import { summarizeDockerAccess, formatDockerGrantResult, formatDockerSummary } from "./docker-presentation.ts";

const authority = summarizeDockerAccess({ mode: "targeted", endpoint: "unix:///hidden.sock", targets: [
    { selector: { type: "container-name", name: "api" }, allowUnsafeTarget: true },
] });

test("reports saved and effective profiles separately when a project narrows the grant", () => {
    const effective = summarizeDockerAccess({ mode: "targeted", endpoint: "unix:///hidden.sock", targets: [
        { selector: { type: "container-name", name: "api" }, operations: ["logs"], allowUnsafeTarget: true },
    ] });
    const message = formatDockerGrantResult(authority, effective);
    expect(message).toContain("Saved Docker grant: targeted · Administration");
    expect(message).toContain("Active Docker: targeted · Custom");
    expect(message).toContain("Operations: logs\n");
    expect(message).toContain("effective configuration differs");
    expect(message).not.toContain("hidden.sock");
    expect(message).not.toContain("Warning:");
});

test("distinguishes saved inactive and failed activation from a successful grant", () => {
    expect(formatDockerGrantResult(authority)).toContain("not active: Sandbox is disabled");
    const failure = formatDockerGrantResult(authority, undefined, "backend unavailable");
    expect(failure).toContain("saved; activation failed: backend unavailable");
    expect(failure).not.toContain("Active Docker:");
    expect(formatDockerGrantResult(authority, authority)).toContain("saved and active");
});

test("lists each target when profiles differ and matches operation sets regardless of ordering", () => {
    const summary = summarizeDockerAccess({ mode: "targeted", endpoint: "unix:///hidden.sock", targets: [
        { selector: { type: "container-name", name: "worker" }, operations: ["stats", "logs", "ps", "inspect", "ps"], allowUnsafeTarget: false },
        { selector: { type: "compose-service", project: "app", service: "api" }, allowUnsafeTarget: true },
    ] });
    const message = formatDockerSummary("Active Docker", summary).join("\n");
    expect(message).toContain("Mixed · 2 targets");
    expect(message).toContain("container-name: worker — Observation");
    expect(message).toContain("compose-service: app / api — Administration");
});
