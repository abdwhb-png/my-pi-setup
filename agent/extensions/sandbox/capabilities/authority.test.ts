import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capabilityAuthorityPath, emptyGrants, readCapabilityAuthority, saveProjectCapabilities, parseGrants } from "./authority.ts";
import { resolveShellPolicy } from "./policy.ts";
import { validatePiSandboxConfig } from "../runtime/policies.ts";

const roots: string[] = [];
test("malformed capability grants cannot become a valid authority", () => {
    for (const grants of [{ ...emptyGrants(), readPaths: ["relative"] }, { ...emptyGrants(), domains: ["https://example.com"] }, { ...emptyGrants(), hostDomains: ["localhost"] }]) {
        expect(() => parseGrants(grants)).toThrow("invalid-authority");
    }
});
function fixture() {
    const root = mkdtempSync(join(tmpdir(), "pi-capability-"));
    roots.push(root);
    return { root, path: capabilityAuthorityPath(root) };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test("local grants persist atomically, preserve other projects, and can be revoked", async () => {
    const a = fixture(); const b = fixture();
    await saveProjectCapabilities(a.path, { projectRoot: a.root, profile: "integrated", grants: { ...emptyGrants(), domains: ["github.com"] } }, "machine-a");
    await saveProjectCapabilities(a.path, { projectRoot: b.root, profile: "host", grants: { ...emptyGrants(), host: true } }, "machine-a");
    await saveProjectCapabilities(a.path, { projectRoot: a.root, profile: "isolated", grants: emptyGrants() }, "machine-a");
    const authority = readCapabilityAuthority(a.path, "machine-a");
    expect(statSync(a.path).mode & 0o777).toBe(0o600);
    expect(authority.projects.find(p => p.projectRoot === a.root)?.grants.domains).toEqual([]);
    expect(authority.projects.find(p => p.projectRoot === b.root)?.grants.host).toBe(true);
});

test("copied grants cannot activate or overwrite authority on another machine", async () => {
    const { root, path } = fixture();
    await saveProjectCapabilities(path, { projectRoot: root, profile: "host", grants: { ...emptyGrants(), host: true } }, "machine-a");
    const before = readFileSync(path, "utf8");
    const resolved = resolveShellPolicy({
        cwd: root, config: validatePiSandboxConfig({}), authority: readCapabilityAuthority(path, "machine-b"),
        authorityPath: path, machineId: "machine-b", hasLegacySettings: false, domainsRequested: false, hostDomainsRequested: false,
    });
    expect(resolved.shell.state).toBe("machine-mismatch");
    expect(resolved.shell.grants.host).toBe(false);
    await expect(saveProjectCapabilities(path, { projectRoot: root, profile: "host", grants: emptyGrants() }, "machine-b")).rejects.toThrow("machine-mismatch");
    expect(readFileSync(path, "utf8")).toBe(before);
});

test("unsafe, malformed, and dangling authority files fail closed", async () => {
    const { root, path } = fixture();
    symlinkSync(join(root, "missing"), path);
    expect(() => readCapabilityAuthority(path, "machine-a")).toThrow("invalid-authority");
    rmSync(path);
    writeFileSync(path, "{", { mode: 0o600 });
    expect(() => readCapabilityAuthority(path, "machine-a")).toThrow("invalid-authority");
    rmSync(path);
    await saveProjectCapabilities(path, { projectRoot: root, profile: "isolated", grants: emptyGrants() }, "machine-a");
    chmodSync(path, 0o666);
    expect(() => readCapabilityAuthority(path, "machine-a")).toThrow("invalid-authority");
});

test("explicit foreign-machine migration archives grants without activating other projects", async () => {
    const { root, path } = fixture(); const other = fixture();
    await saveProjectCapabilities(path, { projectRoot: other.root, profile: "host", grants: { ...emptyGrants(), host: true } }, "foreign");
    const previous = readFileSync(path, "utf8");
    const archive = await saveProjectCapabilities(path, { projectRoot: root, profile: "isolated", grants: emptyGrants() }, "local", { replaceForeign: true });
    expect(archive).toBeString();
    expect(readFileSync(archive!, "utf8")).toBe(previous);
    expect(readCapabilityAuthority(path, "local").projects.map(p => p.projectRoot)).toEqual([root]);
});

test("explicit filesystem restrictions never turn into unrestricted reads", () => {
    const { root, path } = fixture();
    const resolved = resolveShellPolicy({
        cwd: root, config: validatePiSandboxConfig({ filesystem: { allowRead: ["/outside"] } }),
        authority: { version: 1, machineId: "a", projects: [] }, authorityPath: path, machineId: "a",
        hasLegacySettings: false, domainsRequested: false, hostDomainsRequested: false,
    });
    expect(resolved.config.filesystem.allowRead).toEqual([root]);
    expect(resolved.shell.state).toBe("authorization-required");
});

test("a project read preference keeps its narrower subtree", () => {
    const { root, path } = fixture();
    const resolved = resolveShellPolicy({
        cwd: root, config: validatePiSandboxConfig({ filesystem: { allowRead: ["src"] } }),
        authority: { version: 1, machineId: "a", projects: [] }, authorityPath: path, machineId: "a",
        hasLegacySettings: false, domainsRequested: false, hostDomainsRequested: false,
    });
    expect(resolved.config.filesystem.allowRead).toEqual([join(root, "src")]);
});

test("an approved host shell is independent from strict-engine read preferences", () => {
    const { root, path } = fixture();
    const resolved = resolveShellPolicy({
        cwd: root, config: validatePiSandboxConfig({ filesystem: { allowRead: ["/outside"] } }),
        authority: { version: 1, machineId: "a", projects: [{ projectRoot: root, profile: "host", grants: { ...emptyGrants(), host: true } }] },
        authorityPath: path, machineId: "a", hasLegacySettings: false, domainsRequested: false, hostDomainsRequested: false,
    });
    expect(resolved.shell.state).toBe("ready");
    expect(resolved.shell.profile).toBe("host");
    expect(resolved.config.filesystem.allowRead).toEqual([root]);
});

test("repository filesystem preferences cannot grant writes through an escaping symlink", () => {
    const project = fixture(); const outside = fixture();
    symlinkSync(outside.root, join(project.root, "escape"));
    const resolved = resolveShellPolicy({
        cwd: project.root, config: validatePiSandboxConfig({ filesystem: { allowWrite: ["escape"] } }),
        authority: { version: 1, machineId: "a", projects: [] }, authorityPath: project.path, machineId: "a",
        hasLegacySettings: false, domainsRequested: false, hostDomainsRequested: false, writePathsRequested: true,
    });
    expect(resolved.config.filesystem.allowWrite).toEqual([]);
    expect(resolved.shell.requestedGrants.writePaths).toEqual([outside.root]);
});
