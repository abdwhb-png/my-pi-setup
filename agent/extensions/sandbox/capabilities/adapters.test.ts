import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyGrants } from "./authority.ts";
import { parseLiteralCommand, prepareHostIntegration } from "./adapters.ts";
import type { ShellCapabilityResolution } from "./policy.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
    const root = mkdtempSync(join(tmpdir(), "pi-adapter-")); roots.push(root);
    const project = join(root, "project"); mkdirSync(project);
    const launcher = join(root, "launcher"); writeFileSync(launcher, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const policy: ShellCapabilityResolution = { state: "ready", projectRoot: project, profile: "integrated", requestedProfile: "integrated",
        grants: { ...emptyGrants(), integrations: { editor: { zed: launcher }, dependencies: { sfw: launcher, npm: launcher }, "dev-services": { "dev-services": launcher } } },
        requestedGrants: emptyGrants(), authorityPath: join(root, "authority") };
    return { root, project, launcher, policy };
}
test("integration launchers exclude repository interpreters and environment injection", () => {
    const { project, policy } = fixture();
    const prepared = prepareHostIntegration(policy, "dependencies", "npm install is-number@7.0.0", project,
        { PATH: `${project}:/usr/bin:.:${project}/node_modules/.bin`, NODE_OPTIONS: "--require ./injection.cjs", BASH_ENV: "./injection.sh", SFW_SKIP_UPDATE_CHECK: "true" });
    expect(prepared.env.PATH).toBe("/usr/bin");
    expect(prepared.env.NODE_OPTIONS).toBeUndefined();
    expect(prepared.env.BASH_ENV).toBeUndefined();
    expect(prepared.env.SFW_SKIP_UPDATE_CHECK).toBeUndefined();
    expect(prepared.args).toEqual([policy.grants.integrations.dependencies!.npm, "install", "is-number@7.0.0", "--ignore-scripts"]);
});
test("editor accepts project files and rejects escapes, flags and repository launchers", () => {
    const { root, project, launcher, policy } = fixture();
    writeFileSync(join(project, "a b.ts"), ""); symlinkSync(launcher, join(project, "outside"));
    expect(prepareHostIntegration(policy, "editor", "zed 'a b.ts'", project, {}).args).toEqual([join(project, "a b.ts")]);
    for (const command of ["zed outside", `zed ${root}/launcher`, "zed --wait 'a b.ts'"]) {
        expect(() => prepareHostIntegration(policy, "editor", command, project, {})).toThrow("unsupported-command");
    }
    policy.grants.integrations.editor!.zed = join(project, "a b.ts");
    expect(() => prepareHostIntegration(policy, "editor", "zed 'a b.ts'", project, {})).toThrow("integration-unavailable");
});
test("literal commands preserve quoted arguments and reject shell evaluation", () => {
    expect(parseLiteralCommand("npm install 'a b' \"c d\" ''")).toEqual(["npm", "install", "a b", "c d", ""]);
    for (const command of ["npm test | cat", "npm test && true", "npm test > file", "npm $(id)", "npm `id`", "npm ${X}", "npm test\ntrue", "X=1 npm install", "npm test;true", "npm test &", "npm '*.ts' $(true)"]) {
        expect(() => parseLiteralCommand(command)).toThrow("unsupported-command");
    }
});
test("dependencies reject unsupported managers and execution verbs without an unsafe retry", () => {
    const { project, policy } = fixture();
    for (const command of ["bun install", "npm exec arbitrary", "npm run arbitrary", "npm install --ignore-scripts=false", "npm install -g pkg", "npm install --location=global pkg", "npm install --pre=/outside pkg", "npm install -C /outside pkg"]) {
        expect(() => prepareHostIntegration(policy, "dependencies", command, project, {})).toThrow("unsupported-command");
    }
});
