import { loadExtensionConfig } from '../config-loader.ts';

export interface PackageLifecycleTrustConfig {
    /** When true, ask onConfirm before trusting a package. Default: false. */
    confirm: boolean;
    /** Log trusted packages at startup. Default: true. */
    showStatus: boolean;
}

const DEFAULT_CONFIG: PackageLifecycleTrustConfig = {
    confirm: false,
    showStatus: true,
};

function normalizePackageLifecycleTrustConfig(
    raw: unknown,
): Partial<PackageLifecycleTrustConfig> {
    if (typeof raw !== 'object' || raw === null) return {};
    const obj = raw as Record<string, unknown>;
    const out: Partial<PackageLifecycleTrustConfig> = {};
    if (typeof obj.confirm === 'boolean') out.confirm = obj.confirm;
    if (typeof obj.showStatus === 'boolean') out.showStatus = obj.showStatus;
    return out;
}

/**
 * Load package lifecycle trust config from settings.json key `packageLifecycleTrust`.
 *
 * Example settings.json:
 *   { "packageLifecycleTrust": { "confirm": false, "showStatus": true } }
 */
export function loadPackageLifecycleTrustConfig(
    cwd: string,
    agentDir?: string,
): PackageLifecycleTrustConfig {
    return loadExtensionConfig<PackageLifecycleTrustConfig>(cwd, {
        defaults: DEFAULT_CONFIG,
        normalize: normalizePackageLifecycleTrustConfig,
        sources: [
            {
                settingsKey: 'packageLifecycleTrust',
                projectLocal: true,
            },
        ],
        agentDir,
    });
}
