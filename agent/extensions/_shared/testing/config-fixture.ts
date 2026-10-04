import { afterEach, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import {
    CONFIG_OWNERS,
    extensionConfigPath,
    type ExtensionConfigOwner,
} from "../config-loader.ts";
const roots: string[] = [];

/** Give runtime tests an empty personal configuration home for each test. */
export function useIsolatedAgentDir(): () => string {
    let directory: string;
    let previous: string | undefined;
    beforeEach(() => {
        previous = process.env.PI_CODING_AGENT_DIR;
        directory = mkdtempSync(join(tmpdir(), "pi-test-agent-"));
        process.env.PI_CODING_AGENT_DIR = directory;
    });
    afterEach(() => {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previous;
        if (directory) rmSync(directory, { recursive: true, force: true });
    });
    return () => directory;
}
afterEach(() => {
    for (const root of roots.splice(0))
        rmSync(root, { recursive: true, force: true });
});
/** Materialize former in-memory settings fixtures in isolated owned config files. */
export function configFixture(
    owner: ExtensionConfigOwner,
    settings: { getGlobalSettings(): unknown; getProjectSettings(): unknown },
): [string, string, boolean] {
    const root = mkdtempSync(join(tmpdir(), "owned-config-"));
    roots.push(root);
    const cwd = join(root, "project"),
        agentDir = join(root, "agent");
    mkdirSync(cwd);
    mkdirSync(agentDir);
    const spec = CONFIG_OWNERS[owner] as {
        settingsKey?: string;
        section?: string;
    };
    for (const [scope, raw] of [
        [{ scope: "global", agentDir }, settings.getGlobalSettings()],
        [{ scope: "project", cwd }, settings.getProjectSettings()],
    ] as const) {
        const value = (raw as Record<string, unknown>)[
            spec.settingsKey ?? owner
        ];
        if (value === undefined) continue;
        const path = extensionConfigPath(owner, scope);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(
            path,
            JSON.stringify(spec.section ? { [spec.section]: value } : value),
        );
    }
    new ProjectTrustStore(agentDir).set(cwd, true);
    return [cwd, agentDir, true];
}

/** Write canonical configuration while retaining core and external settings in their required file. */
export function writeOwnedSettingsFixture(
    settingsPath: string,
    settings: Record<string, unknown>,
): void {
    const core = { ...settings };
    const grouped = new Map<string, Record<string, unknown>>();
    for (const [owner, value] of Object.entries(CONFIG_OWNERS)) {
        const spec = value as { settingsKey?: string; section?: string };
        if (!spec.settingsKey || !(spec.settingsKey in core)) continue;
        const raw = core[spec.settingsKey];
        delete core[spec.settingsKey];
        const path = extensionConfigPath(owner as ExtensionConfigOwner, {
            scope: "global",
            agentDir: dirname(settingsPath),
        });
        const output = grouped.get(path) ?? {};
        if (spec.section) output[spec.section] = raw;
        else if (raw && typeof raw === "object") Object.assign(output, raw);
        if (owner === "plans") delete output.planFileDir;
        grouped.set(path, output);
    }
    for (const [path, raw] of grouped) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(raw));
    }
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(core));
}

export function writeFixtureFile(
    path: string,
    data: Parameters<typeof writeFileSync>[1],
    options?: Parameters<typeof writeFileSync>[2],
): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, data, options ?? { mode: 0o600 });
}

export async function writeFixtureFileAsync(
    path: string,
    data: Parameters<typeof writeFileSync>[1],
    options?: Parameters<typeof writeFileSync>[2],
): Promise<void> {
    writeFixtureFile(path, data, options);
}
