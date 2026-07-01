import { describe, expect, it, mock } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createCompressionMetrics,
  createToolResultHandler,
  extractCompressibleText,
  formatDetailedStats,
  formatStatsStatus,
  formatStatsWidgetLines,
  getLocalCompressorConfig,
  isCompressibleToolName,
} from "./local-tool-result-compressor";

describe("isCompressibleToolName", () => {
  it("supports read grep bash safe_bash ls find", () => {
    expect(isCompressibleToolName("read")).toBe(true);
    expect(isCompressibleToolName("grep")).toBe(true);
    expect(isCompressibleToolName("bash")).toBe(true);
    expect(isCompressibleToolName("safe_bash")).toBe(true);
    expect(isCompressibleToolName("ls")).toBe(true);
    expect(isCompressibleToolName("find")).toBe(true);
  });

  it("rejects unsupported tools", () => {
    expect(isCompressibleToolName("write")).toBe(false);
    expect(isCompressibleToolName("edit")).toBe(false);
    expect(isCompressibleToolName("custom")).toBe(false);
  });
});

describe("extractCompressibleText", () => {
  it("extracts text when all blocks are text", () => {
    const result = extractCompressibleText([
      { type: "text", text: "hello" },
      { type: "text", text: "world" },
    ]);
    expect(result).toBe("hello\nworld");
  });

  it("returns null for mixed text and image content", () => {
    const result = extractCompressibleText([
      { type: "text", text: "hello" },
      { type: "image", mimeType: "image/png", data: "abc" },
    ]);
    expect(result).toBeNull();
  });
});

describe("getLocalCompressorConfig", () => {
  it("reads env with sane defaults and showStatus disabled", () => {
    delete process.env.EDGEE_COMPRESSOR_BASE_URL;
    delete process.env.EDGEE_COMPRESSOR_AGENT;
    expect(getLocalCompressorConfig()).toEqual({
      baseUrl: "http://127.0.0.1:8320",
      agent: "claude",
      timeoutMs: 800,
      showStatus: false,
      showWidget: true,
    });
  });
});

describe("createCompressionMetrics", () => {
  it("tracks compressed results and saved characters per tool", () => {
    const metrics = createCompressionMetrics();
    metrics.record({ kind: "compressed", toolName: "read", originalLength: 100, compressedLength: 40 });
    metrics.record({ kind: "compressed", toolName: "grep", originalLength: 80, compressedLength: 20 });
    metrics.record({ kind: "skipped", toolName: "find", reason: "no_change", originalLength: 10 });
    metrics.record({ kind: "failed", toolName: "bash", reason: "service_error", originalLength: 20 });

    expect(metrics.snapshot()).toMatchObject({
      seen: 4,
      compressed: 2,
      skipped: 1,
      failed: 1,
      bytesSaved: 120,
      toolCounts: {
        bash: 0,
        find: 0,
        grep: 1,
        read: 1,
      },
      toolStats: {
        bash: { compressed: 0, failed: 1, skipped: 0, bytesSaved: 0 },
        find: { compressed: 0, failed: 0, skipped: 1, bytesSaved: 0 },
        grep: { compressed: 1, failed: 0, skipped: 0, bytesSaved: 60 },
        read: { compressed: 1, failed: 0, skipped: 0, bytesSaved: 60 },
      },
      firstCompressedTools: ["read", "grep"],
    });

    metrics.reset();
    expect(metrics.snapshot()).toMatchObject({
      seen: 0,
      compressed: 0,
      skipped: 0,
      failed: 0,
      bytesSaved: 0,
      toolCounts: {},
      toolStats: {},
    });
  });

  it("formats readable status and widget lines", () => {
    const metrics = createCompressionMetrics();
    metrics.record({ kind: "compressed", toolName: "read", originalLength: 100, compressedLength: 40 });
    metrics.record({ kind: "compressed", toolName: "safe_bash", originalLength: 90, compressedLength: 50 });
    metrics.record({ kind: "failed", toolName: "ls", reason: "service_error", originalLength: 20 });

    expect(formatStatsStatus(metrics.snapshot())).toBe("cmp 2/3 ok • saved 100B • fail 1");
    expect(formatStatsWidgetLines(metrics.snapshot(), "http://127.0.0.1:8320")).toEqual([
      "compressor http://127.0.0.1:8320",
      "ok 2/3 • saved 100B • fail 1 • top: read 60B, safe_bash 40B",
    ]);

    expect(formatDetailedStats(metrics.snapshot(), "http://127.0.0.1:8320")).toContain("1. read — saved 60B • ok 1 • skipped 0 • fail 0");
  });
});

describe("createToolResultHandler", () => {
  it("skips unsupported tools", async () => {
    const fetchImpl = mock(() => Promise.resolve(new Response("{}")));
    const handler = createToolResultHandler({ fetchImpl });
    const event = {
      toolName: "write",
      toolCallId: "1",
      input: { path: "a" },
      content: [{ type: "text", text: "hello" }],
      isError: false,
      details: undefined,
    };
    await expect(handler(event as any)).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("records compression observations", async () => {
    const observations: unknown[] = [];
    const fetchImpl = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.tool_name).toBe("read");
      return Response.json({ compressed_output: "trimmed" }, { status: 200 });
    });
    const handler = createToolResultHandler({
      fetchImpl,
      baseUrl: "http://127.0.0.1:8320",
      onObservation: (event) => observations.push(event),
    });
    const event = {
      toolName: "read",
      toolCallId: "1",
      input: { path: "src/main.rs" },
      content: [{ type: "text", text: "very long output" }],
      isError: false,
      details: undefined,
    };
    await expect(handler(event as any)).resolves.toEqual({
      content: [{ type: "text", text: "trimmed" }],
    });
    expect(observations).toEqual([
      {
        kind: "compressed",
        toolName: "read",
        originalLength: "very long output".length,
        compressedLength: "trimmed".length,
      },
    ]);
  });

  it("records skipped events for mixed content", async () => {
    const observations: unknown[] = [];
    const fetchImpl = mock(() => Promise.resolve(new Response("{}")));
    const handler = createToolResultHandler({
      fetchImpl,
      onObservation: (event) => observations.push(event),
    });
    const event = {
      toolName: "read",
      toolCallId: "1",
      input: { path: "a" },
      content: [
        { type: "text", text: "hello" },
        { type: "image", mimeType: "image/png", data: "abc" },
      ],
      isError: false,
      details: undefined,
    };
    await expect(handler(event as any)).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(observations).toEqual([
      {
        kind: "skipped",
        toolName: "read",
        reason: "non_text_content",
        originalLength: 0,
      },
    ]);
  });

  it("records failed events when service unavailable", async () => {
    const observations: unknown[] = [];
    const fetchImpl = mock(() => Promise.reject(new Error("offline")));
    const handler = createToolResultHandler({
      fetchImpl,
      baseUrl: "http://127.0.0.1:8320",
      onObservation: (event) => observations.push(event),
    });
    const event = {
      toolName: "grep",
      toolCallId: "1",
      input: { pattern: "foo", path: "src" },
      content: [{ type: "text", text: "src/a.rs:1: foo" }],
      isError: false,
      details: undefined,
    };
    await expect(handler(event as any)).resolves.toBeUndefined();
    expect(observations).toEqual([
      {
        kind: "failed",
        toolName: "grep",
        reason: "service_error",
        originalLength: "src/a.rs:1: foo".length,
      },
    ]);
  });

  it("maps ls and find to glob and safe_bash to bash", async () => {
    const seenToolNames: string[] = [];
    const fetchImpl = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      seenToolNames.push(body.tool_name);
      return Response.json({ compressed_output: "trimmed" }, { status: 200 });
    });
    const handler = createToolResultHandler({ fetchImpl, baseUrl: "http://127.0.0.1:8320" });

    await handler({
      toolName: "ls",
      toolCallId: "1",
      input: { path: ".", all: true },
      content: [{ type: "text", text: "file1\nfile2\nfile3" }],
      isError: false,
      details: undefined,
    } as any);
    await handler({
      toolName: "find",
      toolCallId: "2",
      input: { pattern: "*.ts", path: "src" },
      content: [{ type: "text", text: "src/a.ts\nsrc/b.ts" }],
      isError: false,
      details: undefined,
    } as any);
    await handler({
      toolName: "safe_bash",
      toolCallId: "3",
      input: { command: "ls -la" },
      content: [{ type: "text", text: "very long output" }],
      isError: false,
      details: undefined,
    } as any);

    expect(seenToolNames).toEqual(["glob", "glob", "bash"]);
  });
});

describe("extension registration", () => {
  function createMockExtensionAPI(): {
    pi: ExtensionAPI;
    handlers: Map<string, (...args: any[]) => any>;
    commands: Map<string, { description: string; handler: (...args: any[]) => any }>;
    emittedEvents: string[];
  } {
    const handlers = new Map<string, (...args: any[]) => any>();
    const commands = new Map<string, { description: string; handler: (...args: any[]) => any }>();
    const emittedEvents: string[] = [];
    const pi = {
      events: {
        on: () => undefined,
        emit: (event: string) => emittedEvents.push(event),
      },
      on: (event: string, handler: (...args: any[]) => any) => {
        handlers.set(event, handler);
      },
      registerCommand: (name: string, command: { description: string; handler: (...args: any[]) => any }) => {
        commands.set(name, command);
      },
    } as unknown as ExtensionAPI;

    return { pi, handlers, commands, emittedEvents };
  }

  function createMockContext() {
    return {
      hasUI: true,
      signal: undefined,
      ui: {
        theme: { fg: (_color: string, text: string) => text },
        notify: mock(() => undefined),
        setStatus: mock(() => undefined),
        setWidget: mock(() => undefined),
      },
    };
  }

  it("registers hooks, fancy-footer widget, and stats command", async () => {
    const { default: localToolResultCompressor } = await import("./local-tool-result-compressor");
    const { pi, handlers, commands, emittedEvents } = createMockExtensionAPI();
    localToolResultCompressor(pi);
    expect(handlers.has("session_start")).toBe(true);
    expect(handlers.has("tool_result")).toBe(true);
    expect(handlers.has("session_shutdown")).toBe(true);
    expect(handlers.has("before_provider_request")).toBe(false);
    expect(commands.has("compressor-stats")).toBe(true);
    expect(emittedEvents).toContain("pi-fancy-footer:request-widget-discovery");
  });

  it("warns once when compressor service fails", async () => {
    const { default: localToolResultCompressor } = await import("./local-tool-result-compressor");
    const realFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;

    const { pi, handlers } = createMockExtensionAPI();
    const ctx = createMockContext() as any;
    localToolResultCompressor(pi);

    await handlers.get("session_start")?.({}, ctx);
    await handlers.get("tool_result")?.({
      toolName: "grep",
      toolCallId: "1",
      input: { pattern: "foo", path: "src" },
      content: [{ type: "text", text: "src/a.rs:1: foo" }],
      isError: false,
      details: undefined,
    }, ctx);
    await handlers.get("tool_result")?.({
      toolName: "bash",
      toolCallId: "2",
      input: { command: "ls -la" },
      content: [{ type: "text", text: "other output" }],
      isError: false,
      details: undefined,
    }, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith("compressor unavailable: http://127.0.0.1:8320", "warning");

    globalThis.fetch = realFetch;
  });
});
