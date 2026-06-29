/**
 * Factory Credit Widget
 *
 * Shows live credit usage for Factory AI models in the footer.
 * Only visible when the current model's provider is "factory-ai".
 *
 * Credit calculation: accumulated totalTokens × model multiplier.
 * Displayed as compact badge: "4× · 12.3k credits"
 */

import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
	SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { createWidget } from "../../_shared/fancy-footer.ts";
import { getFactoryModelMultiplier } from "../providers/factory-models.ts";

// ── Constants ──

const WIDGET_ID = "factory-credits";
const REFRESH_MS = 5000;
const PROVIDER_NAME = "factory-ai";

// ── Helpers ──

function isSessionMessageEntry(e: SessionEntry): e is SessionMessageEntry {
	return e.type === "message";
}

function formatCredits(n: number): string {
	if (n < 1000) return n.toString();
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

function parseMultiplierFromModelName(model?: Model<any>): number | undefined {
	const match = model?.name?.match(/\[(\d+(?:\.\d+)?)×\]$/);
	if (!match) return undefined;
	const value = Number(match[1]);
	return Number.isFinite(value) ? value : undefined;
}

function getCurrentMultiplier(model?: Model<any>): number {
	return (
		(model ? getFactoryModelMultiplier(model.id) : undefined) ??
		parseMultiplierFromModelName(model) ??
		1
	);
}

// ── State ──

interface FactoryCreditState {
	visible: boolean;
	multiplier: number;
	totalCredits: number;
}

function buildState(ctx: ExtensionContext): FactoryCreditState {
	const currentModel = ctx.model;
	const isFactory = currentModel?.provider === PROVIDER_NAME;

	if (!isFactory) {
		return { visible: false, multiplier: 0, totalCredits: 0 };
	}

	const currentMultiplier = getCurrentMultiplier(currentModel);

	const messages = ctx.sessionManager
		.getBranch()
		.filter(isSessionMessageEntry)
		.map((e) => e.message as AssistantMessage)
		.filter(
			(m) => m.provider === PROVIDER_NAME && m.stopReason !== "aborted",
		);

	let totalCredits = 0;
	for (const msg of messages) {
		const multiplier = getFactoryModelMultiplier(msg.model) ?? currentMultiplier;
		const tokens = msg.usage?.totalTokens ?? 0;
		totalCredits += tokens * multiplier;
	}

	return {
		visible: true,
		multiplier: currentMultiplier,
		totalCredits,
	};
}

// ── Render ──

function render(state: FactoryCreditState): string | null {
	if (!state.visible) return null;

	const multiplier = `${state.multiplier}×`;
	const credits = formatCredits(state.totalCredits);
	return `${multiplier} · ${credits} credits`;
}

// ── Extension ──

export function registerFactoryCreditsWidget(pi: ExtensionAPI): void {
	let latestCtx: ExtensionContext | null = null;
	let refreshTimer: ReturnType<typeof setInterval> | null = null;
	let widgetText: string | null = null;

	const w = createWidget(pi, {
		id: WIDGET_ID,
		label: "Factory Credits",
		description:
			"Live Factory AI credit usage tracking (multiplier × tokens).",
		row: 0,
		order: 60,
		align: "right",
		render: () => widgetText,
	});

	async function updateWidget() {
		if (!latestCtx?.hasUI) return;
		try {
			const state = buildState(latestCtx);
			widgetText = render(state);
		} catch {
			widgetText = null;
		}
		w.update(latestCtx);
	}

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		if (!ctx.hasUI) return;

		updateWidget();
		if (refreshTimer) clearInterval(refreshTimer);
		refreshTimer = setInterval(updateWidget, REFRESH_MS);
	});

	pi.on("agent_end", async (_event, ctx) => {
		latestCtx = ctx;
		updateWidget();
	});

	pi.on("session_shutdown", async () => {
		if (refreshTimer) {
			clearInterval(refreshTimer);
			refreshTimer = null;
		}
		latestCtx = null;
	});
}
