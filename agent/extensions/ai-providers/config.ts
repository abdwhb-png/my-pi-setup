/**
 * ai-providers config loader
 *
 * Config files (merged, project takes precedence):
 * - ~/.pi/agent/settings.json under key "aiProviders" (global)
 * - <cwd>/.pi/settings.json under key "aiProviders" (project-local)
 * - legacy fallback: ~/.pi/agent/ai-providers.json and <cwd>/.pi/ai-providers.json
 *
 * Example .pi/settings.json:
 * {
 *   "aiProviders": {
 *     "providers": {
 *       "factory-ai": false
 *     }
 *   }
 * }
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

export interface AiProvidersConfig {
	providers: Record<string, boolean>;
	widgets: Record<string, boolean>;
	maxVisibleRows?: number;
}

const DEFAULT_CONFIG: AiProvidersConfig = {
	providers: {},
	widgets: {},
};

function normalizeBooleanMap(raw: unknown): Record<string, boolean> {
	if (!raw || typeof raw !== "object") return {};
	const result: Record<string, boolean> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (typeof value === "boolean") {
			result[key] = value;
		}
	}
	return result;
}

function normalizeConfig(raw: unknown): Partial<AiProvidersConfig> {
	if (!raw || typeof raw !== "object") return {};
	const value = raw as Record<string, unknown>;
	
	const config: Partial<AiProvidersConfig> = {
		providers: normalizeBooleanMap(value.providers),
		widgets: normalizeBooleanMap(value.widgets),
	};
	
	if (typeof value.maxVisibleRows === "number") {
		config.maxVisibleRows = value.maxVisibleRows;
	}
	
	return config;
}

function readLegacyConfig(path: string): Partial<AiProvidersConfig> {
	if (!existsSync(path)) return {};
	try {
		return normalizeConfig(JSON.parse(readFileSync(path, "utf-8")));
	} catch {
		return {};
	}
}

function mergeConfig(
	base: AiProvidersConfig,
	overrides: Partial<AiProvidersConfig>,
): AiProvidersConfig {
	return {
		providers: {
			...base.providers,
			...(overrides.providers ?? {}),
		},
		widgets: {
			...base.widgets,
			...(overrides.widgets ?? {}),
		},
		maxVisibleRows: overrides.maxVisibleRows ?? base.maxVisibleRows,
	};
}

export function loadAiProvidersConfig(cwd = process.cwd()): AiProvidersConfig {
	const projectLegacyPath = join(cwd, ".pi", "ai-providers.json");
	const globalLegacyPath = join(getAgentDir(), "ai-providers.json");

	let globalConfig: Partial<AiProvidersConfig> = {};
	let projectConfig: Partial<AiProvidersConfig> = {};

	try {
		const manager = SettingsManager.create(cwd);
		const globalSettings = manager.getGlobalSettings() as Record<string, unknown>;
		const projectSettings = manager.getProjectSettings() as Record<string, unknown>;
		globalConfig = normalizeConfig(globalSettings.aiProviders);
		projectConfig = normalizeConfig(projectSettings.aiProviders);
	} catch {
		// fall through to legacy files only
	}

	if (Object.keys(globalConfig).length === 0) {
		globalConfig = readLegacyConfig(globalLegacyPath);
	}
	if (Object.keys(projectConfig).length === 0) {
		projectConfig = readLegacyConfig(projectLegacyPath);
	}

	return mergeConfig(mergeConfig(DEFAULT_CONFIG, globalConfig), projectConfig);
}

export function isProviderEnabled(providerName: string, cwd = process.cwd()): boolean {
	const config = loadAiProvidersConfig(cwd);
	return config.providers[providerName] ?? true;
}

export function isWidgetEnabled(widgetId: string, cwd = process.cwd()): boolean {
	const config = loadAiProvidersConfig(cwd);
	return config.widgets[widgetId] ?? true;
}
