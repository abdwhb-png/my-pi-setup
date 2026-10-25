// Explicit ESM lets Oxlint's Node worker share this registry with Pi's Bun/Jiti loader.
export interface ConfigOwner {
    file: string;
    settingsKey?: string;
    legacyFile?: string;
    section?: string;
    globalOnly?: boolean;
}

/** Old locations are retained solely to detect and migrate unmoved user state. */
export const CONFIG_OWNERS = {
    browserTools: { file: 'browser-tools.json' },
    aiProviders: { file: 'ai-providers.json', legacyFile: 'ai-providers.json' },
    auditMode: { file: 'audit-mode.json', settingsKey: 'auditMode' },
    translate: {
        file: 'translate.json',
        settingsKey: 'translate',
        legacyFile: 'translate.json',
    },
    safeBash: {
        file: 'bash-execution.json',
        settingsKey: 'safeBash',
        section: 'safeBash',
    },
    bashRewrites: {
        file: 'bash-execution.json',
        settingsKey: 'bashRewrites',
        section: 'bashRewrites',
    },
    markdownLinks: {
        file: 'markdown-links.json',
        settingsKey: 'markdownLinks',
    },
    packageLifecycleTrust: {
        file: 'package-finalizer.json',
        settingsKey: 'packageLifecycleTrust',
    },
    codexCompaction: {
        file: 'pi-codex-compaction.json',
        legacyFile: 'pi-codex-compaction.json',
    },
    dangerousMode: {
        file: 'pi-dangerous-mode.json',
        legacyFile: 'pi-dangerous-mode.json',
    },
    fileResolver: {
        file: 'pi-file-resolver.json',
        settingsKey: 'fileResolver',
        legacyFile: 'pi-file-resolver.json',
    },
    permissionAddons: {
        file: 'pi-permission-system-addons.json',
        legacyFile: 'pi-permission-system-addons.json',
    },
    roles: { file: 'pi-roles.json', settingsKey: 'pi-roles' },
    skillGate: { file: 'skill-gate.json', globalOnly: true },
    subagentsAddons: {
        file: 'pi-subagents-addons.json',
        legacyFile: 'extensions/pi-subagents-addons/config.json',
        globalOnly: true,
    },
    plans: { file: 'plans.json', settingsKey: 'plans' },
    sandbox: { file: 'sandbox.json', legacyFile: 'sandbox.json' },
    saveTokens: { file: 'save-tokens.json', settingsKey: 'saveTokens' },
    sddOrchestrator: {
        file: 'sdd-orchestrator.json',
        settingsKey: 'sddOrchestrator',
    },
    sessionStatusBar: {
        file: 'session-status-bar.json',
        legacyFile: 'session-status-bar.json',
        globalOnly: true,
    },
    slowMode: {
        file: 'slow-mode.json',
        settingsKey: 'slowMode',
        legacyFile: 'slow-mode.json',
    },
    thinkInCode: {
        file: 'think-in-code.json',
        settingsKey: 'thinkInCode',
        legacyFile: 'think-in-code.json',
    },
    toolGroups: {
        file: 'tool-groups.json',
        settingsKey: 'toolGroups',
        legacyFile: 'tool-groups.json',
    },
    toolSummary: {
        file: 'tool-summary.json',
        settingsKey: 'toolSummary',
        legacyFile: 'tool-summary.json',
    },
} satisfies Record<string, ConfigOwner>;
export type ExtensionConfigOwner = keyof typeof CONFIG_OWNERS;
