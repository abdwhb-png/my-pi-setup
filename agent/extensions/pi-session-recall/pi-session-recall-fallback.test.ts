import { beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const completeMock = mock(async () => ({
  stopReason: "stop" as const,
  content: [{ type: "text" as const, text: "fallback answer" }],
}));

mock.module("@earendil-works/pi-ai", () => ({
  complete: completeMock,
}));

let agentDir = mkdtempSync(join(tmpdir(), "pi-session-recall-agent-"));
const sessionMessages = [
  {
    role: "user",
    content: [{ type: "text", text: "What happened?" }],
    timestamp: Date.now(),
  },
];

mock.module("@earendil-works/pi-coding-agent", () => ({
  getAgentDir: () => agentDir,
  SessionManager: {
    open: () => ({
      getBranch: () => sessionMessages.map((message) => ({ type: "message", message })),
    }),
  },
  convertToLlm: (messages: any[]) => messages,
  serializeConversation: (messages: any[]) => JSON.stringify(messages),
  getMarkdownTheme: () => ({}),
}));

mock.module("@earendil-works/pi-tui", () => ({
  Container: class { addChild() {} },
  Input: class {},
  Markdown: class {},
  SelectList: class {},
  Spacer: class {},
  Text: class {},
}));

const { default: sessionRecall } = await import("../pi-session-recall/index.ts");

function createMockAPI() {
  const tools = new Map<string, any>();
  const pi = {
    registerCommand: mock(),
    registerTool: (tool: any) => tools.set(tool.name, tool),
  } as any;
  sessionRecall(pi);
  return { tools };
}

function createModel(provider: string, id: string) {
  return { provider, id, contextWindow: 100_000 };
}

describe("pi-session-recall fallback models", () => {
  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "pi-session-recall-agent-"));
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "session.jsonl"), "{}\n");
    completeMock.mockClear();
  });

  it("tries configured fallback-models when the primary query model has no auth", async () => {
    writeFileSync(
      join(agentDir, "pi-session-recall.json"),
      JSON.stringify({
        queryModel: { provider: "primary", id: "bad" },
        "fallback-models": [{ provider: "fallback", id: "good" }],
      }),
    );

    const primary = createModel("primary", "bad");
    const fallback = createModel("fallback", "good");
    const ctx = {
      model: createModel("current", "model"),
      modelRegistry: {
        find: mock((provider: string, id: string) => {
          if (provider === "primary" && id === "bad") return primary;
          if (provider === "fallback" && id === "good") return fallback;
          return undefined;
        }),
        getApiKeyAndHeaders: mock(async (model: any) =>
          model === primary
            ? { ok: false, error: "missing primary auth" }
            : { ok: true, apiKey: "key", headers: {} },
        ),
      },
    } as any;

    const { tools } = createMockAPI();
    const result = await tools.get("pi_session_query").execute(
      "tool-call",
      { sessionPath: join(agentDir, "session.jsonl"), question: "What happened?" },
      undefined,
      undefined,
      ctx,
    );

    expect(completeMock).toHaveBeenCalledWith(
      fallback,
      expect.anything(),
      expect.objectContaining({ apiKey: "key" }),
    );
    expect(result.content[0].text).toContain("Answered by good (fallback)");
  });
});