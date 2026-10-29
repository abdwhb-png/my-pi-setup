import { expect, test } from "bun:test";
import { buildDockerUpdate } from "./docker-configuration.ts";

test("a remembered command grant preserves unrelated policy and requires explicit host approval", () => {
    const selector = { type: "container-name", name: "api" } as const;
    const global = { version: 2, machineId: "fixture", network: { keep: true }, docker: { allowed: true } };
    const project = { docker: { enabled: true } };
    expect(() => buildDockerUpdate(global, project, { selector, operations: ["exec"], hostAccessRequired: true, hostAccess: false })).toThrow("host access");
    const update = buildDockerUpdate(global, project, { selector, operations: ["exec"], hostAccessRequired: true, hostAccess: true });
    expect(update.global.network).toEqual({ keep: true });
    expect(update.global.docker).toMatchObject({ unsafeTargets: [selector], trustedExecTargets: [selector] });
    expect(update.project.docker).toMatchObject({ targets: [{ selector, operations: ["exec"] }] });
    expect(global.docker).toEqual({ allowed: true });
});

test("configuration cannot exceed the global operation limit", () => {
    expect(() => buildDockerUpdate({ docker: { allowed: true, operations: ["logs"] } }, {}, { selector: { type: "container-name", name: "api" }, operations: ["exec"], hostAccessRequired: false, hostAccess: false })).toThrow("beyond global limits");
});

test("editing project operations does not revoke global trust used by other projects", () => {
    const selector = { type: "container-name", name: "api" } as const;
    const update = buildDockerUpdate({ docker: { allowed: true, unsafeTargets: [selector], trustedExecTargets: [selector] } }, {}, { selector, operations: ["logs"], hostAccessRequired: false, hostAccess: false });
    expect(update.global.docker.unsafeTargets).toEqual([selector]);
    expect(update.global.docker.trustedExecTargets).toEqual([selector]);
});

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExtensionAPI, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { createTestSession } from "@abdwhb-png/pi-test-harness";
import { manageDockerAccess } from "./docker-configuration.ts";

test.each([false, true])("real Pi consent (%s) controls engine-information publication", async accepted => {
    const root = mkdtempSync(join(tmpdir(), "pi-docker-consent-"));
    let session: Awaited<ReturnType<typeof createTestSession>> | undefined;
    try {
        mkdirSync(join(root, "config"), { recursive: true });
        mkdirSync(join(root, ".pi", "config"), { recursive: true });
        new ProjectTrustStore(root).set(root, true);
        const globalPath = join(root, "config", "sandbox.json"), projectPath = join(root, ".pi", "config", "sandbox.json");
        const originalGlobal = JSON.stringify({ version: 2, machineId: "fixture", docker: { allowed: true }, environment: { variables: { PRIVATE_FIXTURE: "retained" } } });
        writeFileSync(globalPath, originalGlobal, { mode: 0o600 });
        writeFileSync(projectPath, "{}", { mode: 0o600 });
        let applied = 0;
        session = await createTestSession({ cwd: root,
            extensionFactories: [(pi: ExtensionAPI) => { pi.registerCommand("configure-docker-test", { description: "Configure isolated Docker permissions", handler: async (_args, ctx) => manageDockerAccess(ctx, { agentDir: root, machineId: "fixture", onChanged: async () => { applied++; } }) }); }],
            mockUI: { select: title => title === "Configure Docker access" ? "Engine information permission" : "Allow for this project", confirm: accepted },
        });
        await session.session.prompt("/configure-docker-test");
        expect(session.events.uiCallsFor("confirm")).toHaveLength(1);
        expect(applied).toBe(accepted ? 1 : 0);
        if (!accepted) {
            expect(readFileSync(globalPath, "utf8")).toBe(originalGlobal);
            expect(readFileSync(projectPath, "utf8")).toBe("{}");
        } else {
            expect(JSON.parse(readFileSync(globalPath, "utf8"))).toMatchObject({ docker: { allowEngineInfo: true }, environment: { variables: { PRIVATE_FIXTURE: "retained" } } });
            expect(JSON.parse(readFileSync(projectPath, "utf8"))).toEqual({ docker: { enabled: true, engineInfo: true } });
        }
    } finally { session?.dispose(); rmSync(root, { recursive: true, force: true }); }
});
