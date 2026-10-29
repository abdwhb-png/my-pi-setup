import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestSession } from "@abdwhb-png/pi-test-harness";
import { type ExtensionAPI, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { manageDockerAccess } from "./docker-configuration.ts";
import { loadSandboxConfig } from "./index.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

async function workflow(options: { named?: boolean; missingGlobal?: boolean; accepted?: boolean; engineInfo?: boolean; installations?: boolean; revokeOnReinspection?: boolean } = {}) {
    const root = mkdtempSync(join(tmpdir(), "pi-docker-workflow-"));
    let session: Awaited<ReturnType<typeof createTestSession>> | undefined;
    const store = new ProjectTrustStore(root);
    let inspections = 0, applied = 0, failure: unknown;
    const id = "a".repeat(64), selector = { type: "container-name", name: "fixture-api" } as const;
    const server = createServer((request, response) => {
        response.setHeader("Content-Type", "application/json");
        if (request.url?.startsWith("/containers/json")) {
            response.end(JSON.stringify([{ Id: id, Names: ["/fixture-api"], State: "running", Labels: { "com.docker.compose.project": "fixture", "com.docker.compose.service": "api" } }]));
        } else if (request.url === `/containers/${id}/json`) {
            inspections++;
            if (options.revokeOnReinspection && inspections === 2) store.set(root, false);
            response.end(JSON.stringify({ Mounts: [{ Type: "bind", Source: root, Destination: "/app", RW: true }] }));
        } else { response.statusCode = 404; response.end("{}"); }
    });
    cleanup.push(async () => {
        session?.dispose();
        if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        rmSync(root, { recursive: true, force: true });
    });
    mkdirSync(join(root, "config"), { recursive: true });
    mkdirSync(join(root, ".pi", "config"), { recursive: true });
    store.set(root, true);
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(join(root, "engine.sock"), resolve); });
    const globalPath = join(root, "config", "sandbox.json"), projectPath = join(root, ".pi", "config", "sandbox.json");
    const environment = options.installations ? { installations: { tool: [{ root, files: ["fixture-tool"], path: [] }] } } : undefined;
    if (options.installations) writeFileSync(join(root, "fixture-tool"), "fixture");
    const original = JSON.stringify({ version: 2, machineId: "fixture", ...(environment ? { environment } : {}), docker: { allowed: true, endpoint: `unix://${join(root, "engine.sock")}` } });
    if (!options.missingGlobal) writeFileSync(globalPath, original, { mode: 0o600 });
    writeFileSync(projectPath, JSON.stringify({ ...(options.installations ? { environment: { installations: ["tool"] } } : {}), ...(options.named ? { docker: { enabled: true, targets: [{ selector, operations: ["logs"] }] } } : {}) }), { mode: 0o600 });
    session = await createTestSession({ cwd: root,
        extensionFactories: [(pi: ExtensionAPI) => { pi.registerCommand("configure-fixture-docker", { description: "Configure isolated fixture Docker access", handler: async (_args, ctx) => {
            try { await manageDockerAccess(ctx, { agentDir: root, machineId: "fixture", ...(options.named ? { selector } : {}), onChanged: async () => { applied++; } }); }
            catch (error) { failure = error; }
        } }); }],
        mockUI: { select: (title, items) => title === "Configure Docker access" ? options.engineInfo ? "Engine information permission" : "Add or edit a service" : options.engineInfo ? "Allow for this project" : title === "Choose a Docker service" ? items[0] : title.startsWith("Execute commands") ? "Allow" : "Do not allow", confirm: options.accepted ?? true },
    });
    await session.session.prompt("/configure-fixture-docker");
    return { root, globalPath, projectPath, original, applied, inspections, failure, selector, hasGlobal: existsSync(globalPath), confirms: session.events.uiCallsFor("confirm") };
}

test("revoking project trust during final inspection prevents permanent global grants", async () => {
    const result = await workflow({ revokeOnReinspection: true });
    expect(result.inspections).toBe(2);
    expect(result.failure).toBeInstanceOf(Error);
    expect(String(result.failure)).toContain("trust changed");
    expect(result.applied).toBe(0);
    expect(readFileSync(result.globalPath, "utf8")).toBe(result.original);
});

test.each([false, true])("first-time engine-information setup respects final consent (accepted=%s)", async accepted => {
    const result = await workflow({ missingGlobal: true, engineInfo: true, accepted });
    expect(result.failure).toBeUndefined();
    expect(result.confirms).toHaveLength(1);
    expect(result.hasGlobal).toBe(accepted);
    expect(result.applied).toBe(accepted ? 1 : 0);
    if (accepted) expect(JSON.parse(readFileSync(result.globalPath, "utf8"))).toEqual({ version: 2, machineId: "fixture", docker: { allowed: true, allowEngineInfo: true } });
    else expect(readFileSync(result.projectPath, "utf8")).toBe("{}");
});

test("editing a saved container-name grant preserves its identity when discovery has Compose labels", async () => {
    const result = await workflow({ named: true });
    expect(result.failure).toBeUndefined();
    expect(result.inspections).toBe(2);
    expect(result.applied).toBe(1);
    const saved = JSON.parse(readFileSync(result.projectPath, "utf8"));
    expect(saved.docker.targets).toEqual([{ selector: result.selector, operations: ["exec"] }]);
    expect(JSON.parse(readFileSync(result.globalPath, "utf8")).docker.trustedExecTargets).toEqual([result.selector]);
});

test("saving Docker access preserves installed tools and their project selection", async () => {
    const result = await workflow({ installations: true });
    expect(result.failure).toBeUndefined();
    expect(result.applied).toBe(1);
    const global = JSON.parse(readFileSync(result.globalPath, "utf8"));
    const project = JSON.parse(readFileSync(result.projectPath, "utf8"));
    expect(global.environment).toEqual(JSON.parse(result.original).environment);
    expect(project.environment).toEqual({ installations: ["tool"] });
    expect(project.docker.targets[0].operations).toEqual(["exec"]);
    const resolved = loadSandboxConfig(result.root, { agentDir: result.root, machineId: "fixture", projectTrusted: true });
    expect(resolved.config.environment.installations?.map(tool => tool.name)).toEqual(["tool"]);
    expect(resolved.config.filesystem.allowRead).toContain(join(result.root, "fixture-tool"));
    expect(resolved.config.filesystem.denyWrite).toContain(join(result.root, "fixture-tool"));
});
