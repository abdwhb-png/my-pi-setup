import { test, expect } from "bun:test";
import {
    mkdtempSync,
    mkdirSync,
    writeFileSync,
    rmSync,
    existsSync,
    chmodSync,
    realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    prepareDevelopmentSetup,
    applyDevelopmentSetup,
} from "./development-setup.ts";

test("logical tool requirements resolve an existing installation without fixed home paths", () => {
    const root = mkdtempSync(join(tmpdir(), "pi-tool-discovery-"));
    const original = process.env.PATH;
    try {
        const bin = join(root, "arbitrary-prefix/bin");
        mkdirSync(bin, { recursive: true });
        const executable = join(bin, "bun");
        writeFileSync(
            executable,
            `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ executable, version: "1.2.3", resources: [] })}'\n`,
            { mode: 0o700 },
        );
        process.env.PATH = bin;
        const agentDir = join(root, "agent");
        const prepared = prepareDevelopmentSetup({
            agentDir,
            machineId: "fixture",
            profile: { tools: { bun: ["bun"] } },
        });
        expect(prepared.unavailable).toEqual([]);
        const environment = prepared.next.environment as {
            installations: {
                bun: Array<{ root: string; path: string[]; files?: string[] }>;
            };
        };
        expect(
            environment.installations.bun.some(
                (entry) =>
                    entry.root === bin &&
                    entry.path.includes(".") &&
                    entry.files?.includes("bun"),
            ),
        ).toBe(true);
        expect(existsSync(agentDir)).toBe(false);
        expect(applyDevelopmentSetup(prepared)).toBe(true);
        expect(
            applyDevelopmentSetup(
                prepareDevelopmentSetup({
                    agentDir,
                    machineId: "fixture",
                    profile: { tools: { bun: ["bun"] } },
                }),
            ),
        ).toBe(false);
    } finally {
        if (original === undefined) delete process.env.PATH;
        else process.env.PATH = original;
        rmSync(root, { recursive: true, force: true });
    }
});

import { symlinkSync } from "node:fs";
import { resolveDevelopmentTools } from "../development-tools.ts";

function fixture() {
    const root = mkdtempSync(join(tmpdir(), "pi-tools-fixture-"));
    const bin = join(root, "prefix/bin");
    mkdirSync(bin, { recursive: true });
    return {
        root,
        bin,
        command(name: string, resources: string[] = []) {
            const executable = join(bin, name);
            writeFileSync(
                executable,
                `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ executable, version: "1.2.3", resources })}'\n`,
                { mode: 0o700 },
            );
            return executable;
        },
        dispose() {
            rmSync(root, { recursive: true, force: true });
        },
    };
}

test("group-writable vendor executables require an owner-only ancestor", () => {
    const f = fixture();
    try {
        const binary = f.command("bun");
        chmodSync(binary, 0o775);
        const result = resolveDevelopmentTools(
            { bun: ["bun"] },
            { path: f.bin },
        );
        expect(result.unavailable).toEqual([]);
        chmodSync(f.root, 0o755);
        expect(() => result.assertUnchanged()).toThrow("changed after preview");
        expect(
            resolveDevelopmentTools({ bun: ["bun"] }, { path: f.bin })
                .unavailable,
        ).toHaveLength(1);
    } finally {
        f.dispose();
    }
});

test("an executable permission change invalidates prepared discovery", () => {
    const f = fixture();
    try {
        const binary = f.command("bun");
        const result = resolveDevelopmentTools(
            { bun: ["bun"] },
            { path: f.bin },
        );
        chmodSync(binary, 0o775);
        expect(() => result.assertUnchanged()).toThrow("changed after preview");
    } finally {
        f.dispose();
    }
});

test("runtime recipes expose their actual resources without requiring a version manager", () => {
    const f = fixture();
    try {
        const library = join(f.root, "python-library");
        mkdirSync(library);
        for (const name of [
            "node",
            "bun",
            "python3",
            "go",
            "php",
            "composer",
            "pnpm",
        ])
            f.command(name, name === "python3" ? [library] : []);
        const result = resolveDevelopmentTools(
            {
                node: ["node"],
                bun: ["bun"],
                python: ["python3"],
                go: ["go"],
                php: ["php", "composer"],
                "pnpm-corepack": ["pnpm"],
            },
            { path: f.bin },
        );
        expect(result.unavailable).toEqual([]);
        expect(result.tools.map((tool) => tool.command)).toEqual([
            "node",
            "bun",
            "python3",
            "go",
            "php",
            "composer",
            "pnpm",
        ]);
        expect(
            result.installations.python.some(
                (entry) => entry.root === library && entry.files === undefined,
            ),
        ).toBe(true);
    } finally {
        f.dispose();
    }
});

test("PHP installations can expose more than 64 configuration files without truncation", () => {
    const f = fixture();
    try {
        const resources = Array.from({ length: 66 }, (_, index) =>
            join(f.root, `extension-${index}.ini`),
        );
        for (const file of resources)
            writeFileSync(file, "; fixture extension configuration\n");
        f.command("php", resources);
        const result = resolveDevelopmentTools(
            { php: ["php"] },
            { path: f.bin },
        );
        expect(result.unavailable).toEqual([]);
        expect(
            result.installations.php.filter((entry) => entry.root === f.root),
        ).toHaveLength(1);
        expect(
            result.installations.php
                .flatMap((entry) => entry.files ?? [])
                .filter((file) => file.endsWith(".ini")),
        ).toHaveLength(66);
        f.command(
            "php",
            Array.from({ length: 257 }, () => resources[0]),
        );
        expect(
            resolveDevelopmentTools({ php: ["php"] }, { path: f.bin })
                .unavailable,
        ).toHaveLength(1);
    } finally {
        f.dispose();
    }
});

test("a granted runtime directory does not duplicate exact grants for its shared libraries", () => {
    const f = fixture();
    try {
        const library = join(f.root, "runtime-library");
        mkdirSync(library);
        const elf = Buffer.alloc(64);
        elf.write("\x7fELF");
        elf[4] = 2;
        elf[5] = 1;
        elf.writeUInt16LE(56, 54);
        writeFileSync(join(library, "module.so"), elf);
        f.command("python3", [library]);
        const result = resolveDevelopmentTools(
            { python: ["python3"] },
            { path: f.bin },
        );
        expect(result.unavailable).toEqual([]);
        const roots = result.installations.python.filter(
            (entry) => entry.root === library,
        );
        expect(roots).toEqual([{ root: library, path: [] }]);
    } finally {
        f.dispose();
    }
});

test("a split Go SDK exposes its standard library symlink target", () => {
    const f = fixture();
    try {
        const sdk = join(f.root, "sdk"),
            standardLibrary = join(f.root, "standard-library");
        const headers = join(f.root, "sdk-headers");
        mkdirSync(headers);
        mkdirSync(join(sdk, "pkg"), { recursive: true });
        symlinkSync(headers, join(sdk, "pkg/include"));
        mkdirSync(join(sdk, "bin"), { recursive: true });
        mkdirSync(standardLibrary);
        symlinkSync(standardLibrary, join(sdk, "src"));
        writeFileSync(join(sdk, "bin/go"), "#!/bin/sh\nexit 0\n", {
            mode: 0o700,
        });
        writeFileSync(
            f.command("go"),
            `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ GOROOT: sdk, GOVERSION: "go1.2.3" })}'\n`,
            { mode: 0o700 },
        );
        const result = resolveDevelopmentTools({ go: ["go"] }, { path: f.bin });
        expect(result.unavailable).toEqual([]);
        expect(result.installations.go).toContainEqual({
            root: standardLibrary,
            path: [],
        });
        expect(result.installations.go).toContainEqual({
            root: headers,
            path: [],
        });
        rmSync(join(sdk, "src"));
        symlinkSync(f.bin, join(sdk, "src"));
        expect(() => result.assertUnchanged()).toThrow("changed after preview");
    } finally {
        f.dispose();
    }
});

const libcAlias = "/lib/x86_64-linux-gnu/libc.so.6";
test.skipIf(
    !existsSync(libcAlias) ||
        realpathSync("/lib/x86_64-linux-gnu") === "/lib/x86_64-linux-gnu",
)(
    "a canonical default library directory avoids redundant compatibility aliases",
    () => {
        const f = fixture();
        try {
            f.command("bun");
            const result = resolveDevelopmentTools(
                { bun: ["bun"] },
                { path: f.bin },
            );
            expect(result.unavailable).toEqual([]);
            const files = result.installations.bun.flatMap((entry) =>
                (entry.files ?? []).map((file) => join(entry.root, file)),
            );
            expect(files).not.toContain(libcAlias);
            expect(files).toContain(
                join(realpathSync("/lib/x86_64-linux-gnu"), "libc.so.6"),
            );
        } finally {
            f.dispose();
        }
    },
);

test("missing tools, relative PATH entries and broad resource grants are refused", () => {
    const f = fixture();
    try {
        f.command("bun", ["/usr"]);
        expect(
            resolveDevelopmentTools({ bun: ["bun"] }, { path: f.bin })
                .unavailable,
        ).toHaveLength(1);
        expect(
            resolveDevelopmentTools({ bun: ["bun"] }, { path: "relative/bin" })
                .unavailable,
        ).toHaveLength(1);
        expect(
            resolveDevelopmentTools({ python: ["python3"] }, { path: f.bin })
                .unavailable,
        ).toHaveLength(1);
        expect(() =>
            resolveDevelopmentTools({ arbitrary: ["sh"] }, { path: f.bin }),
        ).toThrow("Unsupported");
    } finally {
        f.dispose();
    }
});

test("a symlink redirected after discovery cannot be authorized", () => {
    const f = fixture();
    try {
        const first = f.command("first"),
            second = f.command("second");
        symlinkSync(first, join(f.bin, "bun"));
        const result = resolveDevelopmentTools(
            { bun: ["bun"] },
            { path: f.bin },
        );
        expect(result.unavailable).toEqual([]);
        rmSync(join(f.bin, "bun"));
        symlinkSync(second, join(f.bin, "bun"));
        expect(() => result.assertUnchanged()).toThrow("changed after preview");
    } finally {
        f.dispose();
    }
});

test("invalid stored bindings block discovery until explicit rediscovery", () => {
    const f = fixture();
    try {
        f.command("bun");
        const existing = {
            bun: [{ root: join(f.root, "missing"), path: ["bin"] }],
        };
        expect(
            resolveDevelopmentTools({ bun: ["bun"] }, { existing, path: f.bin })
                .unavailable,
        ).toHaveLength(1);
        expect(
            resolveDevelopmentTools(
                { bun: ["bun"] },
                { existing, path: f.bin, rediscover: true },
            ).unavailable,
        ).toEqual([]);
    } finally {
        f.dispose();
    }
});

test("a runtime reporting a missing library directory is unavailable without publishing stale grants", () => {
    const f = fixture();
    const original = process.env.PATH;
    try {
        f.command("python3", [join(f.root, "missing-stdlib")]);
        process.env.PATH = f.bin;
        const result = prepareDevelopmentSetup({
            agentDir: join(f.root, "agent"),
            machineId: "fixture",
            profile: { tools: { python: ["python3"] } },
        });
        expect(result.unavailable).toHaveLength(1);
        expect(() => applyDevelopmentSetup(result)).toThrow();
        expect(existsSync(join(f.root, "agent"))).toBe(false);
    } finally {
        if (original === undefined) delete process.env.PATH;
        else process.env.PATH = original;
        f.dispose();
    }
});

test("metadata failures never include command output in diagnostics", () => {
    const f = fixture();
    try {
        writeFileSync(
            join(f.bin, "go"),
            "#!/bin/sh\nprintf '%s' '{ PRIVATE_OUTPUT_CANARY'\n",
            { mode: 0o700 },
        );
        const result = resolveDevelopmentTools({ go: ["go"] }, { path: f.bin });
        expect(result.unavailable).toHaveLength(1);
        expect(JSON.stringify(result)).not.toContain("PRIVATE_OUTPUT_CANARY");
    } finally {
        f.dispose();
    }
});

test("a standard command directory is never authorized as a whole installation", () => {
    const f = fixture();
    try {
        f.command("bun", ["/usr/bin"]);
        expect(
            resolveDevelopmentTools({ bun: ["bun"] }, { path: f.bin })
                .unavailable,
        ).toHaveLength(1);
    } finally {
        f.dispose();
    }
});

test.each([
    { command: "bun", file: "bun" },
    { command: "php", file: "php8.5" },
])(
    "mise shims resolve the installed $command launcher without exposing mise",
    ({ command, file }) => {
        const f = fixture();
        const prior = {
            XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
            XDG_DATA_HOME: process.env.XDG_DATA_HOME,
            XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
            XDG_STATE_HOME: process.env.XDG_STATE_HOME,
            PI_PROBE_SECRET_CANARY: process.env.PI_PROBE_SECRET_CANARY,
        };
        try {
            for (const name of Object.keys(prior))
                process.env[name] = join(f.root, name);
            const bin = join(f.root, "installed/bin");
            mkdirSync(bin, { recursive: true });
            const executable = join(bin, file);
            const launcher = join(bin, command);
            writeFileSync(
                executable,
                `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ executable, version: "1.2.3", resources: [] })}'\n`,
                { mode: 0o700 },
            );
            if (launcher !== executable) symlinkSync(executable, launcher);
            writeFileSync(
                join(f.bin, "mise"),
                `#!/bin/sh\n[ "$MISE_AUTO_INSTALL" = 0 ] || exit 77\n[ "$1" = which ] || exit 78\n${Object.keys(
                    prior,
                )
                    .filter((name) => name.startsWith("XDG_"))
                    .map(
                        (name) =>
                            `[ "$${name}" = '${join(f.root, name)}' ] || exit 79`,
                    )
                    .join(
                        "\n",
                    )}\n[ -z "\${PI_PROBE_SECRET_CANARY+x}" ] || exit 80\nprintf '%s\\n' '${launcher}'\n`,
                { mode: 0o700 },
            );
            symlinkSync(join(f.bin, "mise"), join(f.bin, command));
            const result = resolveDevelopmentTools(
                { [command]: [command] },
                { path: f.bin },
            );
            expect(result.unavailable).toEqual([]);
            expect(result.tools[0]?.executable).toBe(executable);
            expect(
                result.installations[command].some(
                    (entry) => entry.root === f.bin,
                ),
            ).toBe(false);
        } finally {
            for (const [name, value] of Object.entries(prior)) {
                if (value === undefined) delete process.env[name];
                else process.env[name] = value;
            }
            f.dispose();
        }
    },
);

test("a misleading shared-library symlink cannot authorize unrelated host data", () => {
    const f = fixture();
    try {
        const library = join(f.root, "stdlib");
        mkdirSync(library);
        const unrelated = join(f.root, "unrelated-data");
        writeFileSync(unrelated, "PRIVATE_FIXTURE_CANARY");
        symlinkSync(unrelated, join(library, "module.so"));
        f.command("python3", [library]);
        const result = resolveDevelopmentTools(
            { python: ["python3"] },
            { path: f.bin },
        );
        expect(result.unavailable).toHaveLength(1);
        expect(result.installations.python).toBeUndefined();
        expect(JSON.stringify(result)).not.toContain("PRIVATE_FIXTURE_CANARY");
    } finally {
        f.dispose();
    }
});
