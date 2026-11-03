import { test, expect } from "bun:test";
import {
    mkdtempSync,
    mkdirSync,
    writeFileSync,
    rmSync,
    existsSync,
    chmodSync,
    realpathSync,
    renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { symlinkSync } from "node:fs";
import { resolveDevelopmentTools } from "../development-tools.ts";

function fixture() {
    const root = mkdtempSync(join(tmpdir(), "pi-tools-fixture-"));
    const bin = join(root, "prefix/bin");
    mkdirSync(bin, { recursive: true });
    return {
        root,
        bin,
        command(
            name: string,
            resources: string[] = [],
            reportedExecutable?: string,
        ) {
            const executable = join(bin, name);
            writeFileSync(
                executable,
                `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ executable: reportedExecutable ?? executable, version: "1.2.3", resources })}'\n`,
                { mode: 0o700 },
            );
            return executable;
        },
        dispose() {
            rmSync(root, { recursive: true, force: true });
        },
    };
}

const commands = ["node", "bun", "python3", "go", "php", "composer", "pnpm"];

test.each(commands)(
    "mise rejects an unsafe %s target before running its metadata probe",
    (command) => {
        const f = fixture();
        try {
            const runtime = join(f.root, "actual");
            mkdirSync(runtime);
            const binary = join(runtime, command);
            const marker = join(f.root, "unsafe-target-ran");
            writeFileSync(
                binary,
                `#!/bin/sh\nprintf ran > '${marker}'\nprintf '%s\\n' '${JSON.stringify({ executable: binary, version: "1.2.3", resources: [] })}'\n`,
                { mode: 0o777 },
            );
            chmodSync(binary, 0o777);
            const mise = join(f.bin, "mise");
            writeFileSync(mise, `#!/bin/sh\nprintf '%s\\n' '${binary}'\n`, {
                mode: 0o700,
            });
            symlinkSync(mise, join(f.bin, command));
            const result = resolveDevelopmentTools(
                { tools: [command] },
                { path: f.bin },
            );
            expect(result.unavailable).toHaveLength(1);
            expect(existsSync(marker)).toBe(false);
        } finally {
            f.dispose();
        }
    },
);

test.each(commands)(
    "%s discovery validates the resolved executable behind a launcher",
    (command) => {
        const f = fixture();
        try {
            const runtime = join(f.root, "actual");
            mkdirSync(runtime);
            const binary = join(runtime, command);
            writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
            f.command(command, [], binary);
            expect(
                resolveDevelopmentTools({ tools: [command] }, { path: f.bin })
                    .unavailable,
            ).toHaveLength(1);
        } finally {
            f.dispose();
        }
    },
);

test.each(commands)(
    "retained %s bindings reject a command that lost execution permission",
    (command) => {
        const f = fixture();
        try {
            const binary = f.command(command);
            const fresh = resolveDevelopmentTools(
                { tools: [command] },
                { path: f.bin },
            );
            expect(fresh.unavailable).toEqual([]);
            chmodSync(binary, 0o600);
            const reused = resolveDevelopmentTools(
                { tools: [command] },
                { existing: fresh.installations, path: f.bin },
            );
            expect(reused.unavailable).toHaveLength(1);
            expect(reused.installations.tools).toBeUndefined();
            expect(reused.unavailable[0].reason).toContain(command);
        } finally {
            f.dispose();
        }
    },
);

test.each(commands)(
    "retained %s bindings stay valid independently of the ambient PATH",
    (command) => {
        const f = fixture();
        try {
            f.command(command);
            const fresh = resolveDevelopmentTools(
                { tools: [command] },
                { path: f.bin },
            );
            const retained = resolveDevelopmentTools(
                { tools: [command] },
                { existing: fresh.installations, path: join(f.root, "absent") },
            );
            expect(retained.unavailable).toEqual([]);
            expect(retained.installations).toEqual(fresh.installations);
            retained.assertUnchanged();
            chmodSync(join(f.bin, command), 0o600);
            expect(() => retained.assertUnchanged()).toThrow(
                "changed after preview",
            );
        } finally {
            f.dispose();
        }
    },
);

test.each(commands)(
    "retained %s bindings reject unsafe commands without PATH fallback",
    (command) => {
        const f = fixture();
        try {
            const binary = f.command(command);
            const fresh = resolveDevelopmentTools(
                { tools: [command] },
                { path: f.bin },
            );
            const fallback = join(f.root, "fallback");
            mkdirSync(fallback);
            writeFileSync(join(fallback, command), "#!/bin/sh\nexit 77\n", {
                mode: 0o700,
            });
            chmodSync(binary, 0o777);
            const retained = resolveDevelopmentTools(
                { tools: [command] },
                { existing: fresh.installations, path: fallback },
            );
            expect(retained.unavailable).toHaveLength(1);
            expect(retained.unavailable[0].reason).toContain(
                "Untrusted writable executable",
            );
            expect(retained.installations.tools).toBeUndefined();
            rmSync(binary);
            expect(
                resolveDevelopmentTools(
                    { tools: [command] },
                    { existing: fresh.installations, path: fallback },
                ).unavailable,
            ).toHaveLength(1);
        } finally {
            f.dispose();
        }
    },
);

test.each(commands)(
    "explicit %s bindings cannot expose an unselected file",
    (command) => {
        const f = fixture();
        try {
            f.command(command);
            f.command("unrelated");
            const result = resolveDevelopmentTools(
                { tools: [command] },
                {
                    overrides: {
                        tools: [
                            { root: f.bin, path: ["."], files: ["unrelated"] },
                        ],
                    },
                    path: f.bin,
                },
            );
            expect(result.unavailable).toHaveLength(1);
            expect(result.installations.tools).toBeUndefined();
        } finally {
            f.dispose();
        }
    },
);

test.each(commands)(
    "%s discovery refuses missing required resources and broad grants",
    (command) => {
        const f = fixture();
        try {
            f.command(command, [join(f.root, "missing-required")]);
            const missing = resolveDevelopmentTools(
                { tools: [command] },
                { path: f.bin },
            );
            expect(missing.unavailable).toHaveLength(1);
            expect(missing.unavailable[0].reason).toContain("missing-required");
            f.command(command, ["/usr"]);
            const broad = resolveDevelopmentTools(
                { tools: [command] },
                { path: f.bin },
            );
            expect(broad.unavailable).toHaveLength(1);
            expect(broad.unavailable[0].reason).toContain(
                "Refusing broad installation root",
            );
        } finally {
            f.dispose();
        }
    },
);

test.each(commands)(
    "retained %s bindings reject redirected command aliases",
    (command) => {
        const f = fixture();
        try {
            const alias = f.command(command);
            const original = join(f.bin, "original");
            renameSync(alias, original);
            symlinkSync(original, alias);
            const fresh = resolveDevelopmentTools(
                { tools: [command] },
                { path: f.bin },
            );
            expect(fresh.unavailable).toEqual([]);
            const outside = join(f.root, "outside-command");
            writeFileSync(outside, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
            rmSync(alias);
            symlinkSync(outside, alias);
            const reused = resolveDevelopmentTools(
                { tools: [command] },
                { existing: fresh.installations, path: f.bin },
            );
            expect(reused.unavailable).toHaveLength(1);
            expect(reused.installations.tools).toBeUndefined();
        } finally {
            f.dispose();
        }
    },
);

test.each(commands)(
    "%s discovery reports malformed metadata and missing commands without leaking output",
    (command) => {
        const f = fixture();
        try {
            const binary = f.command(command);
            writeFileSync(
                binary,
                "#!/bin/sh\nprintf '%s' 'PRIVATE_METADATA_CANARY'\n",
            );
            const malformed = resolveDevelopmentTools(
                { tools: [command] },
                { path: f.bin },
            );
            expect(malformed.unavailable).toHaveLength(1);
            expect(JSON.stringify(malformed)).not.toContain(
                "PRIVATE_METADATA_CANARY",
            );
            const missing = resolveDevelopmentTools(
                { tools: [command] },
                { path: join(f.root, "no-tools") },
            );
            expect(missing.unavailable).toHaveLength(1);
            expect(missing.unavailable[0].reason).toContain(command);
        } finally {
            f.dispose();
        }
    },
);

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

test("fresh discovery failures do not recommend rediscovering stale bindings", () => {
    const f = fixture();
    try {
        f.command("python3", [join(f.root, "missing-stdlib")]);
        const result = resolveDevelopmentTools(
            { python: ["python3"] },
            { path: f.bin },
        );
        expect(result.unavailable).toHaveLength(1);
        expect(result.unavailable[0].reason).toContain("missing-stdlib");
        expect(result.unavailable[0].reason).not.toContain("--rediscover");
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
        const stale = resolveDevelopmentTools(
            { bun: ["bun"] },
            { existing, path: f.bin },
        );
        expect(stale.unavailable).toHaveLength(1);
        expect(stale.unavailable[0].reason).toContain("--rediscover");
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
