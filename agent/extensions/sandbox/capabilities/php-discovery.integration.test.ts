import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    copyFileSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDevelopmentTools } from "../development-tools.ts";

test.skipIf(process.env.PI_PHP_DISCOVERY_CONTRACT !== "1").each([true, false])(
    "PHP discovery keeps loaded resources when its extension search directory exists=%s",
    (extensionsExist) => {
        const root = mkdtempSync(join(tmpdir(), "pi-php-discovery-"));
        try {
            const installed = Bun.which("php");
            if (!installed)
                throw new Error(
                    "PHP is required for the explicit discovery contract",
                );
            const metadata = spawnSync(
                installed,
                ["-n", "-r", "echo PHP_BINARY;"],
                {
                    encoding: "utf8",
                },
            );
            expect(metadata.status).toBe(0);
            const bin = join(root, "bin");
            const runtime = join(root, "runtime");
            const include = join(root, "existing-include");
            const missing = join(root, "absent-include");
            const extensions = join(root, "extensions");
            const scan = join(root, "scan");
            for (const path of [bin, runtime, include, scan]) mkdirSync(path);
            if (extensionsExist) mkdirSync(extensions);
            const binary = join(runtime, "php");
            copyFileSync(metadata.stdout.trim(), binary);
            const ini = join(root, "php.ini");
            writeFileSync(
                ini,
                `include_path=".:${missing}:${include}"\nextension_dir="${extensions}"\n`,
            );
            writeFileSync(
                join(bin, "php"),
                `#!/bin/sh\nexport PHP_INI_SCAN_DIR='${scan}'\nexec '${binary}' -c '${ini}' "$@"\n`,
                { mode: 0o700 },
            );
            const result = resolveDevelopmentTools(
                { php: ["php"] },
                { path: bin },
            );
            expect(result.unavailable).toEqual([]);
            expect(result.tools).toContainEqual(
                expect.objectContaining({ command: "php", executable: binary }),
            );
            expect(result.installations.php).toContainEqual({
                root: include,
                path: [],
            });
            expect(
                result.installations.php.some(
                    (entry) => entry.root === extensions,
                ),
            ).toBe(extensionsExist);
            expect(
                result.installations.php.some(
                    (entry) => entry.root === missing,
                ),
            ).toBe(false);
            expect(
                result.installations.php.flatMap((entry) => entry.files ?? []),
            ).toContain("php.ini");
            result.assertUnchanged();
            writeFileSync(ini, "; changed configuration\n");
            expect(() => result.assertUnchanged()).toThrow(
                "changed after preview",
            );
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    },
);
