import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAgentDir, SettingsManager } from '@earendil-works/pi-coding-agent';

// ── Types ──────────────────────────────────────────────

/** Describes a single config source to load. */
export interface ConfigSource {
    /** Settings.json key (e.g. "aiProviders", "slowMode"). Loaded via SettingsManager. */
    settingsKey?: string;
    /**
     * Legacy standalone JSON filename (e.g. "slow-mode.json").
     * Loaded from <agentDir>/<name>.json (global) and optionally <cwd>/.pi/<name>.json (project).
     * Only used as fallback when settingsKey produces no data.
     */
    legacyFilename?: string;
    /** Whether to also load a project-local legacy file. Default: true. */
    projectLocal?: boolean;
    /**
     * When true AND both settingsKey + legacyFilename are present, load BOTH layers
     * and merge them instead of the default cascade (legacy used only when settings
     * is empty). Default: false (cascade preserved).
     *
     * Layer order within the source is controlled by `cumulativeWinner`.
     */
    cumulative?: boolean;
    /**
     * Which layer wins per-key in cumulative mode. Default: 'settings'.
     * Ignored unless `cumulative: true` and both settingsKey + legacyFilename are set.
     *
     * - 'settings': legacy loaded first (global → project), then settings (global → project).
     *   Settings overrides legacy on shared keys.
     * - 'legacy': settings loaded first (global → project), then legacy (global → project).
     *   Legacy overrides settings on shared keys.
     *
     * Inner order (global → project) is always preserved within each layer.
     */
    cumulativeWinner?: 'settings' | 'legacy';
}

/** Options for loadExtensionConfig. */
export interface LoadConfigOptions<T> {
    /** Base default values. Always the bottom layer. */
    defaults: T;
    /** Normalize raw parsed JSON → Partial<T>. Filters out invalid/malformed fields. */
    normalize: (raw: unknown) => Partial<T>;
    /**
     * Sources to load, merged in order (later wins).
     * If omitted, nothing extra is loaded — just defaults returned.
     */
    sources?: ConfigSource[];
    /**
     * Merge strategy. Default: shallow spread (`{ ...base, ...overlay }`).
     * Override for deep/nested merging (e.g. tools, providers maps).
     */
    merge?: (base: T, overlay: Partial<T>) => T;
    /**
     * Override agent directory (for testing).
     * Default: getAgentDir() from @earendil-works/pi-coding-agent.
     */
    agentDir?: string;
    /**
     * Inject a pre-built SettingsManager (for testing).
     * Default: SettingsManager.create(cwd, agentDir).
     */
    _settingsManager?: SettingsManager;
}

// ── Helpers ────────────────────────────────────────────

function defaultMerge<T>(base: T, overlay: Partial<T>): T {
    return { ...base, ...overlay };
}

function readJsonFile<T>(
    path: string,
    normalize: (raw: unknown) => Partial<T>,
): Partial<T> {
    if (!existsSync(path)) return {};
    try {
        const raw = JSON.parse(readFileSync(path, 'utf-8'));
        return normalize(raw);
    } catch {
        return {};
    }
}

/**
 * Load config layers from SettingsManager.
 * Returns [globalLayer, projectLayer] — each may be empty.
 * Caller applies merge per-layer to avoid premature flattening.
 */
function loadLayersFromSettings<T>(
    cwd: string,
    agentDir: string,
    settingsKey: string,
    normalize: (raw: unknown) => Partial<T>,
    injected?: SettingsManager,
): Array<Partial<T>> {
    try {
        const manager = injected ?? SettingsManager.create(cwd, agentDir);
        const globalRaw = (
            manager.getGlobalSettings() as Record<string, unknown>
        )[settingsKey];
        const projectRaw = (
            manager.getProjectSettings() as Record<string, unknown>
        )[settingsKey];
        return [normalize(globalRaw), normalize(projectRaw)];
    } catch {
        return [];
    }
}

/**
 * Load config layers from legacy JSON files.
 * Returns [globalLayer, projectLayer?] — each may be empty.
 * Caller applies merge per-layer to avoid premature flattening.
 */
function loadLayersFromLegacy<T>(
    agentDir: string,
    cwd: string,
    filename: string,
    projectLocal: boolean,
    normalize: (raw: unknown) => Partial<T>,
): Array<Partial<T>> {
    const globalPath = join(agentDir, filename);
    const global = readJsonFile(globalPath, normalize);
    if (!projectLocal) return [global];

    const projectPath = join(cwd, '.pi', filename);
    const project = readJsonFile(projectPath, normalize);
    return [global, project];
}

function isNonEmpty<T>(obj: Partial<T>): boolean {
    return Object.keys(obj).length > 0;
}

// ── Main ───────────────────────────────────────────────

/**
 * Load extension config from settings.json keys and/or legacy JSON files.
 *
 * Resolution order (each layer merges on top of previous):
 *   1. defaults
 *   2. For each source (in order):
 *      - CASCADE (default): Global settings.json key → Project settings.json key.
 *        If settings produced empty result: Global legacy file → Project legacy file.
 *        When settingsKey produces data, legacyFilename is skipped (cascade).
 *      - CUMULATIVE (source.cumulative === true, requires both settingsKey + legacyFilename):
 *        Both layers are loaded and merged. Per-key winner is set by
 *        `source.cumulativeWinner` (default 'settings'). Inner order
 *        (global → project) is always preserved within each layer.
 *   3. Across multiple sources, results merge sequentially (later source wins).
 */
export function loadExtensionConfig<T>(
    cwd: string,
    options: LoadConfigOptions<T>,
): T {
    const {
        defaults,
        normalize,
        sources = [],
        merge = defaultMerge as (base: T, overlay: Partial<T>) => T,
        agentDir: agentDirOverride,
        _settingsManager,
    } = options;

    const agentDir = agentDirOverride ?? getAgentDir();
    let result = { ...defaults };

    for (const src of sources) {
        // Collect layers from this source
        let layers: Array<Partial<T>> = [];

        const useCumulative =
            src.cumulative === true &&
            !!src.settingsKey &&
            !!src.legacyFilename;

        if (useCumulative) {
            // Cumulative: load BOTH legacy + settings, winner loads last.
            const settingsLayers = loadLayersFromSettings(
                cwd,
                agentDir,
                src.settingsKey!,
                normalize,
                _settingsManager,
            ).filter(isNonEmpty);
            const legacyLayers = loadLayersFromLegacy(
                agentDir,
                cwd,
                src.legacyFilename!,
                src.projectLocal ?? true,
                normalize,
            ).filter(isNonEmpty);

            // Winner loads last so it overrides per-key. Inner order
            // (global → project) preserved within each layer.
            layers =
                src.cumulativeWinner === 'legacy'
                    ? [...settingsLayers, ...legacyLayers]
                    : [...legacyLayers, ...settingsLayers];
        } else {
            // Cascade: try settings first
            if (src.settingsKey) {
                const settingsLayers = loadLayersFromSettings(
                    cwd,
                    agentDir,
                    src.settingsKey,
                    normalize,
                    _settingsManager,
                );
                layers = settingsLayers.filter(isNonEmpty);
            }

            // Legacy fallback (only if settings produced nothing)
            if (layers.length === 0 && src.legacyFilename) {
                const legacyLayers = loadLayersFromLegacy(
                    agentDir,
                    cwd,
                    src.legacyFilename,
                    src.projectLocal ?? true,
                    normalize,
                );
                layers = legacyLayers.filter(isNonEmpty);
            }
        }

        // Merge each layer using user-provided merge function
        for (const layer of layers) {
            result = merge(result, layer);
        }
    }

    return result;
}
