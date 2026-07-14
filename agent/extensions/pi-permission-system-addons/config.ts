import { loadExtensionConfig } from '../_shared/config-loader.ts';

export interface AddonConfig {
    inherit: Record<string, string>;
    /** Auto-approve all inherited 'ask' permission checks. */
    yolo?: boolean;
}

export class AddonConfigError extends Error {
    constructor(message: string) {
        super(`[pi-permission-system-addons] ${message}`);
        this.name = 'AddonConfigError';
    }
}

function normalize(raw: unknown): Partial<AddonConfig> {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return {};
    }
    const obj = raw as Record<string, unknown>;
    const result: Partial<AddonConfig> = {};

    // yolo flag
    if (typeof obj.yolo === 'boolean') {
        result.yolo = obj.yolo;
    }

    // inherit map
    const inheritRaw = obj.inherit;
    if (
        inheritRaw !== undefined &&
        typeof inheritRaw === 'object' &&
        inheritRaw !== null &&
        !Array.isArray(inheritRaw)
    ) {
        const inherit: Record<string, string> = {};
        for (const [tool, surface] of Object.entries(
            inheritRaw as Record<string, unknown>,
        )) {
            if (typeof surface === 'string' && surface.length > 0) {
                inherit[tool] = surface;
            }
        }
        result.inherit = inherit;
    }

    return result;
}

export function loadConfig(cwd: string, agentDir?: string): AddonConfig {
    return loadExtensionConfig(cwd, {
        defaults: { inherit: {} },
        normalize,
        sources: [{ legacyFilename: 'pi-permission-system-addons.json' }],
        agentDir,
    });
}
