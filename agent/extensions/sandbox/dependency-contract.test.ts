import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const QUICKJS_VERSION = "3.1.0";
const ERYX_VERSION = "0.6.0";
const QUICKJS_VARIANT_VERSION = "0.32.0";
const AGENT_TYPESCRIPT_VERSION = "7.0.2";
const SANDBOX_TYPESCRIPT_API_VERSION = "6.0.3";
const SANDBOX_TYPESCRIPT_NATIVE_VERSION = "7.0.2";
const ZEROBOX_VERSION = "0.3.3-fork.8";
const ZEROBOX_SHA256 =
    "1623212b538f642c308250504c7a3ec6854471679e75dd4ff63b2d2bef43fcbb";
const MANAGED_ZEROBOX_PATH = join(homedir(), ".pi", "bin", "zerobox");
const ZEROBOX_SOURCE_ROOT = join(
    homedir(),
    "projects",
    "shared-services",
    "sandboxes",
    "zerobox",
);
const ZEROBOX_SOURCE_COMMIT = "bcca4760e36c576f482385031c42a74ba69c374f";
const PREVIOUS_ZEROBOX_ROLLBACK_ROOT = join(
    homedir(),
    ".local",
    "state",
    "pi",
    "rollback",
    "zerobox-fork.6-af290ad53ca67",
);

const EXPECTED_PATCHES = [
    ["scripts/upstream-secret-substitution.patch", "0af64b5861c921fc348f06c2d44f8ff0945681318bb7c478644c1e31712e7e39"],
    ["scripts/upstream-platform-defaults.patch", "38c04da92357dc542bdf3f364e14290914c5797f3253fb60984dec68e1bd8c8a"],
    ["scripts/upstream-deny-default-write.patch", "3c8f5177cd771ce0c580114a2552b7afa4e946dfb8dc976af69ddd4a90882e43"],
    ["scripts/upstream-zerobox-home-env.patch", "4e1e94732070acb2a817744d5b0b6c7f02aca7742775abf7d68b1647a0412440"],
    ["scripts/upstream-node-env-proxy.patch", "2d8760cb385fd1318b407d377bd1ff683ce07c602e03252bfe5e65dda489d268"],
    ["scripts/upstream-proxy-zombie-cleanup.patch", "0583c46be0db369917487058c4d2c5495b82a8a62db447d5b7f32827d9a64c50"],
    ["scripts/upstream-bwrap-fixes.patch", "f0d210a9bf3c60dbd7976033c414b8669c916b707e58871207eb272e457a27d5"],
    ["scripts/upstream-strict-bwrap.patch", "ce1ae44f0d60f1d99ab4db8d88ffa3e11ec97a4ebb8b11a2b42a4ed06515689a"],
    ["scripts/upstream-network-hardening.patch", "b207131c8a2727a50d37e88897ec3d2285abcf60e619d9cdd86eba36b81bd6ec"],
    ["scripts/upstream-proxy-root-plumbing.patch", "8bd66c8be1cb1adc46d850654c6880eb2b6d6cd253666223d2da79d5dc8963ca"],
    ["scripts/upstream-setup-status.patch", "277572af04f7153b39fe88ab0bf7c30074b7b58810211051d077cbd1926c59e0"],
    ["scripts/upstream-setup-supervisor-hardening.patch", "f6095ae940d141113a027fd1f08de84a3a602b6af42ccd4effb1924743dd9525"],
    ["scripts/upstream-setup-protocol-testing.patch", "06569ebf2316e3e34105475fae7b5ad9357a80687ec220633c4fd2d437062e5c"],
    ["scripts/upstream-setup-postfork-errors.patch", "628c4cf59986e8ffed51d3337cb1d6978f64bb6d1c021c33c53d413a71c71d1b"],
    ["scripts/upstream-setup-signal-order-test.patch", "4956ec05e970a714c37633705f9cc415c2e0f8790f4cf1d80cb9638dc19060cc"],
    ["scripts/upstream-setup-signal-window.patch", "9a039d2259823bdfbb92c196510ebd817ff478fd8f752fd61e013d39b9c864ca"],
    ["scripts/upstream-proxy-routed-socket-filter.patch", "efc4447ceb0ce882978641e4c4176c0f077319b5f3c5c041baebed63d770511b"],
    ["scripts/upstream-readable-carveouts.patch", "8031c86792a007ee569850b516c911d5e355bda5c90f13ff450c99c267e0f9e7"],
    ["scripts/upstream-target-env-isolation.patch", "bf1f8a45cc22ced5fef03ccb7a4a898b859179d762e3cd6bf65a206681e6b6e6"],
    ["scripts/upstream-readable-carveout-fd.patch", "ea36a3079bc2529a987ff7cbae96bc68570242ae9cc90da0895b7295a2a73a5e"],
].map(([path, sha256]) => ({ path, sha256 }));

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

    it("pins the accepted Zerobox provenance and managed binary", async () => {
        const provenance: unknown = await Bun.file(
            new URL("./runtime/zerobox-provenance.json", import.meta.url),
        ).json();
        expect(provenance).toEqual({
            version: ZEROBOX_VERSION,
            tag: "v0.3.3-fork.8",
            forkCommit: "bcca4760e36c576f482385031c42a74ba69c374f",
            upstreamTag: "v0.3.3",
            upstreamCommit: "9a7affd6c68fb2541c7c709559c40e08ba0a1872",
            engineRef: "rust-v0.131.0-alpha.22",
            engineCommit: "9b8cf56cdefb09f54564ccc295fd42f6647f558f",
            patches: EXPECTED_PATCHES,
            binaryName: "zerobox",
            binarySha256: ZEROBOX_SHA256,
        });

        const binary = await readFile(MANAGED_ZEROBOX_PATH);
        const metadata = await stat(MANAGED_ZEROBOX_PATH);
        expect(metadata.mode & 0o777).toBe(0o755);
        expect(createHash("sha256").update(binary).digest("hex")).toBe(
            ZEROBOX_SHA256,
        );
        expect(
            execFileSync(MANAGED_ZEROBOX_PATH, ["--version"], {
                encoding: "utf8",
            }).trim(),
        ).toBe(`zerobox ${ZEROBOX_VERSION}`);
    });

    it("derives the release manifest from the immutable tagged source", async () => {
        expect(
            execFileSync(
                "git",
                ["rev-parse", "v0.3.3-fork.8^{commit}"],
                { cwd: ZEROBOX_SOURCE_ROOT, encoding: "utf8" },
            ).trim(),
        ).toBe(ZEROBOX_SOURCE_COMMIT);
        for (const patch of EXPECTED_PATCHES) {
            const bytes = execFileSync(
                "git",
                ["show", `${ZEROBOX_SOURCE_COMMIT}:${patch.path}`],
                { cwd: ZEROBOX_SOURCE_ROOT, encoding: "buffer" },
            );
            expect(
                createHash("sha256").update(bytes).digest("hex"),
                patch.path,
            ).toBe(patch.sha256);
        }
        const syncScript = execFileSync(
            "git",
            ["show", `${ZEROBOX_SOURCE_COMMIT}:scripts/sync.sh`],
            { cwd: ZEROBOX_SOURCE_ROOT, encoding: "utf8" },
        );
        expect(syncScript).toContain(
            "upstream-proxy-routed-socket-filter.patch",
        );
        expect(syncScript).toContain("upstream-readable-carveouts.patch");
        expect(syncScript).toContain("upstream-target-env-isolation.patch");
        expect(syncScript).toContain("upstream-readable-carveout-fd.patch");
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
                    "./runtime/legacy-asrt-deny-characterization.ts",
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

    it("keeps the previous managed Zerobox release recoverable as one unit", async () => {
        const previousBinary = join(PREVIOUS_ZEROBOX_ROLLBACK_ROOT, "zerobox");
        const previousProvenancePath = join(
            PREVIOUS_ZEROBOX_ROLLBACK_ROOT,
            "zerobox-provenance.json",
        );
        const [binary, provenanceBytes, manifest] = await Promise.all([
            readFile(previousBinary),
            readFile(previousProvenancePath),
            readFile(join(PREVIOUS_ZEROBOX_ROLLBACK_ROOT, "MANIFEST.md"), "utf8"),
        ]);
        const previousProvenance: unknown = JSON.parse(
            provenanceBytes.toString("utf8"),
        );

        expect(createHash("sha256").update(binary).digest("hex")).toBe(
            "af290ad53ca67ddf5cfadd1610cbf27ae4d6faadaf8db5ea696ac7e649fab574",
        );
        expect(createHash("sha256").update(provenanceBytes).digest("hex")).toBe(
            "401a2e6734e91936048a0baf08def697d2a19098df79949a9daf2ad20a3fe4fc",
        );
        expect(previousProvenance).toMatchObject({
            version: "0.3.3-fork.6",
            binarySha256:
                "af290ad53ca67ddf5cfadd1610cbf27ae4d6faadaf8db5ea696ac7e649fab574",
        });
        expect(manifest).toContain("not an ASRT source rollback");
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
