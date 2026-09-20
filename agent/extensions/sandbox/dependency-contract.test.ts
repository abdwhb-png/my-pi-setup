import { describe, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const QUICKJS_VERSION = "3.1.0";
const ERYX_VERSION = "0.6.0";
const QUICKJS_VARIANT_VERSION = "0.32.0";
const AGENT_TYPESCRIPT_VERSION = "7.0.2";
const SANDBOX_TYPESCRIPT_API_VERSION = "6.0.3";
const SANDBOX_TYPESCRIPT_NATIVE_VERSION = "7.0.2";
const ZEROBOX_VERSION = "0.3.3-fork.17";
const OMITTED_OPTIONAL_PATCH = "scripts/upstream-no-preemptive-codex-protect.patch";
const candidateBinary = process.env.PI_SANDBOX_ZEROBOX_BINARY;
const candidateSha = process.env.PI_SANDBOX_ZEROBOX_SHA256;
const candidateSource = process.env.PI_SANDBOX_ZEROBOX_SOURCE_ROOT;

interface ZeroboxManifest {
    version: string;
    binarySha256: string;
    patches: Array<{ path: string; sha256: string }>;
    omittedOptionalPatches: string[];
    localBuild: { kind: string; baseCommit: string; sourceDiffSha256: string; sourceDiffFormat: string };
}
async function readProvenance(): Promise<ZeroboxManifest> {
    return Bun.file(new URL("./runtime/zerobox-provenance.json", import.meta.url)).json();
}

interface SandboxPackageJson {
    dependencies?: Record<string, string>;
}

interface AgentPackageJson {
    devDependencies?: Record<string, string>;
    trustedDependencies?: string[];
}

async function readSandboxPackage(): Promise<SandboxPackageJson> {
    return Bun.file(new URL("./package.json", import.meta.url)).json();
}

describe("sandbox dependency contract", () => {
    it("exact-pins the audited WASM runtimes and excludes ASRT", async () => {
        const packageJson = await readSandboxPackage();

        expect(packageJson.dependencies).toMatchObject({
            "@bsull/eryx": ERYX_VERSION,
            "@jitl/quickjs-ng-wasmfile-release-sync": QUICKJS_VARIANT_VERSION,
            "@sebastianwessel/quickjs": QUICKJS_VERSION,
        });

        const lock = await readFile(new URL("./bun.lock", import.meta.url), "utf8");
        expect(packageJson.dependencies).not.toHaveProperty(
            "@anthropic-ai/sandbox-runtime",
        );
        expect(lock).not.toContain("@anthropic-ai/sandbox-runtime@");
        expect(lock).toContain(
            `@sebastianwessel/quickjs@${QUICKJS_VERSION}`,
        );
        expect(lock).toContain(`@bsull/eryx@${ERYX_VERSION}`);
        expect(lock).toContain(
            `@jitl/quickjs-ng-wasmfile-release-sync@${QUICKJS_VARIANT_VERSION}`,
        );
        expect(packageJson.dependencies).toMatchObject({
            "@typescript/native": `npm:typescript@${SANDBOX_TYPESCRIPT_NATIVE_VERSION}`,
            typescript: SANDBOX_TYPESCRIPT_API_VERSION,
        });
        expect(lock).toContain(`typescript@${SANDBOX_TYPESCRIPT_API_VERSION}`);
        expect(lock).toContain(`typescript@${SANDBOX_TYPESCRIPT_NATIVE_VERSION}`);
        expect(lock).not.toContain("zerobox@");
    });

    it("maintains only TypeScript 7 at the agent root", async () => {
        const agentPackage: AgentPackageJson = await Bun.file(
            new URL("../../package.json", import.meta.url),
        ).json();
        expect(agentPackage.devDependencies?.typescript).toBe(
            AGENT_TYPESCRIPT_VERSION,
        );
        expect(agentPackage.devDependencies).not.toHaveProperty("typescript-7");
        expect(agentPackage).not.toHaveProperty("trustedDependencies");
        expect(
            await Bun.file(new URL("../../bun.lock", import.meta.url)).text(),
        ).not.toContain('"trustedDependencies"');
        const tsc = fileURLToPath(
            new URL("../../node_modules/.bin/tsc", import.meta.url),
        );
        expect(execFileSync(tsc, ["--version"], { encoding: "utf8" }).trim()).toBe(
            `Version ${AGENT_TYPESCRIPT_VERSION}`,
        );
    });

    it("keeps the TypeScript 6 API beside the TypeScript 7 native compiler", async () => {
        const resolved = import.meta.resolve("typescript");
        expect(resolved).toContain("/extensions/sandbox/node_modules/typescript/");
        const typescript = await import("typescript");
        expect(typescript.version).toBe(SANDBOX_TYPESCRIPT_API_VERSION);

        const tsc6 = fileURLToPath(
            new URL("./node_modules/typescript/bin/tsc", import.meta.url),
        );
        const tsc7 = fileURLToPath(
            new URL("./node_modules/@typescript/native/bin/tsc", import.meta.url),
        );
        expect(execFileSync(tsc6, ["--version"], { encoding: "utf8" }).trim()).toBe(
            `Version ${SANDBOX_TYPESCRIPT_API_VERSION}`,
        );
        expect(execFileSync(tsc7, ["--version"], { encoding: "utf8" }).trim()).toBe(
            `Version ${SANDBOX_TYPESCRIPT_NATIVE_VERSION}`,
        );
    });

    it("records an explicit local-build provenance without claiming an immutable release", async () => {
        const provenance = await readProvenance();
        expect(provenance).toMatchObject({
            version: ZEROBOX_VERSION,
            upstreamTag: "v0.3.3",
            upstreamCommit: "9a7affd6c68fb2541c7c709559c40e08ba0a1872",
            engineRef: "rust-v0.131.0-alpha.22",
            engineCommit: "9b8cf56cdefb09f54564ccc295fd42f6647f558f",
            binaryName: "zerobox",
            localBuild: {
                kind: "modified-worktree",
                baseCommit: "ebd12774aafa63fec1864e04f248150ec50136d4",
                sourceDiffFormat: "git-diff-binary-head-plus-sorted-untracked-v1",
            },
        });
        expect(provenance).not.toHaveProperty("tag");
        expect(provenance).not.toHaveProperty("forkCommit");
        expect(provenance.binarySha256).toMatch(/^[a-f0-9]{64}$/);
        expect(provenance.localBuild.sourceDiffSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(provenance.patches.length).toBeGreaterThan(0);
        expect(provenance.omittedOptionalPatches).toEqual([OMITTED_OPTIONAL_PATCH]);
        expect(provenance.patches.some(patch => patch.path === OMITTED_OPTIONAL_PATCH)).toBe(false);
        expect(new Set(provenance.patches.map(patch => patch.path)).size).toBe(provenance.patches.length);
        for (const patch of provenance.patches) {
            expect(patch.path).toMatch(/^scripts\/upstream-[a-z0-9-]+\.patch$/);
            expect(patch.sha256).toMatch(/^[a-f0-9]{64}$/);
        }
    });

    it.skipIf(!candidateBinary || !candidateSha)("qualifies only the explicitly supplied candidate binary", async () => {
        if (!candidateBinary || !candidateSha) throw new Error("Explicit candidate binary and SHA256 required");
        const provenance = await readProvenance();
        const binary = await readFile(candidateBinary);
        expect((await stat(candidateBinary)).mode & 0o111).not.toBe(0);
        const actualSha = createHash("sha256").update(binary).digest("hex");
        expect(actualSha).toBe(candidateSha);
        expect(actualSha).toBe(provenance.binarySha256);
        expect(execFileSync(candidateBinary, ["--version"], { encoding: "utf8" }).trim()).toBe(`zerobox ${ZEROBOX_VERSION}`);
    });

    it.skipIf(!candidateSource)("verifies the explicit source worktree digest and ordered patch bytes", async () => {
        if (!candidateSource) throw new Error("Explicit candidate source root required");
        const provenance = await readProvenance();
        const source = resolve(candidateSource);
        const gitOptions = { cwd: source, maxBuffer: 64 * 1024 * 1024 };
        expect(execFileSync("git", ["rev-parse", "HEAD"], { ...gitOptions, encoding: "utf8" }).trim()).toBe(provenance.localBuild.baseCommit);
        const digest = createHash("sha256");
        digest.update(execFileSync("git", ["diff", "--binary", "HEAD"], gitOptions));
        const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: source, encoding: "utf8" }).split("\0").filter(Boolean).sort();
        for (const path of untracked) {
            const diff = spawnSync("git", ["diff", "--no-index", "--binary", "/dev/null", path], gitOptions);
            expect(diff.error).toBeUndefined();
            expect(diff.status).toBe(1);
            digest.update(diff.stdout);
        }
        expect(digest.digest("hex")).toBe(provenance.localBuild.sourceDiffSha256);
        const syncScript = await readFile(join(source, "scripts/sync.sh"), "utf8");
        const referencedPatches = [...new Set([...syncScript.matchAll(/\bupstream-[a-z0-9-]+\.patch\b/g)].map(match => `scripts/${match[0]}`))];
        expect(provenance.omittedOptionalPatches).toEqual([OMITTED_OPTIONAL_PATCH]);
        const presentPatches = provenance.patches.map(patch => patch.path);
        expect(new Set(presentPatches).size).toBe(presentPatches.length);
        expect(presentPatches.some(path => provenance.omittedOptionalPatches.includes(path))).toBe(false);
        expect([...presentPatches, ...provenance.omittedOptionalPatches].sort()).toEqual([...referencedPatches].sort());
        expect(presentPatches).toEqual(referencedPatches.filter(path => !provenance.omittedOptionalPatches.includes(path)));
        for (const path of provenance.omittedOptionalPatches) {
            await expect(stat(join(source, path))).rejects.toMatchObject({ code: "ENOENT" });
        }
        const positions: number[] = [];
        for (const patch of provenance.patches) {
            const path = resolve(source, patch.path);
            expect(path.startsWith(source + sep)).toBe(true);
            expect(createHash("sha256").update(await readFile(path)).digest("hex"), patch.path).toBe(patch.sha256);
            positions.push(syncScript.indexOf(patch.path.slice(patch.path.lastIndexOf("/") + 1)));
        }
        expect(positions.every(position => position >= 0)).toBe(true);
        expect(positions).toEqual([...positions].sort((a, b) => a - b));
    });

    it("keeps the legacy ASRT deny characterization reproducible", async () => {
        const [artifact, script] = await Promise.all([
            Bun.file(
                new URL(
                    "./runtime/legacy-asrt-deny-characterization.json",
                    import.meta.url,
                ),
            ).json(),
            Bun.file(
                new URL(
                    "./runtime/scripts/legacy-asrt-deny-characterization.ts",
                    import.meta.url,
                ),
            ).text(),
        ]);
        expect(artifact).toMatchObject({
            schemaVersion: 1,
            host: { platform: "linux", arch: "x64" },
            asrt: {
                name: "@anthropic-ai/sandbox-runtime",
                version: "0.0.74",
                packageJsonSha256:
                    "56b6e8e64776210c40f5029df175bf168b6515d624aa52166a0480643accce76",
                entrypointSha256:
                    "febc550020ba8a69ac730337f6518409a5eb4e44a42c2814006a23fbc8a828d8",
            },
        });
        expect(
            artifact.results.map(
                (result: {
                    pattern: string;
                    targetWriteExit: number;
                    controlWriteExit: number;
                }) => [
                    result.pattern,
                    result.targetWriteExit,
                    result.controlWriteExit,
                ],
            ),
        ).toEqual([
            [".env", 1, 0],
            [".env.*", 0, 0],
            ["*.pem", 0, 0],
            ["*.key", 0, 0],
            ["*/node_modules/*", 0, 0],
        ]);
        expect(script).toContain("ASRT_PACKAGE_ROOT");
        expect(script).toContain("SandboxManager.wrapWithSandbox");
    });

    it("executes JavaScript and TypeScript through QuickJS", async () => {
        const [{ loadQuickJs }, { default: variant }] = await Promise.all([
            import("@sebastianwessel/quickjs"),
            import("@jitl/quickjs-ng-wasmfile-release-sync"),
        ]);
        const { runSandboxed } = await loadQuickJs(variant);

        const javascript = await runSandboxed(({ evalCode }) =>
            evalCode("export default 21 * 2"),
        );
        expect(javascript).toMatchObject({ ok: true, data: 42 });

        const typescript = await runSandboxed(
            ({ evalCode }) =>
                evalCode(
                    "const value: number = 6 * 7; export default value",
                ),
            { transformTypescript: true },
        );
        expect(typescript).toMatchObject({ ok: true, data: 42 });
    });

    it("executes Python through Eryx with Node JSPI", async () => {
        const script = [
            'import { Sandbox } from "@bsull/eryx";',
            "const sandbox = new Sandbox();",
            'const result = await sandbox.execute("print(6 * 7)");',
            "process.stdout.write(result.stdout);",
        ].join("\n");
        const loaderPath = fileURLToPath(
            new URL("./analysis/eryx-loader.mjs", import.meta.url),
        );
        const child = Bun.spawn(
            [
                "node",
                "--experimental-wasm-jspi",
                "--experimental-loader",
                loaderPath,
                "--input-type=module",
                "--eval",
                script,
            ],
            {
                cwd: import.meta.dir,
                env: { PATH: process.env.PATH ?? "" },
                stdin: "ignore",
                stdout: "pipe",
                stderr: "pipe",
            },
        );

        const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
        ]);

        expect(exitCode, stderr).toBe(0);
        expect(stdout.trim()).toBe("42");
    });
});
