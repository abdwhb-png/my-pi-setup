import { afterEach, beforeEach, expect, test, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let root: string;
let config: string;
let output: string;
let binary: string;
setDefaultTimeout(45000);
beforeEach(() => {
 root = mkdtempSync(join(tmpdir(), "pi-launch-profiles-"));
 config = join(root, "agent", "config", "launch-profiles.json");
 output = join(root, "args.json");
 binary = join(root, "fake-pi");
 mkdirSync(join(root, "agent", "config"), { recursive: true });
 writeFileSync(binary, '#!/usr/bin/env bun\nimport { writeFileSync } from "node:fs"; writeFileSync(process.env.PROFILE_TEST_OUTPUT, JSON.stringify(process.argv.slice(2)));');
 chmodSync(binary, 0o755);
 writeFileSync(config, JSON.stringify({ profiles: { lean: { excludeExtensions: ["notify", "builtin:mcp"] } } }));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function launch(args: string[]) {
 return spawnSync(process.execPath, [resolve(import.meta.dir, "../../bin/pi"), ...args], {
  cwd: root, encoding: "utf8", timeout: 20000,
  env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent"), PI_REAL_BIN: binary,
   PI_PACKAGE_FINALIZER_ACTIVE: "1", PROFILE_TEST_OUTPUT: output },
 });
}
test("the launcher expands a configured profile before passing untouched Pi arguments", () => {
 const before = readFileSync(config, "utf8");
 const result = launch(["--profile", "lean", "--exclude-extension", "other", "--", "--profile", "literal"]);
 expect(result.status).toBe(0);
 expect(JSON.parse(readFileSync(output, "utf8"))).toEqual([
  "--exclude-extension", "notify", "--exclude-extension", "builtin:mcp", "--exclude-extension", "other", "--", "--profile", "literal",
 ]);
 expect(readFileSync(config, "utf8")).toBe(before);
});
test("unknown and missing profile names stop before starting Pi", () => {
 for (const args of [["--profile", "unknown"], ["--profile"]]) {
  const result = launch(args);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("profile");
  expect(existsSync(output)).toBe(false);
 }
});
test("an ordinary invocation does not read profile configuration or consume Pi values", () => {
 writeFileSync(config, "invalid JSON");
 const args = ["--system-prompt", "--profile", "text"];
 expect(launch(args).status).toBe(0);
 expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(args);
});
test("invalid profile entries fail visibly without starting Pi", () => {
 writeFileSync(config, JSON.stringify({ profiles: { lean: { excludeExtensions: [false] } } }));
 expect(launch(["--profile", "lean"]).status).toBe(2);
 expect(existsSync(output)).toBe(false);
});

test("a misplaced profile flag is rejected while a prompt value remains literal", () => {
    const result = launch(["--offline", "--profile", "lean"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("before");
    expect(existsSync(output)).toBe(false);
});

test("top-level help documents launch profiles even when extensions are disabled and config is invalid", () => {
    writeFileSync(config, "invalid JSON");
    const result = launch(["--help", "--no-extensions"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--profile <name>");
    expect(result.stdout).toContain("before other Pi options");
    expect(result.stdout).toContain("/profiles edit");
    expect(result.stdout).toContain("launch-profiles.json");
    expect(result.stdout).toContain(config);
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(["--help", "--no-extensions"]);
});

test("help tokens in argument values, prompts or subcommands do not print launcher help", () => {
    // Bun consumes a delimiter immediately after the script path; an option keeps Pi's delimiter intact.
    for (const args of [["--system-prompt", "--help"], ["--offline", "--", "--help"], ["config", "--help"]]) {
        const result = launch(args);
        expect(result.status).toBe(0);
        expect(result.stdout).not.toContain("--profile <name>");
        expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(args);
    }
});

test.skipIf(!process.env.PI_LAUNCH_PROFILES_RUNTIME_BINARY)("the promoted Bun runtime never imports an excluded entrypoint", () => {
    binary = process.env.PI_LAUNCH_PROFILES_RUNTIME_BINARY!;
    const path = join(root, "agent", "notify.ts");
    writeFileSync(path, 'throw new Error("PROFILE_EXCLUDED_ENTRYPOINT_EXECUTED"); export default function() {}');
    writeFileSync(config, JSON.stringify({ profiles: { lean: { excludeExtensions: [path, "builtin:mcp"] } } }));
    const args = ["--help", "--offline", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "-e", path, "-e", "builtin:mcp"];
    const baseline = launch(args);
    expect(baseline.status).toBe(0);
    expect(baseline.stderr).toContain("PROFILE_EXCLUDED_ENTRYPOINT_EXECUTED");
    const result = launch(["--profile", "lean", ...args]);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("PROFILE_EXCLUDED_ENTRYPOINT_EXECUTED");
    expect(result.stderr).not.toContain("Unknown extension exclusion");
    expect(result.stdout).toContain("--exclude-extension");
    expect(result.stdout).toContain("--profile <name>");
    expect(result.stdout).toContain("/profiles edit");
});
