import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCapabilityCommands } from "./commands.ts";
import { capabilityAuthorityPath, readCapabilityAuthority, emptyGrants, saveProjectCapabilities } from "./authority.ts";
import type { ShellCapabilityResolution } from "./policy.ts";

const roots: string[] = [];
test("revocation remains available after a project loses trust", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-cap-revoke-")); roots.push(root);
    await saveProjectCapabilities(capabilityAuthorityPath(root), { projectRoot: root, profile: "host", grants: { ...emptyGrants(), host: true } }, "test");
    const policy: ShellCapabilityResolution = { state: "ready", profile: "host", requestedProfile: "host", projectRoot: root, grants: { ...emptyGrants(), host: true }, requestedGrants: emptyGrants(), authorityPath: capabilityAuthorityPath(root) };
    const commands = createCapabilityCommands({ agentDir: root, machineId: "test", load: () => policy, apply: async () => {} });
    await commands.handle("capabilities revoke host", { cwd: root, hasUI: true, isProjectTrusted: () => false,
        ui: { confirm: async () => false, notify() {}, input: async () => undefined, select: async () => undefined } });
    expect(readCapabilityAuthority(capabilityAuthorityPath(root), "test").projects[0]?.grants.host).toBe(false);
});
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
test("host profile selection requires one user decision and persists only this project", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-cap-ui-")); roots.push(root);
    let confirmations = 0;
    let applied = 0;
    const ctx = {
        cwd: root, hasUI: true, isProjectTrusted: () => true,
        ui: { confirm: async () => { confirmations++; return true; }, notify: () => {}, input: async () => undefined, select: async () => undefined },
    };
    const initial: ShellCapabilityResolution = {
        state: "ready", profile: "isolated", requestedProfile: "isolated", projectRoot: root,
        grants: emptyGrants(), requestedGrants: emptyGrants(), authorityPath: capabilityAuthorityPath(root),
    };
    const commands = createCapabilityCommands({
        agentDir: root, machineId: "test-machine", load: () => initial,
        apply: async () => { applied++; },
    });
    expect(await commands.handle("profile host", ctx)).toBe(true);
    expect(confirmations).toBe(1);
    expect(applied).toBe(1);
    expect(readCapabilityAuthority(capabilityAuthorityPath(root), "test-machine").projects[0]?.grants.host).toBe(true);
});
