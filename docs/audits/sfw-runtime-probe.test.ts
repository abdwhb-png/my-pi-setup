import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadSandboxConfig } from "../../agent/extensions/sandbox/index.ts";
import type { SandboxSpawnSpec } from "../../agent/extensions/sandbox/runtime/contracts.ts";
import { createSandboxService } from "../../agent/extensions/sandbox/runtime/service.ts";
import { createZeroboxBackend } from "../../agent/extensions/sandbox/runtime/zerobox-backend.ts";

const enabled = process.env.SFW_AUDIT_PROBE === "1";
const cwd = join(homedir(), ".pi");
const sfwRoot = join(homedir(), ".local/lib/node_modules/sfw");
const sfwWrapper = join(sfwRoot, "dist/sfw.mjs");
const sfwBinary = join(sfwRoot, ".sfw-cache/v1.15.1/sfw-free-linux-x86_64");
let service: ReturnType<typeof createSandboxService> | undefined;

async function run(label: string, spec: SandboxSpawnSpec) {
    spec.beforeSpawn?.();
    const child = spawn(spec.file, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        stdio: ["ignore", "pipe", "pipe", ...spec.extraStdio],
        detached: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (data) => { stdout += data.toString(); });
    child.stderr?.on("data", (data) => { stderr += data.toString(); });
    const timer = setTimeout(() => {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
    }, 30000);
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
    });
    const supervision = spec.supervise(child);
    try {
        await supervision.ready;
        const [exit] = await Promise.all([exited, supervision.settled]);
        const shownStdout = stdout.startsWith("HTTP/")
            ? stdout.split(/\r?\n/).filter((line) => /^(HTTP\/|x-proxy-error:)/i.test(line)).join("\n")
            : stdout.slice(0, 1000);
        const result = { label, ...exit, stdout: shownStdout, stderr: stderr.slice(0, 3000) };
        console.log(JSON.stringify(result));
        return result;
    } finally {
        clearTimeout(timer);
        await spec.cleanup?.();
    }
}

async function sandbox(command: string, label: string) {
    if (!service) {
        const { config } = loadSandboxConfig(cwd);
        console.log(JSON.stringify({ label: "effective-network", network: config.network }));
        service = createSandboxService({
            backend: createZeroboxBackend(),
            config,
            recoverStaleLeases: async () => {},
        });
        await service.startBashSession(cwd);
    }
    return run(label, await service.prepareBash({ file: "/bin/bash", args: ["-c", command], cwd }));
}

afterAll(async () => { await service?.shutdown(); });

test.skipIf(!enabled)("installed wrapper and cached binary are present", () => {
    const pkg = JSON.parse(readFileSync(join(sfwRoot, "package.json"), "utf8"));
    expect(pkg.version).toBe("2.0.6");
    expect(realpathSync(join(homedir(), ".local/bin/sfw"))).toBe(sfwWrapper);
    expect(readFileSync(sfwBinary).length).toBeGreaterThan(0);
    console.log(JSON.stringify({ label: "installed", wrapper: pkg.version, binary: sfwBinary }));
});

test.skipIf(!enabled)("observe actual sandbox wrapper version and startup", async () => {
    const raw = await sandbox("sfw --version", "sandbox-wrapper-version");
    const skip = await sandbox("SFW_SKIP_UPDATE_CHECK=1 sfw --version", "sandbox-wrapper-no-update");
    expect(skip.code).toBe(0);
    expect(skip.stdout).toContain("1.15.1");
    expect(raw.stdout + raw.stderr).toMatch(/1\.15\.1|EROFS/);
    const launch = await sandbox("SFW_SKIP_UPDATE_CHECK=1 sfw --verbose /usr/bin/true", "sandbox-sfw-startup");
    expect(launch.stdout + launch.stderr).toMatch(/Socket Firewall|Proxy response|403/);
}, 100000);

test.skipIf(!enabled)("observe sandbox network requests with and without sfw", async () => {
    for (const [label, prefix] of [["direct-registry", ""], ["sfw-registry", "SFW_SKIP_UPDATE_CHECK=1 sfw --verbose "]]) {
        const result = await sandbox(`${prefix}curl --silent --show-error --head --max-time 15 https://registry.npmjs.org/pi-hermes-memory`, label);
        expect(result.stdout + result.stderr).toMatch(/403|Proxy response|Domain not in allowlist/);
    }
    const socketApi = await sandbox("curl --silent --show-error --head --max-time 15 https://firewall-api.socket.dev", "direct-socket-api");
    expect(socketApi.stdout).toContain("x-proxy-error: blocked-by-allowlist");
}, 70000);

test.skipIf(!enabled)("compare an allowed domain with and without sfw", async () => {
    const direct = await sandbox("curl --silent --show-error --head --max-time 15 https://github.com", "direct-allowed-github");
    expect(direct.code).toBe(0);
    const wrapped = await sandbox("SFW_SKIP_UPDATE_CHECK=1 sfw --verbose curl --silent --show-error --head --max-time 15 https://github.com", "sfw-allowed-github");
    expect(wrapped.code).not.toBe(0);
    expect(wrapped.stderr).toMatch(/EAI_AGAIN|Proxy response|403/);
}, 70000);

test.skipIf(!enabled)("identify error reporting destination using a local rejecting proxy", async () => {
    const destinations: string[] = [];
    const proxy = createServer((_request, response) => { response.writeHead(403); response.end(); });
    proxy.on("connect", (request, socket) => {
        destinations.push(request.url ?? "missing");
        socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP proxy address");
    const proxyUrl = `http://127.0.0.1:${address.port}`;
    const env = { PATH: "/usr/bin:/bin", HOME: homedir(), NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl, https_proxy: proxyUrl, http_proxy: proxyUrl, NO_PROXY: "", no_proxy: "" };
    const control = Bun.spawn(["/usr/bin/curl", "--silent", "--show-error", "--head", "--max-time", "5", "https://sfw-audit-probe.invalid"], {
        env,
        stdout: "pipe",
        stderr: "pipe",
    });
    const controlCode = await control.exited;
    expect(controlCode).toBe(56);
    expect(destinations).toContain("sfw-audit-probe.invalid:443");
    console.log(JSON.stringify({ label: "proxy-control", code: controlCode, destinations: [...destinations] }));
    destinations.length = 0;
    const child = spawn(sfwBinary, ["--verbose", "/usr/bin/curl", "--silent", "--show-error", "--head", "--max-time", "10", "https://sfw-audit-probe.invalid"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
    });
    let stderr = "";
    let stdout = "";
    child.stdout.on("data", (data) => { stdout += data.toString(); });
    child.stderr.on("data", (data) => { stderr += data.toString(); });
    const timer = setTimeout(() => { if (child.pid) process.kill(-child.pid, "SIGKILL"); }, 20000);
    try {
        const exit = await new Promise((resolve, reject) => {
            child.once("error", reject);
            child.once("close", (code, signal) => resolve({ code, signal }));
        });
        console.log(JSON.stringify({ label: "rejecting-proxy", destinations, exit, stdout: stdout.slice(0, 1500), stderr: stderr.slice(0, 3000) }));
        expect(destinations.length).toBeGreaterThan(0);
        expect(destinations).toContain("firewall-api.socket.dev:443");
        expect(stderr).toContain("403");
    } finally {
        clearTimeout(timer);
        await new Promise<void>((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
    }
}, 30000);

test.skipIf(!enabled)("host sfw downloads the known package without installing or running scripts", async () => {
    const installed = JSON.parse(readFileSync(join(cwd, "agent/node_modules/pi-hermes-memory/package.json"), "utf8"));
    expect(installed.name).toBe("pi-hermes-memory");
    expect(installed.version).toBe("0.9.8");
    const directory = await mkdtemp(join(tmpdir(), "sfw-host-audit-"));
    try {
        const child = Bun.spawn([sfwBinary, "--verbose", "npm", "pack", "pi-hermes-memory@0.9.8", "--dry-run", "--ignore-scripts", "--json", "--registry=https://registry.npmjs.org", `--cache=${join(directory, "cache")}`], {
            cwd: directory,
            env: { PATH: process.env.PATH, HOME: directory },
            stdout: "pipe",
            stderr: "pipe",
        });
        const timer = setTimeout(() => child.kill(), 40000);
        try {
            const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
            const metadata = JSON.parse(stdout)["pi-hermes-memory"];
            console.log(JSON.stringify({ label: "host-sfw-pack-dry-run", code, package: { name: metadata?.name, version: metadata?.version, size: metadata?.size, integrity: metadata?.integrity }, stderr: stderr.slice(0, 1000) }));
            expect(code).toBe(0);
            expect(metadata.name).toBe("pi-hermes-memory");
            expect(metadata.version).toBe("0.9.8");
        } finally {
            clearTimeout(timer);
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}, 50000);
