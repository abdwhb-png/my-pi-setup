import { expect, test } from "bun:test";
import { summarizeDockerAccess, formatActiveDocker, formatDockerGrantResult, formatDockerSummary } from "./docker-presentation.ts";

const authority = summarizeDockerAccess({ mode: "targeted", endpoint: "unix:///hidden.sock", targets: [
    { selector: { type: "container-name", name: "api" }, allowUnsafeTarget: true },
] });

test("reports saved and effective profiles separately when a project narrows the grant", () => {
    const effective = summarizeDockerAccess({ mode: "targeted", endpoint: "unix:///hidden.sock", targets: [
        { selector: { type: "container-name", name: "api" }, operations: ["logs"], allowUnsafeTarget: true },
    ] });
    const message = formatDockerGrantResult(authority, effective);
    expect(message).toContain("Saved Docker grant: targeted · Exploitation + inspection");
    expect(message).toContain("Requested profile: Administration");
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
    expect(message).toContain("Mixed + inspection · 2 targets");
    expect(message).toContain("container-name: worker — Observation");
    expect(message).toContain("compose-service: app / api — Exploitation");
});

test("reports unsafe Administration as bounded inspection without arbitrary exec", () => {
    const summary = summarizeDockerAccess({
        mode: "targeted",
        endpoint: "unix:///hidden.sock",
        targets: [{
            selector: { type: "container-name", name: "api" },
            operations: ["ps", "inspect", "logs", "stats", "exec", "start", "stop", "restart"],
            allowUnsafeTarget: true,
        }],
    });
    const message = formatDockerSummary("Active Docker", summary).join("\n");

    expect(summary.profile).toBe("Exploitation");
    expect(message).toContain("targeted · Exploitation + inspection · 1 target");
    expect(message).toContain("Requested profile: Administration");
    expect(message).toContain("Arbitrary exec: unavailable; read-only inspection: test -r, stat, ls");
    expect(message).not.toContain("Operations: ps, inspect, logs, stats, exec,");
});

test("shows an active break-glass separately from the persistent target grant", () => {
    const expiresAt = Date.now() + 300_000;
    const summary = summarizeDockerAccess({
        mode: "targeted",
        endpoint: "unix:///hidden.sock",
        targets: [
            {
                selector: { type: "container-name", name: "api" },
                operations: ["ps", "inspect", "logs", "stats", "exec", "start", "stop", "restart"],
                allowUnsafeTarget: true,
            },
            {
                selector: { type: "ephemeral-container", id: "abc123", unsafeExecExpiresAtMs: expiresAt },
                operations: ["exec"],
                allowUnsafeTarget: true,
            },
        ],
    }, Date.now());
    const message = formatDockerSummary("Active Docker", summary).join("\n");

    expect(summary.targets).toHaveLength(1);
    expect(message).toContain("Break-glass exec: container abc123");
    expect(message).toContain(new Date(expiresAt).toISOString());
    const configured = summarizeDockerAccess({
        mode: "targeted",
        endpoint: "unix:///hidden.sock",
        targets: [{
            selector: { type: "container-name", name: "api" },
            operations: ["ps", "inspect", "logs", "stats", "exec", "start", "stop", "restart"],
            allowUnsafeTarget: true,
        }],
    });
    const runtimeLines = formatActiveDocker(configured, summary, "enabled").join("\n");
    expect(runtimeLines).toContain("session-only break-glass");
    expect(runtimeLines).not.toContain("Run /sandbox on");
});

test("does not hide an unrelated runtime difference behind break-glass", () => {
    const configured = summarizeDockerAccess({ mode: "disabled" });
    const active = summarizeDockerAccess({
        mode: "targeted",
        endpoint: "unix:///hidden.sock",
        targets: [
            {
                selector: { type: "ephemeral-container", id: "abc123", unsafeExecExpiresAtMs: Date.now() + 300_000 },
                operations: ["exec"],
                allowUnsafeTarget: true,
            },
        ],
    });

    const message = formatActiveDocker(configured, active, "enabled").join("\n");
    expect(message).toContain("Active Docker differs from the current configuration");
    expect(message).not.toContain("differs from the saved grant only");
});
