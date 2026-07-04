import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

let tempHome: string;
let previousHome: string | undefined;

function createMockAPI() {
	const commands = new Map<string, any>();
	const handlers = new Map<string, any>();
	let thinkingLevel = "off";

	const pi = {
		on: (event: string, handler: any) => handlers.set(event, handler),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		getThinkingLevel: () => thinkingLevel,
		setThinkingLevel: mock((level: string) => {
			thinkingLevel = level;
		}),
	} as unknown as ExtensionAPI;

	return { pi, commands, handlers };
}

function createMockContext(): ExtensionContext {
	return {
		hasUI: true,
		model: { provider: "test-provider", id: "test-model" },
		ui: { notify: mock(() => undefined) },
	} as unknown as ExtensionContext;
}

async function loadExtension() {
	const modulePath = `./model-thinking.ts?test=${Date.now()}-${Math.random()}`;
	return await import(modulePath) as typeof import("./model-thinking.ts");
}

beforeEach(() => {
	tempHome = mkdtempSync(join(tmpdir(), "pi-model-thinking-"));
	previousHome = process.env.HOME;
	process.env.HOME = tempHome;
});

afterEach(() => {
	if (previousHome === undefined) {
		delete process.env.HOME;
	} else {
		process.env.HOME = previousHome;
	}
	rmSync(tempHome, { recursive: true, force: true });
});

describe("model-thinking extension", () => {
	it("registers mode and flag completions", async () => {
		const { default: modelThinking } = await loadExtension();
		const { pi, commands } = createMockAPI();

		modelThinking(pi);
		const command = commands.get("model-thinking");

		expect(command.getArgumentCompletions("")).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ value: "off", label: "off" }),
				expect.objectContaining({ value: "minimal", label: "minimal" }),
				expect.objectContaining({ value: "--show", label: "--show" }),
				expect.objectContaining({ value: "--reset", label: "--reset" }),
			]),
		);
		expect(command.getArgumentCompletions("hi")).toEqual([
			expect.objectContaining({ value: "high", label: "high" }),
		]);
	});

	it("only shows status for --show", async () => {
		const { default: modelThinking } = await loadExtension();
		const { pi, commands } = createMockAPI();
		const ctx = createMockContext();

		modelThinking(pi);
		const command = commands.get("model-thinking");

		await command.handler("", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Usage:"), "info");
		expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("model:"), expect.anything());

		mock.restore();
		await command.handler("--show", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("model: test-provider/test-model"), "warning");
	});

	it("sets and resets remembered model thinking", async () => {
		const { default: modelThinking } = await loadExtension();
		const { pi, commands } = createMockAPI();
		const ctx = createMockContext();

		modelThinking(pi);
		const command = commands.get("model-thinking");

		await command.handler("high", ctx);
		expect(pi.setThinkingLevel).toHaveBeenCalledWith("high");
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Thinking for test-provider/test-model set to high.",
			"info",
		);

		mock.restore();
		await command.handler("--reset", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith("Model-thinking config cleared.", "info");
	});
});