import { afterEach, describe, expect, it, mock } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createCompressionMetrics,
  createCompressionMetricsFromEvents,
  createToolResultHandler,
  extractCompressibleText,
  formatDetailedStats,
  formatStatsStatus,
  formatStatsWidgetLines,
  getLocalCompressorConfig,
  isCompressibleToolName,
  chooseCompressionRoute,
  shouldNotifyCompressionSummary,
} from "./local-tool-result-compressor";
import { COMPRESSION_EVENT_ENTRY_TYPE } from "../_shared/compression-protocol";
import type { CompressionDetails } from "../_shared/compression-protocol";

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

  it("keeps hypa tools out of Edgee compression", () => {
    expect(isCompressibleToolName("hypa_ls")).toBe(false);
    expect(isCompressibleToolName("hypa_find")).toBe(false);
    expect(isCompressibleToolName("hypa_grep")).toBe(false);
    expect(isCompressibleToolName("hypa_read")).toBe(false);
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
      archiveOriginal: false,
      routingStrategy: "edgee",
      summaryGranularity: "all",
    });
  });
});

describe("chooseCompressionRoute", () => {
  it("keeps legacy edgee route when strategy is edgee", () => {
    expect(chooseCompressionRoute({ strategy: "edgee", toolName: "grep", text: "ERROR late" })).toBe("edgee");
    expect(chooseCompressionRoute({ strategy: "edgee", toolName: "read", text: "function x() {}" })).toBe("edgee");
  });

  it("uses benchmark routing from the latest report", () => {
    expect(chooseCompressionRoute({ strategy: "benchmark", toolName: "read", text: "export function createToolResultHandler() {}" })).toBe("edgee");
    expect(chooseCompressionRoute({ strategy: "benchmark", toolName: "grep", text: "src/a.ts:99: model config error" })).toBe("cap");
    expect(chooseCompressionRoute({ strategy: "benchmark", toolName: "bash", text: "FAIL expected engine received engine" })).toBe("cap");
    expect(chooseCompressionRoute({ strategy: "benchmark", toolName: "ls", text: "src\ntest\npackage.json" })).toBe("cap");
  });
});

describe("createCompressionMetrics", () => {
  it("tracks compressed results and saved characters per tool", () => {
    const metrics = createCompressionMetrics();
    metrics.record({ kind: "compressed", toolName: "read", originalLength: 100, compressedLength: 40 });
    metrics.record({ kind: "compressed", toolName: "grep", originalLength: 80, compressedLength: 20 });
    metrics.record({ kind: "skipped", toolName: "find", originalLength: 10, compressedLength: 0 });
    metrics.record({ kind: "failed", toolName: "bash", originalLength: 20, compressedLength: 0 });

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

  it("rebuilds metrics from persisted compression events", () => {
    const metrics = createCompressionMetricsFromEvents([
      {
        toolCallId: "old-1",
        toolName: "read",
        timestamp: 1,
        kind: "compressed",
        originalLength: 100,
        compressedLength: 40,
        savedBytes: 60,
        savedPct: 60,
      },
      {
        toolCallId: "old-2",
        toolName: "grep",
        timestamp: 2,
        kind: "skipped",
        originalLength: 20,
        reason: "no_change",
      },
    ]);

    expect(metrics.snapshot()).toMatchObject({
      seen: 2,
      compressed: 1,
      skipped: 1,
      failed: 0,
      bytesSaved: 60,
    });
  });

  it("formats readable status and widget lines", () => {
    const metrics = createCompressionMetrics();
    metrics.record({ kind: "compressed", toolName: "read", originalLength: 100, compressedLength: 40 });
    metrics.record({ kind: "compressed", toolName: "safe_bash", originalLength: 90, compressedLength: 50 });
    metrics.record({ kind: "failed", toolName: "ls", originalLength: 20, compressedLength: 0 });

    expect(formatStatsStatus(metrics.snapshot())).toBe("cmp 2/3 ok • saved 100B • fail 1");
    expect(formatStatsWidgetLines(metrics.snapshot(), "http://127.0.0.1:8320")).toEqual([
      "compressor http://127.0.0.1:8320",
      "ok 2/3 • saved 100B • fail 1 • top: read 60B, safe_bash 40B",
    ]);

    expect(formatDetailedStats(metrics.snapshot(), "http://127.0.0.1:8320")).toContain("1. read — saved 60B • ok 1 • skipped 0 • fail 0");
  });
});

describe("notification granularity", () => {
  it("allows summary notifications to be muted by scope", () => {
    expect(shouldNotifyCompressionSummary("none", "turn")).toBe(false);
    expect(shouldNotifyCompressionSummary("turn", "turn")).toBe(true);
    expect(shouldNotifyCompressionSummary("turn", "agent")).toBe(false);
    expect(shouldNotifyCompressionSummary("agent", "turn")).toBe(false);
    expect(shouldNotifyCompressionSummary("agent", "agent")).toBe(true);
    expect(shouldNotifyCompressionSummary("all", "turn")).toBe(true);
    expect(shouldNotifyCompressionSummary("all", "agent")).toBe(true);
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
    const result = await handler(event as any);
    expect(result).toEqual({
      content: [{ type: "text", text: "trimmed" }],
      details: {
        compression: {
          originalLength: "very long output".length,
          compressedLength: "trimmed".length,
          savedBytes: "very long output".length - "trimmed".length,
          savedPct: Math.round((("very long output".length - "trimmed".length) / "very long output".length) * 100),
        },
      },
    });
    expect(observations).toEqual([
      {
        kind: "compressed",
        toolCallId: "1",
        toolName: "read",
        originalLength: "very long output".length,
        compressedLength: "trimmed".length,
        subject: "main.rs",
      },
    ]);
  });

  it("can archive original output and expose the path in compressed content", async () => {
    const fetchImpl = mock(() => Promise.resolve(Response.json({ compressed_output: "trimmed" }, { status: 200 })));
    const handler = createToolResultHandler({
      fetchImpl,
      baseUrl: "http://127.0.0.1:8320",
      archiveOriginal: mock(async () => "/tmp/pi-tool-results/full-c1.txt"),
    });

    const result = await handler({
      toolName: "read",
      toolCallId: "c1",
      input: { path: "src/main.ts" },
      content: [{ type: "text", text: "very long original output\n".repeat(40) }],
      isError: false,
      details: undefined,
    } as any);

    expect(result?.content[0]?.text).toContain("trimmed");
    expect(result?.content[0]?.text).toContain("Full original tool result saved: /tmp/pi-tool-results/full-c1.txt");
    expect(result?.details?.compression.archivePath).toBe("/tmp/pi-tool-results/full-c1.txt");
  });

  it("can fall back to archived head-tail cap when backend returns no output", async () => {
    const fetchImpl = mock(() => Promise.resolve(Response.json({ compressed_output: null }, { status: 200 })));
    const handler = createToolResultHandler({
      fetchImpl,
      baseUrl: "http://127.0.0.1:8320",
      capFallbackBytes: 240,
      archiveOriginal: mock(async () => "/tmp/pi-tool-results/full-cap1.txt"),
    });
    const source = ["HEAD", ...Array.from({ length: 120 }, (_, index) => `line-${index}`), "TAIL"].join("\n");

    const result = await handler({
      toolName: "bash",
      toolCallId: "cap1",
      input: { command: "cat big.log" },
      content: [{ type: "text", text: source }],
      isError: false,
      details: undefined,
    } as any);

    const output = result?.content[0]?.text ?? "";
    expect(output).toContain("HEAD");
    expect(output).toContain("TAIL");
    expect(output).toContain("omitted by head/tail cap");
    expect(output).toContain("Full original tool result saved: /tmp/pi-tool-results/full-cap1.txt");
    expect(output.length).toBeLessThan(source.length);
    expect(result?.details?.compression.archivePath).toBe("/tmp/pi-tool-results/full-cap1.txt");
  });

  it("can route benchmark-selected payloads directly to archived cap", async () => {
    const fetchImpl = mock(() => Promise.resolve(Response.json({ compressed_output: "should not call" }, { status: 200 })));
    const handler = createToolResultHandler({
      fetchImpl,
      baseUrl: "http://127.0.0.1:8320",
      routingStrategy: "benchmark",
      capFallbackBytes: 260,
      archiveOriginal: mock(async () => "/tmp/pi-tool-results/full-grep1.txt"),
    });
    const source = ["HEAD", ...Array.from({ length: 100 }, (_, index) => `src/file.ts:${index}: noise`), "src/config.ts:999: model routing error", "TAIL"].join("\n");

    const result = await handler({
      toolName: "grep",
      toolCallId: "grep1",
      input: { pattern: "routing", path: "src" },
      content: [{ type: "text", text: source }],
      isError: false,
      details: undefined,
    } as any);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result?.content[0]?.text).toContain("Full original tool result saved: /tmp/pi-tool-results/full-grep1.txt");
    expect(result?.details?.compression.archivePath).toBe("/tmp/pi-tool-results/full-grep1.txt");
  });

  it("compression details match expected shape and types", async () => {
    const fetchImpl = mock(() =>
      Promise.resolve(Response.json({ compressed_output: "short" }, { status: 200 }))
    );
    const handler = createToolResultHandler({ fetchImpl, baseUrl: "http://127.0.0.1:8320" });
    const result = await handler({
      toolName: "bash",
      toolCallId: "1",
      input: { command: "cat large.log" },
      content: [{ type: "text", text: "a".repeat(5000) }],
      isError: false,
      details: undefined,
    } as any);
    expect(result).toBeDefined();
    expect(result!.details).toBeDefined();
    const cd = result!.details!.compression as CompressionDetails;
    expect(cd.originalLength).toBe(5000);
    expect(cd.compressedLength).toBe("short".length);
    expect(cd.savedBytes).toBe(5000 - "short".length);
    expect(cd.savedPct).toBe(Math.round(((5000 - "short".length) / 5000) * 100));
    expect(cd.savedPct).toBeGreaterThan(0);
    expect(cd.savedPct).toBeLessThanOrEqual(100);
  });

  it("skips when compressed output is not smaller than the original", async () => {
    const observations: object[] = [];
    const fetchImpl = mock(() =>
      Promise.resolve(Response.json({ compressed_output: "1F 1D:\n\n./ (no output)\n" }, { status: 200 }))
    );
    const handler = createToolResultHandler({
      fetchImpl,
      baseUrl: "http://127.0.0.1:8320",
      onObservation: (event) => observations.push(event),
    });

    const result = await handler({
      toolName: "safe_bash",
      toolCallId: "ns1",
      input: { command: "find . -maxdepth 1" },
      content: [{ type: "text", text: "./\n" }],
      isError: false,
      details: undefined,
    } as any);

    expect(result).toBeUndefined();
    expect(observations).toEqual([
      {
        kind: "skipped",
        toolCallId: "ns1",
        toolName: "safe_bash",
        originalLength: 3,
        compressedLength: 0,
        reason: "not_smaller",
        subject: "find . -maxdepth 1",
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
        toolCallId: "1",
        toolName: "read",
        originalLength: 0,
        compressedLength: 0,
        reason: "non_text_content",
        subject: "a",
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
        toolCallId: "1",
        toolName: "grep",
        originalLength: "src/a.rs:1: foo".length,
        compressedLength: 0,
        reason: "service_error",
        subject: "src",
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
    registeredTools: Map<string, unknown>;
    entries: Array<{ customType: string; data?: object }>;
  } {
    const handlers = new Map<string, (...args: any[]) => any>();
    const commands = new Map<string, { description: string; handler: (...args: any[]) => any }>();
    const emittedEvents: string[] = [];
    const registeredTools = new Map<string, unknown>();
    const entries: Array<{ customType: string; data?: object }> = [];
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
      registerTool: (tool: unknown) => {
        registeredTools.set((tool as { name: string }).name, tool);
      },
      appendEntry: (customType: string, data?: object) => {
        entries.push({ customType, data });
      },
    } as unknown as ExtensionAPI;

    return { pi, handlers, commands, emittedEvents, registeredTools, entries };
  }

  function createMockContext(sessionEntries: Array<{ type: string; customType?: string; data?: object }> = []) {
    return {
      hasUI: true,
      signal: undefined,
      sessionManager: {
        getEntries: () => sessionEntries,
      },
      ui: {
        theme: { fg: (_color: string, text: string) => text },
        notify: mock(() => undefined),
        setStatus: mock(() => undefined),
        setWidget: mock(() => undefined),
      },
    };
  }

  it("registers hooks, fancy-footer widget, and stats command without registering tools", async () => {
    const { default: localToolResultCompressor } = await import("./local-tool-result-compressor");
    const { pi, handlers, commands, emittedEvents, registeredTools } = createMockExtensionAPI();
    localToolResultCompressor(pi);
    expect(handlers.has("session_start")).toBe(true);
    expect(handlers.has("turn_start")).toBe(true);
    expect(handlers.has("turn_end")).toBe(true);
    expect(handlers.has("agent_start")).toBe(true);
    expect(handlers.has("agent_end")).toBe(true);
    expect(handlers.has("tool_result")).toBe(true);
    expect(handlers.has("session_shutdown")).toBe(true);
    expect(handlers.has("before_provider_request")).toBe(false);
    expect(commands.has("compressor-stats")).toBe(true);
    expect(emittedEvents).toContain("pi-fancy-footer:request-widget-discovery");
    expect(registeredTools.size).toBe(0);
  });

  it("appends compressed outcome entry and reports summary-only turn and agent notifications", async () => {
    const { default: localToolResultCompressor } = await import("./local-tool-result-compressor");
    const realFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => Response.json({ compressed_output: "trimmed" })) as unknown as typeof fetch;

    const { pi, handlers, entries } = createMockExtensionAPI();
    const ctx = createMockContext() as any;
    localToolResultCompressor(pi);

    await handlers.get("session_start")?.({}, ctx);
  await handlers.get("agent_start")?.({}, ctx);
    await handlers.get("turn_start")?.({}, ctx);
    await handlers.get("tool_result")?.({
      toolName: "read",
      toolCallId: "c1",
      input: { path: "file.txt" },
      content: [{ type: "text", text: "very long output" }],
      isError: false,
      details: undefined,
    }, ctx);

    expect(entries).toContainEqual({
      customType: COMPRESSION_EVENT_ENTRY_TYPE,
      data: expect.objectContaining({
        toolCallId: "c1",
        toolName: "read",
        timestamp: expect.any(Number),
        kind: "compressed",
        originalLength: "very long output".length,
        subject: "file.txt",
        compressedLength: "trimmed".length,
        savedBytes: "very long output".length - "trimmed".length,
        savedPct: Math.round((("very long output".length - "trimmed".length) / "very long output".length) * 100),
      }),
    });
    expect(ctx.ui.notify).not.toHaveBeenCalledWith("compressed read: 16 → 7 chars (-9, 56%)", "info");
    await handlers.get("turn_end")?.({}, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("compression turn: ok 1/1 • saved 9B • fail 0"), "info");
    expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("read"), "info");

    await handlers.get("agent_end")?.({}, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("compression agent: ok 1/1 • saved 9B • fail 0"), "info");

    globalThis.fetch = realFetch;
  });

  it("restores widget and command stats from persisted session telemetry on session_start", async () => {
    const { default: localToolResultCompressor } = await import("./local-tool-result-compressor");
    const { pi, handlers, commands } = createMockExtensionAPI();
    const ctx = createMockContext([
      {
        type: "custom",
        customType: COMPRESSION_EVENT_ENTRY_TYPE,
        data: {
          toolCallId: "old-1",
          toolName: "read",
          timestamp: 1,
          kind: "compressed",
          originalLength: 100,
          compressedLength: 25,
          savedBytes: 75,
          savedPct: 75,
        },
      },
    ]) as any;
    localToolResultCompressor(pi);

    await handlers.get("session_start")?.({}, ctx);
    await commands.get("compressor-stats")?.handler("", ctx);

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Summary: ok 1/1"), "info");
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("saved 75B"), "info");
  });

  it("appends skipped outcome entry and reports it at turn_end", async () => {
    const { default: localToolResultCompressor } = await import("./local-tool-result-compressor");
    const realFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => Response.json({ compressed_output: "same output" })) as unknown as typeof fetch;

    const { pi, handlers, entries } = createMockExtensionAPI();
    const ctx = createMockContext() as any;
    localToolResultCompressor(pi);

    await handlers.get("session_start")?.({}, ctx);
    await handlers.get("turn_start")?.({}, ctx);
    await handlers.get("tool_result")?.({
      toolName: "grep",
      toolCallId: "s1",
      input: { pattern: "foo" },
      content: [{ type: "text", text: "same output" }],
      isError: false,
      details: undefined,
    }, ctx);

    expect(entries).toContainEqual({
      customType: COMPRESSION_EVENT_ENTRY_TYPE,
      data: {
        toolCallId: "s1",
        toolName: "grep",
        timestamp: expect.any(Number),
        kind: "skipped",
        originalLength: "same output".length,
        subject: "foo",
        reason: "no_change",
      },
    });
    await handlers.get("turn_end")?.({}, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("compression turn: ok 0/1 • skipped 1 • fail 0"), "info");

    globalThis.fetch = realFetch;
  });

  it("appends failed outcome entries and summarizes them at turn_end", async () => {
    const { default: localToolResultCompressor } = await import("./local-tool-result-compressor");
    const realFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;

    const { pi, handlers, entries } = createMockExtensionAPI();
    const ctx = createMockContext() as any;
    localToolResultCompressor(pi);

    await handlers.get("session_start")?.({}, ctx);
    await handlers.get("turn_start")?.({}, ctx);
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

    expect(entries).toContainEqual({
      customType: COMPRESSION_EVENT_ENTRY_TYPE,
      data: {
        toolCallId: "1",
        toolName: "grep",
        timestamp: expect.any(Number),
        kind: "failed",
        originalLength: "src/a.rs:1: foo".length,
        subject: "src",
        reason: "service_error",
      },
    });
    expect(entries).toContainEqual({
      customType: COMPRESSION_EVENT_ENTRY_TYPE,
      data: {
        toolCallId: "2",
        toolName: "bash",
        timestamp: expect.any(Number),
        kind: "failed",
        originalLength: "other output".length,
        subject: "ls -la",
        reason: "service_error",
      },
    });
    await handlers.get("turn_end")?.({}, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("compression turn: ok 0/2 • skipped 0 • fail 2"), "warning");

    globalThis.fetch = realFetch;
  });

  it("summarizes multiple read outcomes truthfully at turn_end", async () => {
    const { default: localToolResultCompressor } = await import("./local-tool-result-compressor");
    const responses = [
      Response.json({ compressed_output: "same output" }),
      Response.json({ compressed_output: "trimmed" }),
      Response.json({ compressed_output: "same output" }),
    ];
    const realFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => responses.shift() ?? Response.json({ compressed_output: "same output" })) as unknown as typeof fetch;

    const { pi, handlers } = createMockExtensionAPI();
    const ctx = createMockContext() as any;
    localToolResultCompressor(pi);

    await handlers.get("session_start")?.({}, ctx);
    await handlers.get("turn_start")?.({}, ctx);
    await handlers.get("tool_result")?.({
      toolName: "read",
      toolCallId: "r1",
      input: { path: "/tmp/a.md" },
      content: [{ type: "text", text: "same output" }],
      isError: false,
      details: undefined,
    }, ctx);
    await handlers.get("tool_result")?.({
      toolName: "read",
      toolCallId: "r2",
      input: { path: "/tmp/.oxlintrc.json" },
      content: [{ type: "text", text: "very long output" }],
      isError: false,
      details: undefined,
    }, ctx);
    await handlers.get("tool_result")?.({
      toolName: "read",
      toolCallId: "r3",
      input: { path: "/tmp/b.md" },
      content: [{ type: "text", text: "same output" }],
      isError: false,
      details: undefined,
    }, ctx);

    await handlers.get("turn_end")?.({}, ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("compression turn: ok 1/3 • saved 9B • skipped 2 • fail 0"), "info");

    globalThis.fetch = realFetch;
  });
});

import { toolCompressionContext } from "./tool-results/core";
import { resetAuditState, setActiveProfile } from "../_shared/audit-mode";

describe("toolCompressionContext", () => {
  it("classifies search tools", () => {
    expect(toolCompressionContext("grep")).toBe("search");
    expect(toolCompressionContext("find")).toBe("search");
    expect(toolCompressionContext("ls")).toBe("search");
  });

  it("classifies read tool", () => {
    expect(toolCompressionContext("read")).toBe("read");
  });

  it("classifies shell tools", () => {
    expect(toolCompressionContext("bash")).toBe("shell");
    expect(toolCompressionContext("safe_bash")).toBe("shell");
  });

  it("returns null for unrelated tools", () => {
    expect(toolCompressionContext("write")).toBeNull();
    expect(toolCompressionContext("edit")).toBeNull();
    expect(toolCompressionContext("custom")).toBeNull();
  });
});

describe("audit-aware compression policy", () => {
  // Reset audit state after each test to avoid cross-test leakage.
  afterEach(() => {
    resetAuditState("standard");
  });

  it("standard profile: compresses all tool types", async () => {
    // standard is the default — no setActiveProfile needed
    const fetchImpl = mock(async () => Response.json({ compressed_output: "compressed" }, { status: 200 }));
    const handler = createToolResultHandler({ fetchImpl, baseUrl: "http://127.0.0.1:8320" });

    for (const toolName of ["grep", "find", "ls", "read", "bash", "safe_bash"]) {
      fetchImpl.mockClear();
      const result = await handler({
        toolName,
        toolCallId: "x",
        input: { path: ".", command: "ls" },
        content: [{ type: "text", text: "some output" }],
        isError: false,
        details: undefined,
      } as any);
      expect(fetchImpl).toHaveBeenCalled();
      expect(result).toBeDefined();
    }
  });

  it("audit profile: keeps compression enabled for all tool types", async () => {
    setActiveProfile("audit");
    const fetchImpl = mock(async () => Response.json({ compressed_output: "compressed" }, { status: 200 }));
    const handler = createToolResultHandler({ fetchImpl, baseUrl: "http://127.0.0.1:8320" });

    for (const toolName of ["grep", "find", "ls", "read", "bash", "safe_bash"]) {
      fetchImpl.mockClear();
      const result = await handler({
        toolName,
        toolCallId: "x",
        input: { path: ".", command: "ls" },
        content: [{ type: "text", text: "some output" }],
        isError: false,
        details: undefined,
      } as any);
      expect(fetchImpl).toHaveBeenCalled();
      expect(result).toBeDefined();
    }
  });

  it("advanced profile: disables compression for search tools (grep, find, ls)", async () => {
    setActiveProfile("advanced");
    const fetchImpl = mock(async () => Response.json({ compressed_output: "compressed" }, { status: 200 }));
    const handler = createToolResultHandler({ fetchImpl, baseUrl: "http://127.0.0.1:8320" });

    for (const toolName of ["grep", "find", "ls"]) {
      fetchImpl.mockClear();
      const result = await handler({
        toolName,
        toolCallId: "x",
        input: { path: ".", pattern: "foo", command: "ls" },
        content: [{ type: "text", text: "some output" }],
        isError: false,
        details: undefined,
      } as any);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    }
  });

  it("advanced profile: disables compression for shell tools (bash, safe_bash)", async () => {
    setActiveProfile("advanced");
    const fetchImpl = mock(async () => Response.json({ compressed_output: "compressed" }, { status: 200 }));
    const handler = createToolResultHandler({ fetchImpl, baseUrl: "http://127.0.0.1:8320" });

    for (const toolName of ["bash", "safe_bash"]) {
      fetchImpl.mockClear();
      const result = await handler({
        toolName,
        toolCallId: "x",
        input: { command: "cat file.txt" },
        content: [{ type: "text", text: "some output" }],
        isError: false,
        details: undefined,
      } as any);
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    }
  });

  it("advanced profile: keeps compression enabled for read tool (disableForRead is false)", async () => {
    setActiveProfile("advanced");
    const fetchImpl = mock(async () => Response.json({ compressed_output: "compressed" }, { status: 200 }));
    const handler = createToolResultHandler({ fetchImpl, baseUrl: "http://127.0.0.1:8320" });

    const result = await handler({
      toolName: "read",
      toolCallId: "x",
      input: { path: "src/main.ts" },
      content: [{ type: "text", text: "some output" }],
      isError: false,
      details: undefined,
    } as any);
    expect(fetchImpl).toHaveBeenCalled();
    expect(result).toBeDefined();
  });
});
