import { spawnSync } from "node:child_process";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestSession } from "@abdwhb-png/pi-test-harness";
import { applyLayoutMigration, planLayoutMigration, recoverLayoutMigration } from "../../_shared/scripts/extension-layout-migration.ts";
import sandboxExtension, { loadSandboxConfig } from "../index.ts";
import {
    previewSandboxDocuments,
    publishSandboxDocuments,
    cancelIncompleteMigration,
    previewLegacyMigration,
    publishLegacyMigration,
    recoverIncompleteMigration,
} from "./migration.ts";

const roots: string[] = [];

afterEach(() => {
    roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

function fixture() {
    const root = mkdtempSync(join(tmpdir(), "sandbox-migration-"));
    roots.push(root);
    const agent = join(root, "agent");
    const projectRoot = join(root, "project");
    const project = join(projectRoot, ".pi");
    mkdirSync(agent, { recursive: true, mode: 0o700 });
    mkdirSync(project, { recursive: true, mode: 0o700 });
    mkdirSync(join(agent,"config"));
    mkdirSync(join(project,"config"));
    return { agent, projectRoot, project };
}

test("migration publishes host authorization without persisting a selected mode", () => {
    const { agent, projectRoot, project } = fixture();
    const globalPath = join(agent, "config", "sandbox.json");
    writeFileSync(globalPath, JSON.stringify({ version: 2, machineId: "machine", mode: "host" }), { mode: 0o600 });
    const preview = previewLegacyMigration(agent, "machine", projectRoot);
    publishLegacyMigration({ preview, globalPath, projectPath: join(project, "config", "sandbox.json"), machineId: "machine", globalCeiling: preview.proposedGlobal });
    const saved = JSON.parse(readFileSync(globalPath, "utf8"));
    expect(saved.host).toEqual({ allowed: true });
    expect(saved).not.toHaveProperty("mode");
    expect(loadSandboxConfig(projectRoot, { agentDir: agent, machineId: "machine" }).shell.mode).toBe("sandbox");
});

test("repeating migration leaves canonical configuration and archive count unchanged", () => {
    const { agent, projectRoot, project } = fixture();
    const globalPath = join(agent, "config", "sandbox.json");
    const projectPath = join(project, "config", "sandbox.json");
    const original = JSON.stringify({ version: 2, machineId: "machine", host: { allowed: false }, resources: { unixSockets: [] } });
    writeFileSync(globalPath, original, { mode: 0o600 });
    writeFileSync(projectPath, "{}", { mode: 0o600 });
    const preview = previewLegacyMigration(agent, "machine", projectRoot);
    const result = publishLegacyMigration({ preview, globalPath, projectPath, machineId: "machine", globalCeiling: preview.proposedGlobal });
    expect(result.published).toBeFalse();
    expect(result.archives).toEqual([]);
    expect(readFileSync(globalPath, "utf8")).toBe(original);
    expect(readdirSync(join(agent,"config"))).toEqual(["sandbox.json"]);
});

test("migrates empty legacy additional paths without closing the project baseline", () => {
    const { agent, projectRoot, project } = fixture();
    writeFileSync(join(agent, "sandbox.capabilities.json"), JSON.stringify({
        version: 1, machineId: "machine", projects: [{
            projectRoot, profile: "integrated", grants: {
                domains: [], hostDomains: [], readPaths: [], writePaths: [],
                hostTmp: false, host: false, integrations: {},
            },
        }],
    }), { mode: 0o600 });
    const preview = previewLegacyMigration(agent, "machine", projectRoot);
    expect(preview.inactive).toEqual([]);
    publishLegacyMigration({ preview, globalPath: join(agent, "config", "sandbox.json"), projectPath: join(project, "config", "sandbox.json"), machineId: "machine", globalCeiling: {} });
    const resolved = loadSandboxConfig(projectRoot, { agentDir: agent, machineId: "machine" });
    expect(resolved.shell.state).toBe("ready");
    expect(resolved.config.filesystem.allowRead).toContain(projectRoot);
    expect(resolved.config.filesystem.allowWrite).toContain(projectRoot);
});

test("preview cancellation leaves historic sources and destinations untouched", () => {
    const { agent, project } = fixture();
    const authority = join(agent, "sandbox.capabilities.json");
    const bytes = JSON.stringify({ version: 1, machineId: "machine", projects: [] });
    writeFileSync(authority, bytes, { mode: 0o600 });
    const preview = previewLegacyMigration(agent, "machine");

    const result = publishLegacyMigration({
        preview,
        globalPath: join(agent, "config", "sandbox.json"),
        projectPath: join(project, "config", "sandbox.json"),
        machineId: "machine",
        globalCeiling: {},
        cancelled: true,
    });

    expect(result.published).toBeFalse();
    expect(readFileSync(authority, "utf8")).toBe(bytes);
    expect(existsSync(join(agent, "config", "sandbox.json"))).toBeFalse();
    expect(existsSync(join(project, "config", "sandbox.json"))).toBeFalse();
});

test("foreign and malformed historic authorities remain inactive without grants", () => {
    const { agent } = fixture();
    const authority = join(agent, "sandbox.capabilities.json");
    writeFileSync(authority, JSON.stringify({ version: 1, machineId: "foreign", projects: [] }), { mode: 0o600 });
    let preview = previewLegacyMigration(agent, "machine");
    expect(preview.inactive.join(" ")).toContain("another machine");

    writeFileSync(authority, "{", { mode: 0o600 });
    preview = previewLegacyMigration(agent, "machine");
    expect(preview.inactive.join(" ")).toContain("invalid");
    expect(preview.proposedProject).toEqual({});
});

test("refuses an invalid selected destination before archives, markers, or publication", () => {
    const { agent, project } = fixture();
    const globalPath = join(agent, "config", "sandbox.json");
    expect(() => publishLegacyMigration({
        preview: previewLegacyMigration(agent, "machine"),
        globalPath,
        projectPath: join(project, "config", "sandbox.json"),
        machineId: "machine",
        globalCeiling: { network: { allowedDomains: ["https://bad.test"] } },
    })).toThrow();
    expect(existsSync(globalPath)).toBeFalse();
    expect(existsSync(globalPath + ".migration")).toBeFalse();
    expect(readdirSync(agent).some((entry) => entry.endsWith(".archive"))).toBeFalse();
});

test("rejects malformed nested selected settings through the active authority reader", () => {
    const { agent, project } = fixture();
    const globalPath = join(agent, "config", "sandbox.json");
    expect(() => publishLegacyMigration({
        preview: previewLegacyMigration(agent, "machine"),
        globalPath,
        projectPath: join(project, "config", "sandbox.json"),
        machineId: "machine",
        globalCeiling: { environment: { variables: { LANG: false } } },
    })).toThrow("Sandbox policy is invalid");
    expect(existsSync(globalPath)).toBeFalse();
    expect(existsSync(globalPath + ".migration")).toBeFalse();
});

test("migrates compatible settings and preserves exact bytes for every historic archive", () => {
    const { agent, projectRoot, project } = fixture();
    const globalPath = join(agent, "config", "sandbox.json");
    const projectPath = join(project, "config", "sandbox.json");
    const globalSettings = join(agent, "settings.json");
    const projectSettings = join(project, "settings.json");
    const globalBytes = JSON.stringify({ filesystem: { allowRead: [projectRoot], allowWrite: [projectRoot] } });
    const projectBytes = JSON.stringify({ network: { allowedDomains: ["api.example.test"] } });
    const settingsBytes = JSON.stringify({ theme: "night", sandbox: { environment: { path: ["/usr/bin"] } } });
    const projectSettingsBytes = JSON.stringify({ model: "local", sandbox: { filesystem: { denyWrite: [".env"] } } });
    writeFileSync(globalPath, globalBytes, { mode: 0o600 });
    writeFileSync(projectPath, projectBytes, { mode: 0o600 });
    writeFileSync(globalSettings, settingsBytes, { mode: 0o600 });
    writeFileSync(projectSettings, projectSettingsBytes, { mode: 0o600 });
    const preview = previewLegacyMigration(agent, "machine", projectRoot);

    const result = publishLegacyMigration({
        preview,
        globalPath,
        projectPath,
        machineId: "machine",
        globalCeiling: preview.proposedGlobal,
    });

    expect(result.published).toBeTrue();
    expect(JSON.parse(readFileSync(globalPath, "utf8"))).toMatchObject({
        version: 2,
        machineId: "machine",
        environment: { path: ["/usr/bin"] },
    });
    expect(JSON.parse(readFileSync(projectPath, "utf8"))).toMatchObject({
        network: { allowedDomains: ["api.example.test"] },
        filesystem: { denyWrite: [".env"] },
    });
    expect(readFileSync(globalSettings, "utf8")).toBe(settingsBytes);
    expect(readFileSync(projectSettings, "utf8")).toBe(projectSettingsBytes);
    for (const bytes of [globalBytes, projectBytes, settingsBytes, projectSettingsBytes]) {
        expect(result.archives.some((path) => readFileSync(path, "utf8") === bytes)).toBeTrue();
    }
});

test("does not union historical project Docker grants into the global ceiling", () => {
    const { agent, projectRoot, project } = fixture();
    writeFileSync(join(agent, "sandbox.global.json"), JSON.stringify({
        docker: {
            grants: [{ projectRoot, targets: [{ selector: { type: "container-name", name: "db" } }] }],
        },
    }), { mode: 0o600 });
    const preview = previewLegacyMigration(agent, "machine", projectRoot);
    expect(preview.proposedGlobal.docker).toEqual({});
    expect(preview.inactive.join(" ")).toContain("per-project Docker grants");

    publishLegacyMigration({
        preview,
        globalPath: join(agent, "config", "sandbox.json"),
        projectPath: join(project, "config", "sandbox.json"),
        machineId: "machine",
        globalCeiling: {},
    });
    expect(JSON.parse(readFileSync(join(agent, "config", "sandbox.json"), "utf8")).docker).toBeUndefined();
});

test("leaves a durable admission block after a real second rename failure and restores verified bytes", () => {
    const { agent, projectRoot, project } = fixture();
    const globalPath = join(agent, "config", "sandbox.json");
    const projectPath = join(project, "config", "sandbox.json");
    const oldGlobal = "{\"enabled\":true}\n";
    const oldProject = "{\"network\":{\"allowedDomains\":[]}}\n";
    writeFileSync(globalPath, oldGlobal, { mode: 0o600 });
    writeFileSync(projectPath, oldProject, { mode: 0o600 });
    const preview = previewLegacyMigration(agent, "machine", projectRoot);
    let publishedGlobal = false;

    expect(() => publishLegacyMigration({
        preview,
        globalPath,
        projectPath,
        machineId: "machine",
        globalCeiling: {},
        filesystem: {
            rename(from, to) {
                if (to === globalPath) publishedGlobal = true;
                if (to === projectPath && publishedGlobal) throw new Error("injected failure after global publication");
                renameSync(from, to);
            },
        },
    })).toThrow("injected failure");
    expect(existsSync(globalPath + ".migration")).toBeTrue();
    expect(readFileSync(globalPath, "utf8")).toContain("\"version\": 2");
    expect(readFileSync(projectPath, "utf8")).toBe(oldProject);

    expect(recoverIncompleteMigration(globalPath)).toEqual({ recovered: "restored" });
    expect(readFileSync(globalPath, "utf8")).toBe(oldGlobal);
    expect(readFileSync(projectPath, "utf8")).toBe(oldProject);
    expect(existsSync(globalPath + ".migration")).toBeFalse();
});

test("layout migration refuses an interrupted sandbox publication and preserves recovery", () => {
    const { agent, projectRoot, project } = fixture();
    const globalPath = join(agent, "config/sandbox.json");
    const legacyPath = join(agent, "sandbox.json");
    const legacy = JSON.stringify({ version: 2, machineId: "machine", host: { allowed: true } });
    writeFileSync(legacyPath, legacy);
    const layoutPlan = planLayoutMigration({ agentDir: agent, projects: [projectRoot] });
    const preview = previewLegacyMigration(agent, "machine", projectRoot);
    expect(() => publishLegacyMigration({
        preview,
        globalPath,
        projectPath: join(project, "config/sandbox.json"),
        machineId: "machine",
        globalCeiling: {},
        filesystem: {
            rename(from, to) {
                if (to === globalPath) throw new Error("interrupted publication");
                renameSync(from, to);
            },
        },
    })).toThrow("interrupted publication");
    expect(existsSync(globalPath + ".migration")).toBeTrue();
    const marker = readFileSync(globalPath + ".migration");
    expect(() => applyLayoutMigration(planLayoutMigration({
        agentDir: agent, projects: [projectRoot],
    }))).toThrow("Finish the existing sandbox migration");
    expect(() => applyLayoutMigration(layoutPlan)).toThrow("Finish the existing sandbox migration");
    const layoutJournal = join(agent, "layout-journal.json");
    writeFileSync(layoutJournal, JSON.stringify({ ...layoutPlan, state: "applying" }));
    for (const action of ["resume", "rollback"] as const)
        expect(() => recoverLayoutMigration(layoutJournal, action)).toThrow("Finish the existing sandbox migration");
    expect(existsSync(globalPath)).toBeFalse();
    expect(readFileSync(globalPath + ".migration")).toEqual(marker);
    expect(readFileSync(legacyPath, "utf8")).toBe(legacy);
    expect(recoverIncompleteMigration(globalPath)).toEqual({ recovered: "restored" });
    expect(existsSync(globalPath + ".migration")).toBeFalse();
});

test("sandbox recover restores a legacy marker before the layout migration", async () => {
    const { agent, projectRoot, project } = fixture();
    const globalPath = join(agent, "sandbox.json");
    const projectPath = join(project, "sandbox.json");
    const original = JSON.stringify({ version: 2, machineId: "machine", host: { allowed: true } });
    writeFileSync(globalPath, original, { mode: 0o600 });
    writeFileSync(projectPath, "{}", { mode: 0o600 });
    expect(() => publishLegacyMigration({
        preview: previewLegacyMigration(agent, "machine", projectRoot),
        globalPath, projectPath, machineId: "machine", globalCeiling: {},
        filesystem: { rename(from, to) {
            if (to === projectPath) throw new Error("interrupted legacy publication");
            renameSync(from, to);
        } },
    })).toThrow("interrupted legacy publication");
    expect(() => planLayoutMigration({ agentDir: agent, projects: [projectRoot] })).toThrow("Finish the existing sandbox migration");
    const previous = process.env.PI_CODING_AGENT_DIR;
    try {
        process.env.PI_CODING_AGENT_DIR = agent;
        const session = await createTestSession({ cwd: projectRoot, extensionFactories: [sandboxExtension] });
        try {
            await session.session.prompt("/sandbox recover");
            expect(existsSync(globalPath + ".migration")).toBe(false);
            expect(readFileSync(globalPath, "utf8")).toBe(original);
            expect(session.events.uiCallsFor("notify").some(call => String(call.args[0]).includes("extension-layout migration"))).toBe(true);
            applyLayoutMigration(planLayoutMigration({ agentDir: agent, projects: [projectRoot] }));
            expect(loadSandboxConfig(projectRoot, { agentDir: agent, machineId: "machine" }).shell.state).toBe("ready");
        } finally {
            await session.session.extensionRunner!.emit({ type: "session_shutdown", reason: "quit" });
            session.dispose();
        }
    } finally {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
    }
});

test("legacy migration marker blocks admissions even before its first config was published", () => {
    const { agent, projectRoot, project } = fixture();
    const globalPath = join(agent, "sandbox.json");
    expect(() => publishLegacyMigration({
        preview: previewLegacyMigration(agent, "machine", projectRoot),
        globalPath, projectPath: join(project, "sandbox.json"), machineId: "machine", globalCeiling: {},
        filesystem: { rename(from, to) {
            if (to === globalPath) throw new Error("interrupted before first publication");
            renameSync(from, to);
        } },
    })).toThrow("interrupted before first publication");
    expect(existsSync(globalPath)).toBe(false);
    expect(existsSync(globalPath + ".migration")).toBe(true);
    expect(() => loadSandboxConfig(projectRoot, { agentDir: agent, machineId: "machine", projectTrusted: false })).toThrow("Sandbox policy is invalid");
});

test("sandbox migrate refuses unmoved legacy configuration before creating a conflicting destination", async () => {
    const { agent, projectRoot } = fixture();
    const original = JSON.stringify({ version: 2, machineId: "machine", host: { allowed: true } });
    const legacyPath = join(agent, "sandbox.json");
    writeFileSync(legacyPath, original, { mode: 0o600 });
    const previous = process.env.PI_CODING_AGENT_DIR;
    try {
        process.env.PI_CODING_AGENT_DIR = agent;
        const session = await createTestSession({ cwd: projectRoot, extensionFactories: [sandboxExtension], mockUI: { select: 0 } });
        try {
            await session.session.prompt("/sandbox migrate");
            expect(existsSync(join(agent, "config/sandbox.json"))).toBe(false);
            expect(readFileSync(legacyPath, "utf8")).toBe(original);
            expect(session.events.uiCallsFor("notify").some(call => String(call.args[0]).includes("extension-layout migration"))).toBe(true);
            expect(planLayoutMigration({ agentDir: agent, projects: [projectRoot] }).changes.length).toBeGreaterThan(0);
        } finally {
            await session.session.extensionRunner!.emit({ type: "session_shutdown", reason: "quit" });
            session.dispose();
        }
    } finally {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
    }
});

test("recovers when an already-proposed global destination also matches its pre-migration digest", () => {
    const { agent, projectRoot, project } = fixture();
    const globalPath = join(agent, "config", "sandbox.json");
    const projectPath = join(project, "config", "sandbox.json");
    const globalBody = JSON.stringify({ version: 2, machineId: "machine", host: { allowed: false } }, null, 2) + "\n";
    const oldProject = "{\"network\":{\"allowedDomains\":[]}}\n";
    writeFileSync(globalPath, globalBody, { mode: 0o600 });
    writeFileSync(join(agent, "settings.json"), JSON.stringify({ sandbox: {} }), { mode: 0o600 });
    writeFileSync(projectPath, oldProject, { mode: 0o600 });
    const preview = previewLegacyMigration(agent, "machine", projectRoot);
    let publishedGlobal = false;

    expect(() => publishLegacyMigration({
        preview,
        globalPath,
        projectPath,
        machineId: "machine",
        globalCeiling: preview.proposedGlobal,
        filesystem: {
            rename(from, to) {
                if (to === globalPath) publishedGlobal = true;
                if (to === projectPath && publishedGlobal) throw new Error("second rename failed");
                renameSync(from, to);
            },
        },
    })).toThrow("second rename failed");

    expect(recoverIncompleteMigration(globalPath)).toEqual({ recovered: "restored" });
    expect(readFileSync(globalPath, "utf8")).toBe(globalBody);
    expect(readFileSync(projectPath, "utf8")).toBe(oldProject);
    expect(existsSync(globalPath + ".migration")).toBeFalse();
});

test("restores a non-UTF8 historic destination byte-for-byte after a partial publication", () => {
    const { agent, projectRoot, project } = fixture();
    const globalPath = join(agent, "config", "sandbox.json");
    const projectPath = join(project, "config", "sandbox.json");
    const original = Buffer.from([0xff, 0x00, 0x80, 0x0a]);
    writeFileSync(globalPath, original, { mode: 0o600 });
    const preview = previewLegacyMigration(agent, "machine", projectRoot);
    let publishedGlobal = false;

    expect(() => publishLegacyMigration({
        preview,
        globalPath,
        projectPath,
        machineId: "machine",
        globalCeiling: {},
        filesystem: {
            rename(from, to) {
                if (to === globalPath) publishedGlobal = true;
                if (to === projectPath && publishedGlobal) throw new Error("second rename failed");
                renameSync(from, to);
            },
        },
    })).toThrow("second rename failed");

    expect(recoverIncompleteMigration(globalPath)).toEqual({ recovered: "restored" });
    expect(readFileSync(globalPath).equals(original)).toBeTrue();
});

test("refuses blind marker removal after an interrupted destination is edited", () => {
    const { agent, projectRoot, project } = fixture();
    const globalPath = join(agent, "config", "sandbox.json");
    const projectPath = join(project, "config", "sandbox.json");
    const preview = previewLegacyMigration(agent, "machine", projectRoot);
    let publishedGlobal = false;
    expect(() => publishLegacyMigration({
        preview,
        globalPath,
        projectPath,
        machineId: "machine",
        globalCeiling: {},
        filesystem: {
            rename(from, to) {
                if (to === globalPath) publishedGlobal = true;
                if (to === projectPath && publishedGlobal) throw new Error("stop");
                renameSync(from, to);
            },
        },
    })).toThrow("stop");
    writeFileSync(globalPath, "{\"operator\":\"edited\"}\n", { mode: 0o600 });

    expect(() => cancelIncompleteMigration(globalPath)).toThrow("changed after interruption");
    expect(existsSync(globalPath + ".migration")).toBeTrue();
    expect(readFileSync(globalPath, "utf8")).toContain("operator");
});

test("another process cannot publish over a transaction before its marker is installed", () => {
    const { agent, project } = fixture();
    const globalPath = join(agent, "config", "sandbox.json"), projectPath = join(project, "config", "sandbox.json");
    const selector = { type: "container-name", name: "api" };
    const global = { version: 2, machineId: "machine", docker: { allowed: true, unsafeTargets: [selector], trustedExecTargets: [selector] } };
    const local = { docker: { enabled: true, targets: [{ selector, operations: ["exec"] }] } };
    writeFileSync(globalPath, JSON.stringify(global), { mode: 0o600 });
    writeFileSync(projectPath, JSON.stringify(local), { mode: 0o600 });
    const sources = previewSandboxDocuments(globalPath, projectPath);
    let attempted = false;
    publishSandboxDocuments({ globalPath, projectPath, machineId: "machine", sources, globalLayer: global, projectLayer: local,
        filesystem: { rename(from, to) {
            if (to === globalPath + ".migration" && !attempted) {
                attempted = true;
                const child = spawnSync(process.execPath, ["--eval", `
                    const { publishSandboxDocuments, previewSandboxDocuments } = await import(${JSON.stringify(join(import.meta.dir, "migration.ts"))});
                    const globalPath = ${JSON.stringify(globalPath)}, projectPath = ${JSON.stringify(projectPath)};
                    try {
                        publishSandboxDocuments({ globalPath, projectPath, machineId: "machine", sources: previewSandboxDocuments(globalPath, projectPath), globalLayer: ${JSON.stringify({ ...global, docker: { allowed: true, unsafeTargets: [], trustedExecTargets: [] } })}, projectLayer: ${JSON.stringify(local)} });
                        process.exit(2);
                    } catch (error) { process.exit(String(error).includes("running") ? 0 : 3); }
                `], { encoding: "utf8", timeout: 10000 });
                expect({ status: child.status, stderr: child.stderr }).toEqual({ status: 0, stderr: "" });
            }
            renameSync(from, to);
        } },
    });
    expect(attempted).toBe(true);
    const stale = previewSandboxDocuments(globalPath, projectPath);
    publishSandboxDocuments({ globalPath, projectPath, machineId: "machine", sources: stale, globalLayer: { ...global, docker: { allowed: true, unsafeTargets: [], trustedExecTargets: [] } }, projectLayer: local });
    expect(() => publishSandboxDocuments({ globalPath, projectPath, machineId: "machine", sources: stale, globalLayer: global, projectLayer: local })).toThrow("changed after preview");
    expect(JSON.parse(readFileSync(globalPath, "utf8")).docker.trustedExecTargets).toEqual([]);
}, 20000);

test("recovery cannot modify a transaction still owned by another process", () => {
    const { agent, project } = fixture();
    const globalPath = join(agent, "config", "sandbox.json"), projectPath = join(project, "config", "sandbox.json");
    const global = { version: 2, machineId: "machine", host: { allowed: false } };
    writeFileSync(globalPath, JSON.stringify(global), { mode: 0o600 });
    writeFileSync(projectPath, "{}", { mode: 0o600 });
    let tested = false;
    publishSandboxDocuments({ globalPath, projectPath, machineId: "machine", sources: previewSandboxDocuments(globalPath, projectPath), globalLayer: { ...global, host: { allowed: true } }, projectLayer: {}, filesystem: { rename(from, to) {
        renameSync(from, to);
        if (to !== globalPath) return;
        tested = true;
        const child = spawnSync(process.execPath, ["--eval", `
            const { recoverIncompleteMigration } = await import(${JSON.stringify(join(import.meta.dir, "migration.ts"))});
            try { recoverIncompleteMigration(${JSON.stringify(globalPath)}); process.exit(2); }
            catch (error) { process.exit(String(error).includes("running") ? 0 : 3); }
        `], { encoding: "utf8", timeout: 10000 });
        expect({ status: child.status, stderr: child.stderr }).toEqual({ status: 0, stderr: "" });
    } } });
    expect(tested).toBe(true);
    expect(JSON.parse(readFileSync(globalPath, "utf8")).host.allowed).toBe(true);
    expect(existsSync(globalPath + ".migration")).toBe(false);
}, 20000);

test("an exited publisher releases ownership so its interrupted transaction can be recovered", () => {
    const { agent, project } = fixture();
    const globalPath = join(agent, "config", "sandbox.json"), projectPath = join(project, "config", "sandbox.json");
    const original = JSON.stringify({ version: 2, machineId: "machine", host: { allowed: false } });
    writeFileSync(globalPath, original, { mode: 0o600 });
    writeFileSync(projectPath, "{}", { mode: 0o600 });
    const child = spawnSync(process.execPath, ["--eval", `
        const { renameSync } = await import("node:fs");
        const { publishSandboxDocuments, previewSandboxDocuments } = await import(${JSON.stringify(join(import.meta.dir, "migration.ts"))});
        const globalPath = ${JSON.stringify(globalPath)}, projectPath = ${JSON.stringify(projectPath)};
        publishSandboxDocuments({ globalPath, projectPath, machineId: "machine", sources: previewSandboxDocuments(globalPath, projectPath), globalLayer: { version: 2, machineId: "machine", host: { allowed: true } }, projectLayer: {}, filesystem: { rename(from, to) {
            renameSync(from, to);
            if (to === globalPath) process.exit(0);
        } } });
        process.exit(2);
    `], { encoding: "utf8", timeout: 10000 });
    expect({ status: child.status, stderr: child.stderr }).toEqual({ status: 0, stderr: "" });
    expect(existsSync(globalPath + ".migration")).toBe(true);
    expect(recoverIncompleteMigration(globalPath)).toEqual({ recovered: "restored" });
    expect(readFileSync(globalPath, "utf8")).toBe(original);
    expect(readFileSync(projectPath, "utf8")).toBe("{}");
    expect(existsSync(globalPath + ".migration")).toBe(false);
}, 20000);
