import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
    CONFIG_DIR_NAME,
    getAgentDir,
    parseArgs,
    ProjectTrustStore,
} from "@earendil-works/pi-coding-agent";
import { extensionPath, type ExtensionScope } from "./extension-paths.ts";

interface ConfigOwner {
    file: string;
    settingsKey?: string;
    legacyFile?: string;
    section?: string;
    globalOnly?: boolean;
}

/** Old locations are retained solely to detect and migrate unmoved user state. */
export const CONFIG_OWNERS = {
    aiProviders: { file: "ai-providers.json", legacyFile: "ai-providers.json" },
    auditMode: { file: "audit-mode.json", settingsKey: "auditMode" },
    translate: {
        file: "translate.json",
        settingsKey: "translate",
        legacyFile: "translate.json",
    },
    safeBash: {
        file: "bash-execution.json",
        settingsKey: "safeBash",
        section: "safeBash",
    },
    bashRewrites: {
        file: "bash-execution.json",
        settingsKey: "bashRewrites",
        section: "bashRewrites",
    },
    markdownLinks: {
        file: "markdown-links.json",
        settingsKey: "markdownLinks",
    },
    packageLifecycleTrust: {
        file: "package-finalizer.json",
        settingsKey: "packageLifecycleTrust",
    },
    codexCompaction: {
        file: "pi-codex-compaction.json",
        legacyFile: "pi-codex-compaction.json",
    },
    dangerousMode: {
        file: "pi-dangerous-mode.json",
        legacyFile: "pi-dangerous-mode.json",
    },
    fileResolver: {
        file: "pi-file-resolver.json",
        settingsKey: "fileResolver",
        legacyFile: "pi-file-resolver.json",
    },
    permissionAddons: {
        file: "pi-permission-system-addons.json",
        legacyFile: "pi-permission-system-addons.json",
    },
    roles: { file: "pi-roles.json", settingsKey: "pi-roles" },
    skillGate: { file: "skill-gate.json", globalOnly: true },
    subagentsAddons: {
        file: "pi-subagents-addons.json",
        legacyFile: "extensions/pi-subagents-addons/config.json",
        globalOnly: true,
    },
    plans: { file: "plans.json", settingsKey: "plans" },
    sandbox: { file: "sandbox.json", legacyFile: "sandbox.json" },
    saveTokens: { file: "save-tokens.json", settingsKey: "saveTokens" },
    sddOrchestrator: {
        file: "sdd-orchestrator.json",
        settingsKey: "sddOrchestrator",
    },
    sessionStatusBar: {
        file: "session-status-bar.json",
        legacyFile: "session-status-bar.json",
        globalOnly: true,
    },
    slowMode: {
        file: "slow-mode.json",
        settingsKey: "slowMode",
        legacyFile: "slow-mode.json",
    },
    thinkInCode: {
        file: "think-in-code.json",
        settingsKey: "thinkInCode",
        legacyFile: "think-in-code.json",
    },
    toolGroups: {
        file: "tool-groups.json",
        settingsKey: "toolGroups",
        legacyFile: "tool-groups.json",
    },
    toolSummary: {
        file: "tool-summary.json",
        settingsKey: "toolSummary",
        legacyFile: "tool-summary.json",
    },
} satisfies Record<string, ConfigOwner>;
export type ExtensionConfigOwner = keyof typeof CONFIG_OWNERS;

/** Pi does not discover .pi/config as a trust resource; runtime auto-admission is insufficient. */
export function isProjectConfigTrusted(
    cwd: string,
    agentDir = getAgentDir(),
    projectTrusted?: boolean,
): boolean {
    return (
        projectTrusted !== false &&
        // Global factories run before ExtensionContext exists. Reuse Pi's public parser for its startup veto.
        parseArgs(process.argv.slice(2)).projectTrustOverride !== false &&
        new ProjectTrustStore(agentDir).get(cwd) === true
    );
}

export function projectConfigTrustNotice(
    cwd: string,
    agentDir = getAgentDir(),
    trustedAtLaunch?: boolean,
): string | undefined {
    const savedTrust = new ProjectTrustStore(agentDir).get(cwd) === true;
    if (
        savedTrust &&
        (trustedAtLaunch !== false || !isProjectConfigTrusted(cwd, agentDir))
    )
        return undefined;
    if (
        !Object.entries(CONFIG_OWNERS).some(
            ([owner, spec]) =>
                !("globalOnly" in spec && spec.globalOnly) &&
                existsSync(
                    extensionConfigPath(owner as ExtensionConfigOwner, {
                        scope: "project",
                        cwd,
                    }),
                ),
        )
    )
        return undefined;
    return savedTrust
        ? "Project trust was saved during this launch. Restart Pi to load all .pi/config settings, including providers and tool groups registered at startup."
        : "Project extension configuration is ignored because saved project trust is not granted. Use /trust to review this project, save a trust decision, and restart Pi to load .pi/config. Session-only trust and --approve do not authorize these files.";
}

export function extensionConfigPath(
    owner: ExtensionConfigOwner,
    scope: ExtensionScope,
): string {
    return extensionPath(scope, "config", CONFIG_OWNERS[owner].file);
}

export function assertExtensionConfigMigrated(
    owner: ExtensionConfigOwner,
    scope: ExtensionScope,
): void {
    const spec: ConfigOwner = CONFIG_OWNERS[owner];
    const base =
        scope.scope === "global"
            ? (scope.agentDir ?? getAgentDir())
            : join(scope.cwd, CONFIG_DIR_NAME);
    if (spec.legacyFile && existsSync(join(base, spec.legacyFile))) {
        throw new Error(
            `Extension configuration needs migration: ${join(base, spec.legacyFile)}. Run the extension-layout migration while Pi is stopped.`,
        );
    }
    if (spec.settingsKey) {
        const settingsPath = join(base, "settings.json");
        if (existsSync(settingsPath)) {
            const settings = readObject(settingsPath);
            if (spec.settingsKey in settings)
                throw new Error(
                    `Extension configuration needs migration: ${settingsPath} (${spec.settingsKey}). Run the extension-layout migration while Pi is stopped.`,
                );
        }
    }
}

export function readExtensionConfig(
    owner: ExtensionConfigOwner,
    scope: ExtensionScope,
): unknown {
    assertExtensionConfigMigrated(owner, scope);
    const spec: ConfigOwner = CONFIG_OWNERS[owner];
    const path = extensionConfigPath(owner, scope);
    if (!existsSync(path)) return undefined;
    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(path, "utf8"));
    } catch {
        throw new Error(`Invalid configuration ${path}`);
    }
    return spec.section && raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)[spec.section]
        : raw;
}

function readObject(path: string): Record<string, unknown> {
    try {
        const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (!raw || typeof raw !== "object" || Array.isArray(raw))
            throw new Error("expected an object");
        return raw as Record<string, unknown>;
    } catch {
        throw new Error(`Invalid configuration ${path}`);
    }
}

export interface LoadConfigOptions<T> {
    owner: ExtensionConfigOwner;
    defaults: T;
    normalize: (raw: unknown) => Partial<T>;
    merge?: (base: T, overlay: Partial<T>) => T;
    agentDir?: string;
    projectTrusted?: boolean;
}

/** Owner normalization and merging stay at the caller; path and trust rules live here. */
export function loadExtensionConfig<T>(
    cwd: string,
    options: LoadConfigOptions<T>,
): T {
    const spec: ConfigOwner = CONFIG_OWNERS[options.owner];
    const scopes: ExtensionScope[] = [
        { scope: "global", agentDir: options.agentDir },
    ];
    if (
        !spec.globalOnly &&
        isProjectConfigTrusted(cwd, options.agentDir, options.projectTrusted)
    )
        scopes.push({ scope: "project", cwd });
    let result = { ...options.defaults };
    for (const scope of scopes) {
        const raw = readExtensionConfig(options.owner, scope);
        if (raw === undefined) continue;
        const layer = options.normalize(raw);
        result = options.merge
            ? options.merge(result, layer)
            : { ...result, ...layer };
    }
    return result;
}
