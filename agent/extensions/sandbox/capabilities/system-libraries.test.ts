import { afterAll, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
const real = { ...fs };
const root = real.mkdtempSync(join(tmpdir(), "pi-system-libraries-"));
const libraries = join(root, "libraries");
real.mkdirSync(libraries);
let unsafe = false;
let elf = Buffer.alloc(0);
const loaderAlias = "/lib64/fixture-loader.so";
const loaderTarget = join(libraries, "fixture-loader.so");
real.writeFileSync(loaderTarget, "loader fixture");
mock.module("node:fs", () => ({
    ...real,
    readFileSync: (...args: Parameters<typeof real.readFileSync>) =>
        args[0] === "/usr/bin/env" ? elf : real.readFileSync(...args),
    existsSync: (p: string) =>
        p === loaderAlias ||
        ["/lib", "/usr/lib"].includes(p) ||
        (!["/lib64", "/usr/lib64"].includes(p) && real.existsSync(p)),
    realpathSync: Object.assign(
        (p: string) =>
            p === loaderAlias
                ? loaderTarget
                : ["/lib", "/usr/lib"].includes(p)
                  ? libraries
                  : real.realpathSync(p),
        { native: real.realpathSync.native },
    ),
    statSync: (p: string) => {
        const s = real.statSync(p === loaderAlias ? loaderTarget : p);
        return p === libraries || libraries.startsWith(p + "/")
            ? Object.assign(Object.create(Object.getPrototypeOf(s)), s, {
                  uid: 0,
                  mode: unsafe && p === libraries ? 0o40777 : 0o40755,
              })
            : s;
    },
}));
const { prepareDevelopmentSetup, applyDevelopmentSetup } =
    await import("./development-setup.ts");
const { resolveShellPolicy } = await import("./policy.ts");
const { validatePiSandboxConfig } = await import("../runtime/policies.ts");
afterAll(() => {
    mock.restore();
    real.rmSync(root, { recursive: true, force: true });
});
test("preview/apply replaces stale libraries while preserving executable bindings and local policy", () => {
    const agentDir = join(root, "agent"),
        path = join(agentDir, "config/sandbox.json");
    real.mkdirSync(dirname(path), { recursive: true });
    real.writeFileSync(join(root, "node"), "#!/bin/sh\nexit 0\n", {
        mode: 0o700,
    });
    const before = {
        version: 2,
        machineId: "fixture",
        network: { allowedDomains: ["example.test"] },
        environment: {
            variables: { KEEP: "value" },
            installations: {
                personal: [
                    { root, path: ["."], files: ["node"] },
                    { root: libraries, path: [], files: ["libold.so.1"] },
                ],
            },
        },
    };
    real.writeFileSync(path, JSON.stringify(before), { mode: 0o600 });
    const prepare = () =>
        prepareDevelopmentSetup({
            agentDir,
            machineId: "fixture",
            profile: { systemLibraries: true },
        });
    const prepared = prepare();
    expect(JSON.parse(real.readFileSync(path, "utf8"))).toEqual(before);
    expect(prepared.unavailable).toEqual([]);
    expect(applyDevelopmentSetup(prepared)).toBe(true);
    const saved = JSON.parse(real.readFileSync(path, "utf8"));
    expect(saved.network).toEqual(before.network);
    expect(saved.environment.variables).toEqual(before.environment.variables);
    expect(saved.environment.installations.personal).toEqual([
        { root, path: ["."], files: ["node"] },
    ]);
    expect(saved.environment.installations["system-libraries"]).toEqual([
        { root: libraries, path: [] },
    ]);
    const { config } = resolveShellPolicy({
        cwd: root,
        global: saved,
        authorityPath: path,
        baseline: validatePiSandboxConfig({}),
    });
    expect(config.filesystem.allowRead).toContain(libraries);
    expect(config.filesystem.denyWrite).toContain(libraries);
    real.writeFileSync(join(libraries, "libnew.so.1"), "new library");
    expect(applyDevelopmentSetup(prepare())).toBe(false);
});
test("unsafe system directories fail before publication", () => {
    unsafe = true;
    try {
        expect(() =>
            prepareDevelopmentSetup({
                agentDir: join(root, "unsafe-agent"),
                machineId: "fixture",
                profile: { systemLibraries: true },
            }),
        ).toThrow("Untrusted system library directory");
    } finally {
        unsafe = false;
    }
});

test("permission changes after preview refuse apply without publishing authority", () => {
    const agentDir = join(root, "changed-agent"),
        path = join(agentDir, "config/sandbox.json");
    const prepared = prepareDevelopmentSetup({
        agentDir,
        machineId: "fixture",
        profile: { systemLibraries: true },
    });
    unsafe = true;
    try {
        expect(() => applyDevelopmentSetup(prepared)).toThrow(
            "changed after preview",
        );
        expect(real.existsSync(path)).toBe(false);
    } finally {
        unsafe = false;
    }
});

test("profiles without opt-in stay closed and invalid option values are rejected", () => {
    const prepared = prepareDevelopmentSetup({
        agentDir: join(root, "closed-agent"),
        machineId: "fixture",
        profile: {},
    });
    expect(
        prepared.discovery.installations["system-libraries"],
    ).toBeUndefined();
    expect(prepared.next.environment).toEqual({
        installations: {},
        variables: {},
    });
    expect(() =>
        prepareDevelopmentSetup({
            agentDir: join(root, "invalid-agent"),
            machineId: "fixture",
            profile: { systemLibraries: "true" },
        }),
    ).toThrow("systemLibraries must be a boolean");
});

test("native ELF interpreter aliases retain exact access beside canonical directory roots", () => {
    const interpreter = Buffer.from(loaderAlias + "\0");
    elf = Buffer.alloc(120 + interpreter.length);
    elf.write("\x7fELF");
    elf[4] = 2;
    elf[5] = 1;
    elf.writeBigUInt64LE(64n, 32);
    elf.writeUInt16LE(56, 54);
    elf.writeUInt16LE(1, 56);
    elf.writeUInt32LE(3, 64);
    elf.writeBigUInt64LE(120n, 72);
    elf.writeBigUInt64LE(BigInt(interpreter.length), 96);
    interpreter.copy(elf, 120);
    try {
        const prepared = prepareDevelopmentSetup({
            agentDir: join(root, "alias-agent"),
            machineId: "fixture",
            profile: { systemLibraries: true },
        });
        expect(prepared.discovery.installations["system-libraries"]).toEqual([
            { root: libraries, path: [] },
            { root: "/", path: [], files: [loaderAlias.slice(1)] },
        ]);
        expect(applyDevelopmentSetup(prepared)).toBe(true);
    } finally {
        elf = Buffer.alloc(0);
    }
});
