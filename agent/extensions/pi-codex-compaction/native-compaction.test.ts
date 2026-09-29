import { expect, test } from "bun:test";
import codexCompactionExtension from "./index.ts";
import { buildSessionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import {
	buildCodexHeaders,
	effectiveInputForBranch,
	modelKey,
	NATIVE_COMPACTION_KIND,
	NATIVE_COMPACTION_VERSION,
} from "./native-compaction.ts";

const model: Model<"openai-codex-responses"> = {
	api: "openai-codex-responses",
	id: "fixture",
	name: "Fixture",
	provider: "openai-codex",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
};

test("extension entrypoint registers Codex compaction without changing other providers", () => {
	const handlers = new Map<string, (event: { headers: Record<string, string | null> }, ctx: { model: unknown }) => void>();
	const pi = {
		registerEntryRenderer: () => {},
		on: (name: string, handler: (event: { headers: Record<string, string | null> }, ctx: { model: unknown }) => void) => {
			handlers.set(name, handler);
		},
	} as unknown as Parameters<typeof codexCompactionExtension>[0];
	codexCompactionExtension(pi);

	const beforeHeaders = handlers.get("before_provider_headers");
	expect(beforeHeaders).toBeDefined();
	const unrelated = { headers: {} as Record<string, string | null> };
	beforeHeaders!(unrelated, { model: { provider: "other", api: "openai-codex-responses" } });
	expect(unrelated.headers).toEqual({});
	const codex = { headers: {} as Record<string, string | null> };
	beforeHeaders!(codex, { model });
	expect(codex.headers["x-codex-beta-features"]).toContain("remote_compaction_v2");
});

function branchWithEdit(replacement: { content: string } | null): SessionEntry[] {
	const timestamp = "2026-09-23T00:00:00.000Z";
	return [
		{ type: "message", id: "u1", parentId: null, timestamp, message: { role: "user", content: "Keep", timestamp: 1 } },
		{
			type: "custom",
			id: "checkpoint",
			parentId: "u1",
			timestamp,
			customType: NATIVE_COMPACTION_KIND,
			data: {
				kind: NATIVE_COMPACTION_KIND,
				version: NATIVE_COMPACTION_VERSION,
				modelKey: modelKey(model),
				replacementHistory: [{ type: "compaction", encrypted_content: "fixture" }],
			},
		},
		{ type: "message", id: "u2", parentId: "checkpoint", timestamp, message: { role: "user", content: "Original", timestamp: 2 } },
		{ type: "context_edit", id: "edit", parentId: "u2", timestamp, targetId: "u2", replacement },
	];
}

test("native checkpoint excludes a tail message omitted by context_edit", () => {
	const branch = branchWithEdit(null);
	expect(buildSessionContext(branch).messages.filter(message => message.role === "user").map(message => message.content)).toEqual(["Keep"]);
	const input = effectiveInputForBranch({ branch, model, tools: [] });
	expect(input).toEqual([{ type: "compaction", encrypted_content: "fixture" }]);
});

test("Codex headers omit provider fields suppressed with null", () => {
	const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.signature`;
	const headers = buildCodexHeaders({
		apiKey: token,
		headers: { "x-suppressed": null, "x-kept": "yes" },
		sessionId: "session",
	});
	expect(headers.has("x-suppressed")).toBe(false);
	expect(headers.get("x-kept")).toBe("yes");
});

test("native checkpoint uses the edited tail content", () => {
	const branch = branchWithEdit({ content: "Revised" });
	expect(buildSessionContext(branch).messages.filter(message => message.role === "user").map(message => message.content)).toEqual(["Keep", "Revised"]);
	const input = effectiveInputForBranch({ branch, model, tools: [] });
	expect(input).toEqual([
		{ type: "compaction", encrypted_content: "fixture" },
		{ role: "user", content: [{ type: "input_text", text: "Revised" }] },
	]);
});
