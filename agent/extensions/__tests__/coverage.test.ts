import { describe, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { containsPersonalHome as containsLiteralPersonalHome } from "../../tooling/portability/oxlint-plugin.mjs";

const PORTABLE_TEXT_FILE = /\.(?:[cm]?[jt]sx?|json|py|sh|toml|ya?ml)$/i;
const TEST_FILE = /(?:^|\.)((?:integration\.)?test|spec)\.[cm]?[jt]sx?$/i;

function isPortableExecutable(file: string): boolean {
    if (file.startsWith("docs/audits/")) return false;
    if (TEST_FILE.test(path.basename(file))) return false;
    if (!PORTABLE_TEXT_FILE.test(file)) return false;
    return (
        file.startsWith(".github/") ||
        file.startsWith("agent/extensions/") ||
        file.startsWith("agent/scripts/") ||
        /^agent\/[^/]+$/.test(file)
    );
}

const agentRoot = path.resolve(import.meta.dir, "../..");

function sourceDiagnostics(
    files: string[],
): Array<{ filename: string; message: string }> {
    if (!files.length) return [];
    const result = spawnSync(
        path.join(agentRoot, "node_modules/.bin/oxlint"),
        [
            "-c",
            ".oxlintrc.portability.json",
            "--no-ignore",
            "--format",
            "json",
            ...files,
        ],
        { cwd: agentRoot, encoding: "utf8" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0 && result.status !== 1)
        throw new Error(`Portability parser failed: ${result.stderr}`);
    return JSON.parse(result.stdout).diagnostics;
}

function containsPersonalHome(text: string, filename = "source.ts"): boolean {
    if (/\.(?:[cm]?[jt]sx?)$/i.test(filename)) {
        const root = fs.mkdtempSync(path.join(tmpdir(), "pi-portability-"));
        try {
            const fixture = path.join(root, path.basename(filename));
            fs.writeFileSync(fixture, text);
            return sourceDiagnostics([fixture]).length > 0;
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    }
    // JSON has no comments. Preserve quoted values in hash-comment formats.
    if (!/\.json$/i.test(filename))
        text = text.replace(
            /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\\[^\n])|#[^\n]*/g,
            (match, quoted: string | undefined) => quoted ?? "",
        );
    return containsLiteralPersonalHome(text);
}

describe("Meta: portable executable files do not hardcode a personal home", () => {
    it("ignores JavaScript comments while retaining executable string values", () => {
        expect(
            containsPersonalHome(
                "// example: /home/dev/project\n/* /home/dev */",
            ),
        ).toBe(false);
        expect(
            containsPersonalHome(
                'const cwd = "/home/dev/project"; // /home/dev',
            ),
        ).toBe(true);
        expect(
            containsPersonalHome("const cwd = `https://host/home/dev`;"),
        ).toBe(true);
        expect(
            containsPersonalHome('const cwd = "/home/sandbox/project";'),
        ).toBe(false);
        expect(
            containsPersonalHome(
                "const text = `nested ${`value ${item}`}`; // /home/dev",
            ),
        ).toBe(false);
        expect(containsPersonalHome("const cwd = `${base}/home/dev`;")).toBe(
            true,
        );
    });

    it("ignores hash comments while retaining quoted configuration paths", () => {
        expect(
            containsPersonalHome("# example /home/dev/project", "config.yaml"),
        ).toBe(false);
        expect(
            containsPersonalHome(
                'path: "/home/dev/#project" # example',
                "config.yaml",
            ),
        ).toBe(true);
    });

    it("keeps executable paths after regex character classes", () => {
        expect(
            containsPersonalHome(
                'const pattern = /[//]/; const cwd = "/home/dev";',
            ),
        ).toBe(true);
    });

    it("contains no /home/<user> path outside fixtures and historical audits", () => {
        const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
        const trackedFiles = execFileSync("git", ["ls-files", "-z"], {
            cwd: repoRoot,
            encoding: "buffer",
        })
            .toString("utf8")
            .split("\0")
            .filter(Boolean)
            .filter(isPortableExecutable);
        const sources = trackedFiles.filter(
            (file) =>
                /\.(?:[cm]?[jt]sx?)$/i.test(file) &&
                fs.existsSync(path.join(repoRoot, file)),
        );
        expect(
            sourceDiagnostics(sources.map((file) => path.join(repoRoot, file))),
        ).toEqual([]);
        const offenders = trackedFiles
            .filter((file) => !sources.includes(file))
            .filter((file) => {
                const fullPath = path.join(repoRoot, file);
                if (!fs.existsSync(fullPath)) return false;
                if (!fs.statSync(fullPath).isFile()) return false;
                const content = fs.readFileSync(fullPath);
                return (
                    !content.includes(0) &&
                    containsPersonalHome(content.toString("utf8"), file)
                );
            });

        expect(offenders).toEqual([]);
    });
});
