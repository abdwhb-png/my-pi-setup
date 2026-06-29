/**
 * ai-providers — General-purpose Pi extension for subscription-based model providers.
 *
 * Currently supports:
 * - Factory AI (factory-ai) — via @factory/droid-sdk
 *
 * Future providers can be added under providers/ without restructuring.
 *
 * Usage:
 *   1. Run `/login factory-ai` and enter your Factory API key
 *      (generate one at https://app.factory.ai/settings/api-keys)
 *   2. Use `/model` to select a Factory AI model
 *   3. Requires `droid` CLI to be installed (npm install -g @factory/droid)
 *
 * Provider availability can be controlled via settings:
 * - ~/.pi/agent/settings.json under key "aiProviders"
 * - <cwd>/.pi/settings.json under key "aiProviders"
 * - legacy fallback: ~/.pi/agent/ai-providers.json and <cwd>/.pi/ai-providers.json
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isProviderEnabled, isWidgetEnabled } from "./config.ts";
import { registerFactoryProvider } from "./providers/factory-ai.ts";
import { registerFactoryCreditsWidget } from "./widgets/factory-credits.ts";

const FACTORY_PROVIDER = "factory-ai";
const FACTORY_WIDGET = "factory-credits";

export default function aiProvidersExtension(pi: ExtensionAPI): void {
	const cwd = process.cwd();

	// ── Factory AI ──
	if (isProviderEnabled(FACTORY_PROVIDER, cwd)) {
		registerFactoryProvider(pi);
		if (isWidgetEnabled(FACTORY_WIDGET, cwd)) {
			registerFactoryCreditsWidget(pi);
		}
	}

	// ── Future providers go here ──
	// Example:
	// if (isProviderEnabled("openrouter", cwd)) registerOpenRouterProvider(pi);
	// if (isProviderEnabled("groq", cwd)) registerGroqProvider(pi);
}
