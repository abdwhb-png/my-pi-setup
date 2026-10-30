import { test, expect } from "bun:test";
import {
    mkdtempSync,
    mkdirSync,
    writeFileSync,
    readFileSync,
    existsSync,
    rmSync,
    symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    prepareDevelopmentSetup,
    applyDevelopmentSetup,
} from "./development-setup.ts";

test("portable setup previews without writes, preserves settings and applies idempotently on two machines", () => {
    const prior = process.env.HOME;
    const root = mkdtempSync(join(tmpdir(), "pi-development-"));
    try {
        for (const machine of ["one", "two"]) {
            const home = join(root, machine);
            process.env.HOME = home;
            mkdirSync(join(home, "tools/bin"), { recursive: true });
            const agentDir = join(home, "agent");
            mkdirSync(join(agentDir, "config"), { recursive: true });
            const file = join(agentDir, "config/sandbox.json");
            const before = {
                version: 2,
                machineId: machine,
                host: { allowed: false },
                network: { allowedDomains: ["example.org"] },
                environment: { variables: { KEEP: "value" } },
            };
            writeFileSync(file, JSON.stringify(before), { mode: 0o600 });
            const profile = {
                environment: {
                    installations: {
                        tools: [{ root: join(home, "tools"), path: ["bin"] }],
                    },
                    variables: {
                        XDG_CACHE_HOME: join(home, ".cache/pi/dev-tools/xdg"),
                    },
                },
                filesystem: { allowWrite: [join(home, ".cache/pi/dev-tools")] },
            };
            const prepared = prepareDevelopmentSetup({
                agentDir,
                machineId: machine,
                profile,
            });
            expect(existsSync(join(home, ".cache"))).toBe(false);
            expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(before);
            expect(prepared.unavailable).toEqual([]);
            expect(applyDevelopmentSetup(prepared)).toBe(true);
            const saved = JSON.parse(readFileSync(file, "utf8"));
            expect(saved.network).toEqual(before.network);
            expect(saved.environment.variables.KEEP).toBe("value");
            expect(saved.environment.installations.tools[0].root).toBe(
                join(home, "tools"),
            );
            expect(existsSync(join(home, ".cache/pi/dev-tools"))).toBe(true);
            expect(
                applyDevelopmentSetup(
                    prepareDevelopmentSetup({
                        agentDir,
                        machineId: machine,
                        profile,
                    }),
                ),
            ).toBe(false);
            const stale = prepareDevelopmentSetup({
                agentDir,
                machineId: machine,
                profile,
            });
            writeFileSync(file, readFileSync(file, "utf8") + " ");
            expect(() => applyDevelopmentSetup(stale)).toThrow("changed");
        }
    } finally {
        if (prior === undefined) delete process.env.HOME;
        else process.env.HOME = prior;
        rmSync(root, { recursive: true, force: true });
    }
});

test("missing installations are reported, malformed and escaping declarations are rejected", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-development-"));
    try {
        const options = { agentDir: join(root, "agent"), machineId: "fixture" };
        const missing = prepareDevelopmentSetup({
            ...options,
            profile: {
                environment: {
                    installations: {
                        missing: [{ root: join(root, "absent"), path: [] }],
                    },
                },
            },
        });
        expect(missing.unavailable.map((x) => x.name)).toEqual(["missing"]);
        expect(() =>
            prepareDevelopmentSetup({
                ...options,
                profile: {
                    environment: {
                        installations: {
                            bad: [{ root, path: ["../outside"] }],
                        },
                    },
                },
            }),
        ).toThrow();
        mkdirSync(join(root, "tools"));
        writeFileSync(join(root, "outside"), "data");
        symlinkSync(join(root, "outside"), join(root, "tools/escape"));
        expect(() =>
            prepareDevelopmentSetup({
                ...options,
                profile: {
                    environment: {
                        installations: {
                            bad: [
                                {
                                    root: join(root, "tools"),
                                    files: ["escape"],
                                },
                            ],
                        },
                    },
                },
            }),
        ).toThrow();
        expect(() =>
            prepareDevelopmentSetup({
                ...options,
                profile: { network: { allowedDomains: ["*"] } },
            }),
        ).toThrow();
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("publication validation failure preserves authority and rejects a foreign machine", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-development-"));
    try {
        const agentDir = join(root, "agent");
        mkdirSync(join(agentDir, "config"), { recursive: true });
        const file = join(agentDir, "config/sandbox.json");
        const original = JSON.stringify({ version: 2, machineId: "one" });
        writeFileSync(file, original, { mode: 0o600 });
        expect(() =>
            prepareDevelopmentSetup({
                agentDir,
                machineId: "two",
                profile: {},
            }),
        ).toThrow();
        const prepared = prepareDevelopmentSetup({
            agentDir,
            machineId: "one",
            profile: {},
        });
        prepared.next.unrecognized = true;
        expect(() => applyDevelopmentSetup(prepared)).toThrow();
        expect(readFileSync(file, "utf8")).toBe(original);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a writable cache cannot overlap a read-only host installation", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-development-"));
    try {
        expect(() =>
            prepareDevelopmentSetup({
                agentDir: join(root, "agent"),
                machineId: "fixture",
                profile: {
                    environment: {
                        installations: { host: [{ root, path: [] }] },
                    },
                    filesystem: { allowWrite: [join(root, "cache")] },
                },
            }),
        ).toThrow("overlap");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
