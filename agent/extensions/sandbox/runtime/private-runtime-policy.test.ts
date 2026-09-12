import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import sandboxExtension from "../index.ts";
import { createAnalysisPolicy, createBashPolicy, validatePiSandboxConfig } from "./policies.ts";

const root = join(homedir(), ".pi", "test-private-runtime");
const lease = { root, homeDir: join(root, "home"), tmpDir: join(root, "tmp"), zeroboxHome: join(root, "zerobox"), proxyRunsDir: join(root, "zerobox", "runs"), profilesDir: join(root, "zerobox", "profiles") };
const cwd = join(homedir(), "project-fixture");

test("the default shell policy supplies a private runtime without host system reads or inherited environment", () => {
    expect(typeof sandboxExtension).toBe("function");
    const policy = createBashPolicy({ cwd, lease, config: validatePiSandboxConfig({}), hostEnv: { PATH: "/host/canary", USER: "host-user", SHELL: "/host/shell", TERM: "host-term", LANG: "host-lang" } });
    for (const path of ["/bin", "/sbin", "/usr", "/lib", "/lib64", "/etc/ld.so.cache", lease.proxyRunsDir]) expect(policy.filesystem.allowRead).not.toContain(path);
    expect(policy.environment.inherit).toEqual([]);
    expect(policy.environment.set.PATH).toBe("/__zerobox/runtime/bin");
    expect(policy.environment.set.USER).toBe("sandbox");
    expect(policy.environment.set.SHELL).toBe("/__zerobox/runtime/bin/bash");
    expect(policy.environment.set.LANG).toBe("C.UTF-8");
    expect(policy.environment.set.HOME).toBe("/home/sandbox");
    expect(policy.filesystem.denyWrite).toContain("/__zerobox");
});

test("Analysis keeps its private tmp writable without granting the host tmp tree", () => {
    const policy = createAnalysisPolicy({ cwd, lease, readablePaths: [] });
    expect(policy.filesystem.allowRead).not.toContain("/tmp");
    expect(policy.filesystem.allowWrite).not.toContain("/tmp");
    expect(policy.filesystem.allowWrite).toContain(lease.tmpDir);
    expect(policy.filesystem.denyRead).not.toContain("/tmp");
    expect(policy.filesystem.denyWrite).not.toContain("/tmp");
});

test("explicit environment inheritance and command paths remain independent of read grants", () => {
    const policy = createBashPolicy({ cwd, lease, config: validatePiSandboxConfig({ environment: { allowedVariables: ["LANG"], path: ["/explicit/bin"] } }), hostEnv: { LANG: "approved-language", USER: "host-user" } });
    expect(policy.environment.inherit).toEqual(["LANG"]);
    expect(policy.environment.set.LANG).toBe("approved-language");
    expect(policy.environment.set.USER).toBe("sandbox");
    expect(policy.environment.set.PATH).toBe("/explicit/bin:/__zerobox/runtime/bin");
    expect(policy.filesystem.allowRead).not.toContain("/explicit/bin");
});

test("Analysis uses only its private runtime search path", () => {
    const policy = createAnalysisPolicy({ cwd, lease, readablePaths: [] });
    expect(policy.environment.set.PATH).toBe("/__zerobox/analysis/bin:/__zerobox/runtime/bin");
    expect(policy.environment.inherit).toEqual([]);
    expect(policy.filesystem.denyWrite).toContain("/__zerobox");
});
