import { afterEach, describe, expect, it, mock } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createToolResultHandler,
  extractCompressibleText,
  isCompressibleToolName,
  chooseCompressionRoute,
  shouldNotifyCompressionSummary,
} from "./local-tool-result-compressor";
import { getLocalCompressorConfig } from "./config-runtime";
import {
  createCompressionMetrics,
  createCompressionMetricsFromEvents,
  formatDetailedStats,
  formatStatsStatus,
  formatStatsWidgetLines,
} from "./tool-results/metrics";
import { COMPRESSION_EVENT_ENTRY_TYPE } from "../_shared/compression-protocol";
import type { CompressionDetails } from "../_shared/compression-protocol";

type HandlerOptions = Parameters<typeof createToolResultHandler>[0];

const TEST_CONFIG = {
  minBytesByGroup: { shell: 0, read: 0, search: 0 },
  archiveOriginal: false,
  aggregates: false,
  capErrors: false,
};

function createTestToolResultHandler(options: HandlerOptions = {}) {
  const hasExplicitThreshold =
    options.minBytes !== undefined || options.minBytesByGroup !== undefined;
  return createToolResultHandler({
    ...(hasExplicitThreshold
      ? {}
      : { minBytesByGroup: { shell: 0, read: 0, search: 0 } }),
    aggregates: false,
    capErrors: false,
    ...options,
  });
}

function parseToolName(init?: RequestInit): string | undefined {
  try {
    const parsed: unknown = JSON.parse(String(init?.body));
    if (typeof parsed !== "object" || parsed === null || !("tool_name" in parsed)) return undefined;
    return typeof parsed.tool_name === "string" ? parsed.tool_name : undefined;
  } catch {
    return undefined;
  }
}

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
      archiveOriginal: true,
      archiveRetention: {
        maxAgeDays: 30,
        maxBytes: 1_073_741_824,
      },
      routingStrategy: "edgee",
      summaryGranularity: "all",
      enabled: true,
      excludeTools: [],
      minBytesByGroup: {
        shell: 4096,
        read: 8192,
        search: 4096,
      },
      aggregates: true,
      capErrors: true,
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
    const handler = createTestToolResultHandler({ fetchImpl });
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
      expect(parseToolName(init)).toBe("read");
      return Response.json({ compressed_output: "trimmed" }, { status: 200 });
    });
    const handler = createTestToolResultHandler({
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
    const handler = createTestToolResultHandler({
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
    expect(result?.content[0]?.text).toContain("run read /tmp/pi-tool-results/full-c1.txt for full output");
    expect(
      (result?.details as { compression: CompressionDetails } | undefined)
        ?.compression.archivePath,
    ).toBe("/tmp/pi-tool-results/full-c1.txt");
  });

  it("can fall back to archived head-tail cap when backend returns no output", async () => {
    const fetchImpl = mock(() => Promise.resolve(Response.json({ compressed_output: null }, { status: 200 })));
    const handler = createTestToolResultHandler({
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
    expect(output).toContain("run read /tmp/pi-tool-results/full-cap1.txt for full output");
    expect(output.length).toBeLessThan(source.length);
    expect(
      (result?.details as { compression: CompressionDetails } | undefined)
        ?.compression.archivePath,
    ).toBe("/tmp/pi-tool-results/full-cap1.txt");
  });

  it("can route benchmark-selected payloads directly to archived cap", async () => {
    const fetchImpl = mock(() => Promise.resolve(Response.json({ compressed_output: "should not call" }, { status: 200 })));
    const handler = createTestToolResultHandler({
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
    expect(result?.content[0]?.text).toContain("run read /tmp/pi-tool-results/full-grep1.txt for full output");
    expect(
      (result?.details as { compression: CompressionDetails } | undefined)
        ?.compression.archivePath,
    ).toBe("/tmp/pi-tool-results/full-grep1.txt");
  });

  it("compression details match expected shape and types", async () => {
    const fetchImpl = mock(() =>
      Promise.resolve(Response.json({ compressed_output: "short" }, { status: 200 }))
    );
    const handler = createTestToolResultHandler({ fetchImpl, baseUrl: "http://127.0.0.1:8320" });
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
    const handler = createTestToolResultHandler({
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
    const handler = createTestToolResultHandler({
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
    const handler = createTestToolResultHandler({
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
      const toolName = parseToolName(init);
      if (toolName) seenToolNames.push(toolName);
      return Response.json({ compressed_output: "trimmed" }, { status: 200 });
    });
    const handler = createTestToolResultHandler({ fetchImpl, baseUrl: "http://127.0.0.1:8320" });

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

describe("grouped thresholds and result integrity", () => {
  it("uses the threshold for each compression group", async () => {
    const fetchImpl = mock(() =>
      Promise.resolve(
        Response.json({ compressed_output: "x" }, { status: 200 }),
      ),
    );
    const handler = createToolResultHandler({
      fetchImpl,
      minBytesByGroup: { shell: 4, read: 6, search: 5 },
    });

    const cases = [
      ["bash", "é", false],
      ["bash", "éé", true],
      ["bash", "ééa", true],
      ["read", "ééa", false],
      ["read", "ééé", true],
      ["read", "éééa", true],
      ["grep", "éé", false],
      ["grep", "ééa", true],
      ["grep", "ééaa", true],
    ] as const;

    for (const [toolName, text, eligible] of cases) {
      fetchImpl.mockClear();
      await handler({
        toolName,
        toolCallId: `${toolName}-${Buffer.byteLength(text, "utf8")}`,
        input: {},
        content: [{ type: "text", text }],
        isError: false,
        details: undefined,
      } as any);
      expect(fetchImpl).toHaveBeenCalledTimes(eligible ? 1 : 0);
    }
  });

  it("preserves original details and archives Pi full output", async () => {
    const archiveOriginal = mock(async () => "/archive/full.txt");
    const handler = createTestToolResultHandler({
      fetchImpl: mock(() =>
        Promise.resolve(
          Response.json({ compressed_output: "short" }, { status: 200 }),
        ),
      ),
      archiveOriginal,
    });
    const details = {
      truncation: { truncated: true },
      fullOutputPath: "/tmp/pi-full-output.txt",
    };
    const originalText = "a sufficiently long output".repeat(10);

    const result = await handler({
      toolName: "bash",
      toolCallId: "details-1",
      input: { command: "printf output" },
      content: [{ type: "text", text: originalText }],
      isError: false,
      details,
    } as any);

    expect(archiveOriginal).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePath: "/tmp/pi-full-output.txt",
        text: originalText,
      }),
    );
    expect(result?.details).toMatchObject({
      truncation: { truncated: true },
      fullOutputPath: "/tmp/pi-full-output.txt",
      compression: { archivePath: "/archive/full.txt" },
    });
  });

  it("keeps non-object custom details recoverable", async () => {
    const handler = createTestToolResultHandler({
      fetchImpl: mock(() =>
        Promise.resolve(
          Response.json({ compressed_output: "short" }, { status: 200 }),
        ),
      ),
    });

    const result = await handler({
      toolName: "safe_bash",
      toolCallId: "details-2",
      input: { command: "printf output" },
      content: [{ type: "text", text: "a sufficiently long output" }],
      isError: false,
      details: "opaque-details",
    } as any);

    expect(result?.details).toMatchObject({
      originalDetails: "opaque-details",
      compression: expect.any(Object),
    });
  });

  it("fails open when cap-route archiving fails", async () => {
    const handler = createTestToolResultHandler({
      fetchImpl: mock(() =>
        Promise.resolve(Response.json({}, { status: 200 })),
      ),
      routingStrategy: "benchmark",
      capFallbackBytes: 8,
      archiveOriginal: mock(async () => {
        throw new Error("archive unavailable");
      }),
    });

    await expect(
      handler({
        toolName: "grep",
        toolCallId: "archive-fail",
        input: { pattern: "x" },
        content: [{ type: "text", text: "long grep output" }],
        isError: false,
        details: { preserved: true },
      } as any),
    ).resolves.toBeUndefined();
  });

  it("fails open when enabled archiving produces no archive path", async () => {
    const handler = createTestToolResultHandler({
      fetchImpl: mock(() =>
        Promise.resolve(
          Response.json({ compressed_output: "short" }, { status: 200 }),
        ),
      ),
      archiveOriginal: mock(async () => null),
    });

    await expect(
      handler({
        toolName: "bash",
        toolCallId: "archive-null",
        input: { command: "printf output" },
        content: [{ type: "text", text: "a sufficiently long output" }],
        isError: false,
        details: { preserved: true },
      } as any),
    ).resolves.toBeUndefined();
  });

  it("fails open when compressed output cannot include its archive path", async () => {
    const handler = createTestToolResultHandler({
      fetchImpl: mock(() =>
        Promise.resolve(
          Response.json({ compressed_output: "x" }, { status: 200 }),
        ),
      ),
      archiveOriginal: mock(async () => "/archive/long-path.txt"),
    });

    await expect(
      handler({
        toolName: "bash",
        toolCallId: "archive-note",
        input: { command: "printf output" },
        content: [{ type: "text", text: "small original" }],
        isError: false,
        details: { preserved: true },
      } as any),
    ).resolves.toBeUndefined();
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

  it("respects archiveOriginal false even when cap fallback is configured", async () => {
    const archiveRoot = mkdtempSync(join(tmpdir(), "compressor-opt-out-"));
    const previousRoot = process.env.PI_TOOL_RESULT_ARCHIVE_DIR;
    const realFetch = globalThis.fetch;
    process.env.PI_TOOL_RESULT_ARCHIVE_DIR = archiveRoot;
    globalThis.fetch = mock(async () =>
      Response.json({ compressed_output: "x" }),
    ) as unknown as typeof fetch;

    try {
      const { default: localToolResultCompressor } = await import("./local-tool-result-compressor");
      const { pi, handlers } = createMockExtensionAPI();
      localToolResultCompressor(pi, {
        ...TEST_CONFIG,
        archiveOriginal: false,
        capFallbackBytes: 8,
        routingStrategy: "edgee",
      });
      const ctx = createMockContext() as any;
      await handlers.get("session_start")?.({}, ctx);
      await handlers.get("tool_result")?.({
        toolName: "bash",
        toolCallId: "archive-opt-out",
        input: { command: "printf output" },
        content: [{ type: "text", text: "a sufficiently long output" }],
        isError: false,
        details: undefined,
      }, ctx);

      expect(readdirSync(archiveRoot)).toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
      if (previousRoot === undefined) delete process.env.PI_TOOL_RESULT_ARCHIVE_DIR;
      else process.env.PI_TOOL_RESULT_ARCHIVE_DIR = previousRoot;
      rmSync(archiveRoot, { recursive: true, force: true });
    }
  });

  it("prunes managed archives once on session start", async () => {
    const archiveRoot = mkdtempSync(join(tmpdir(), "compressor-prune-"));
    const previousRoot = process.env.PI_TOOL_RESULT_ARCHIVE_DIR;
    process.env.PI_TOOL_RESULT_ARCHIVE_DIR = archiveRoot;
    const oldPath = join(
      archiveRoot,
      `${Date.now() - 31 * 86_400_000}-bash-call-aaaaaaaaaaaa.txt`,
    );
    writeFileSync(oldPath, "old");

    try {
      const { default: localToolResultCompressor } = await import("./local-tool-result-compressor");
      const { pi, handlers } = createMockExtensionAPI();
      localToolResultCompressor(pi, {
        ...TEST_CONFIG,
        archiveOriginal: true,
        archiveRetention: { maxAgeDays: 30, maxBytes: 1024 },
      });
      await handlers.get("session_start")?.({}, createMockContext() as any);
      expect(existsSync(oldPath)).toBe(false);
    } finally {
      if (previousRoot === undefined) delete process.env.PI_TOOL_RESULT_ARCHIVE_DIR;
      else process.env.PI_TOOL_RESULT_ARCHIVE_DIR = previousRoot;
      rmSync(archiveRoot, { recursive: true, force: true });
    }
  });

  it("registers hooks, fancy-footer widget, and stats command without registering tools", async () => {
    const { default: localToolResultCompressor } = await import("./local-tool-result-compressor");
    const { pi, handlers, commands, emittedEvents, registeredTools } = createMockExtensionAPI();
    localToolResultCompressor(pi, TEST_CONFIG);
    expect(handlers.has("session_start")).toBe(true);
    expect(handlers.has("turn_start")).toBe(true);
    expect(handlers.has("turn_end")).toBe(true);
    expect(handlers.has("agent_start")).toBe(true);
    expect(handlers.has("agent_end")).toBe(true);
    expect(handlers.has("tool_result")).toBe(true);
    expect(handlers.has("session_shutdown")).toBe(true);
    expect(handlers.has("before_agent_start")).toBe(true);
    expect(handlers.has("before_provider_request")).toBe(false);
    expect(commands.has("compressor-stats")).toBe(true);
    expect(emittedEvents).toContain("pi-fancy-footer:request-widget-discovery");
    expect(registeredTools.size).toBe(0);
  });

  it("injects archive convention into system prompt when enabled && archiveOriginal", async () => {
    const { default: localToolResultCompressor } = await import("./local-tool-result-compressor");
    const { pi, handlers } = createMockExtensionAPI();
    localToolResultCompressor(pi, {
      ...TEST_CONFIG,
      archiveOriginal: true,
    });
    const handler = handlers.get("before_agent_start");
    expect(handler).toBeDefined();
    const result = await handler?.({ systemPrompt: "You are a helpful assistant." });
    expect(result?.systemPrompt).toContain("Tool results may be compressed");
    expect(result?.systemPrompt).toContain("read <archivePath>");
    expect(result?.systemPrompt).toContain("You are a helpful assistant.");
  });

  it("does not inject archive convention when archiveOriginal is false", async () => {
    const { default: localToolResultCompressor } = await import("./local-tool-result-compressor");
    const { pi, handlers } = createMockExtensionAPI();
    localToolResultCompressor(pi, {
      ...TEST_CONFIG,
      archiveOriginal: false,
    });
    const handler = handlers.get("before_agent_start");
    expect(handler).toBeDefined();
    const result = await handler?.({ systemPrompt: "You are a helpful assistant." });
    expect(result).toBeUndefined();
  });

  it("does not inject archive convention when enabled is false", async () => {
    const { default: localToolResultCompressor } = await import("./local-tool-result-compressor");
    const { pi, handlers } = createMockExtensionAPI();
    localToolResultCompressor(pi, {
      ...TEST_CONFIG,
      enabled: false,
      archiveOriginal: true,
    });
    const handler = handlers.get("before_agent_start");
    const result = await handler?.({ systemPrompt: "You are a helpful assistant." });
    expect(result).toBeUndefined();
  });

  it("is idempotent — does not double-inject on repeated calls", async () => {
    const { default: localToolResultCompressor } = await import("./local-tool-result-compressor");
    const { pi, handlers } = createMockExtensionAPI();
    localToolResultCompressor(pi, {
      ...TEST_CONFIG,
      archiveOriginal: true,
    });
    const handler = handlers.get("before_agent_start");
    const first = await handler?.({ systemPrompt: "Base prompt." });
    expect(first?.systemPrompt).toContain("Tool results may be compressed");
    const second = await handler?.({ systemPrompt: first.systemPrompt });
    expect(second).toBeUndefined();
  });

  it("appends compressed outcome entry and reports summary-only turn and agent notifications", async () => {
    const { default: localToolResultCompressor } = await import("./local-tool-result-compressor");
    const realFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => Response.json({ compressed_output: "trimmed" })) as unknown as typeof fetch;

    const { pi, handlers, entries } = createMockExtensionAPI();
    const ctx = createMockContext() as any;
    localToolResultCompressor(pi, TEST_CONFIG);

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
    localToolResultCompressor(pi, TEST_CONFIG);

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
    localToolResultCompressor(pi, TEST_CONFIG);

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
    localToolResultCompressor(pi, TEST_CONFIG);

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
    localToolResultCompressor(pi, TEST_CONFIG);

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

describe("compressor enabled/excludeTools/minBytes bypass", () => {
  it("bypasses compression silently when enabled is false", async () => {
    const fetchImpl = mock(() => Promise.resolve(Response.json({ compressed_output: "trimmed" }, { status: 200 })));
    const observations: unknown[] = [];
    const handler = createTestToolResultHandler({
      fetchImpl,
      baseUrl: "http://127.0.0.1:8320",
      enabled: false,
      onObservation: (event) => observations.push(event),
    });
    const result = await handler({
      toolName: "read",
      toolCallId: "1",
      input: { path: "src/main.ts" },
      content: [{ type: "text", text: "very long output" }],
      isError: false,
      details: undefined,
    } as any);
    expect(result).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(observations).toEqual([]);
  });

  it("bypasses compression silently for excluded tools", async () => {
    const fetchImpl = mock(() => Promise.resolve(Response.json({ compressed_output: "trimmed" }, { status: 200 })));
    const handler = createTestToolResultHandler({
      fetchImpl,
      baseUrl: "http://127.0.0.1:8320",
      excludeTools: ["read", "ls"],
    });

    const excluded = await handler({
      toolName: "read",
      toolCallId: "r1",
      input: { path: "file.txt" },
      content: [{ type: "text", text: "some text" }],
      isError: false,
      details: undefined,
    } as any);
    expect(excluded).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();

    const eligible = await handler({
      toolName: "grep",
      toolCallId: "g1",
      input: { pattern: "foo" },
      content: [{ type: "text", text: "found something here" }],
      isError: false,
      details: undefined,
    } as any);
    expect(eligible).toBeDefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("bypasses compression silently for output below minBytes", async () => {
    const fetchImpl = mock(() => Promise.resolve(Response.json({ compressed_output: "trimmed" }, { status: 200 })));
    const observations: unknown[] = [];
    const handler = createTestToolResultHandler({
      fetchImpl,
      baseUrl: "http://127.0.0.1:8320",
      minBytes: 100,
      onObservation: (event) => observations.push(event),
    });

    const belowThreshold = await handler({
      toolName: "read",
      toolCallId: "1",
      input: { path: "small.txt" },
      content: [{ type: "text", text: "short" }],
      isError: false,
      details: undefined,
    } as any);
    expect(belowThreshold).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(observations).toEqual([]);

    const eligible = await handler({
      toolName: "read",
      toolCallId: "2",
      input: { path: "large.txt" },
      content: [{ type: "text", text: "a".repeat(150) }],
      isError: false,
      details: undefined,
    } as any);
    expect(eligible).toBeDefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("measures minBytes using UTF-8 bytes", async () => {
    const fetchImpl = mock(() => Promise.resolve(Response.json({ compressed_output: "x" }, { status: 200 })));
    const handler = createTestToolResultHandler({
      fetchImpl,
      baseUrl: "http://127.0.0.1:8320",
      minBytes: 4,
    });

    const result = await handler({
      toolName: "read",
      toolCallId: "utf8",
      input: { path: "utf8.txt" },
      content: [{ type: "text", text: "éé" }],
      isError: false,
      details: undefined,
    } as any);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result).toBeDefined();
  });

  it("includes enabled, exclusions, and grouped thresholds in config defaults", () => {
    delete process.env.EDGEE_COMPRESSOR_BASE_URL;
    delete process.env.EDGEE_COMPRESSOR_AGENT;
    const cfg = getLocalCompressorConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.excludeTools).toEqual([]);
    expect(cfg.minBytesByGroup).toEqual({
      shell: 4096,
      read: 8192,
      search: 4096,
    });
    expect(cfg.aggregates).toBe(true);
    expect(cfg.capErrors).toBe(true);
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
    const handler = createTestToolResultHandler({ fetchImpl, baseUrl: "http://127.0.0.1:8320" });

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
    const handler = createTestToolResultHandler({ fetchImpl, baseUrl: "http://127.0.0.1:8320" });

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
    const handler = createTestToolResultHandler({ fetchImpl, baseUrl: "http://127.0.0.1:8320" });

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
    const handler = createTestToolResultHandler({ fetchImpl, baseUrl: "http://127.0.0.1:8320" });

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
    const handler = createTestToolResultHandler({ fetchImpl, baseUrl: "http://127.0.0.1:8320" });

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

// ---------------------------------------------------------------------------
// §3 AXI — Unified escape hatch
// ---------------------------------------------------------------------------

describe("buildEscapeHatchNote", () => {
  it("produces the unified format with original length and archive path", async () => {
    const { buildEscapeHatchNote } = await import("./tool-results/core");
    const note = buildEscapeHatchNote(50000, "/tmp/pi-archive/result.txt");
    expect(note).toBe(
      "\n\n... (compressed, 50000 chars total) — run read /tmp/pi-archive/result.txt for full output",
    );
  });
});

// ---------------------------------------------------------------------------
// §4 AXI — Aggregate header integration
// ---------------------------------------------------------------------------

describe("aggregate header integration", () => {
  it("prefixes grep aggregate to compressed output", async () => {
    const fetchImpl = mock(() =>
      Promise.resolve(Response.json({ compressed_output: "trimmed" }, { status: 200 })),
    );
    const handler = createTestToolResultHandler({
      fetchImpl,
      baseUrl: "http://127.0.0.1:8320",
      aggregates: true,
    });
    const grepText = [
      "src/a.ts:10: const foo = 1;",
      "src/a.ts:25: const foo = 2;",
      "src/b.ts:5: const foo = 3;",
    ].join("\n");
    const result = await handler({
      toolName: "grep",
      toolCallId: "agg-1",
      input: { pattern: "foo", path: "src" },
      content: [{ type: "text", text: grepText }],
      isError: false,
      details: undefined,
    } as any);
    expect(result?.content[0]?.text).toContain("[stats] matches: 3 | files: 2");
    expect(result?.content[0]?.text).toContain("trimmed");
  });

  it("prefixes read aggregate to compressed output", async () => {
    const fetchImpl = mock(() =>
      Promise.resolve(Response.json({ compressed_output: "trimmed" }, { status: 200 })),
    );
    const handler = createTestToolResultHandler({
      fetchImpl,
      baseUrl: "http://127.0.0.1:8320",
      aggregates: true,
    });
    const readText = "line of content\n".repeat(100);
    const result = await handler({
      toolName: "read",
      toolCallId: "agg-2",
      input: { path: "src/main.ts" },
      content: [{ type: "text", text: readText }],
      isError: false,
      details: undefined,
    } as any);
    expect(result?.content[0]?.text).toContain("[stats] chars:");
    expect(result?.content[0]?.text).toContain("lines: 101");
    expect(result?.content[0]?.text).toContain("trimmed");
  });

  it("prefixes bash aggregate to cap-route output", async () => {
    const handler = createTestToolResultHandler({
      fetchImpl: mock(() =>
        Promise.resolve(Response.json({ compressed_output: null }, { status: 200 })),
      ),
      baseUrl: "http://127.0.0.1:8320",
      routingStrategy: "benchmark",
      capFallbackBytes: 500,
      aggregates: true,
      archiveOriginal: mock(async () => "/tmp/pi-archive/bash-out.txt"),
    });
    const bashText = Array.from({ length: 200 }, (_, i) => `line-${i}`).join("\n");
    const result = await handler({
      toolName: "bash",
      toolCallId: "agg-3",
      input: { command: "cat big.log" },
      content: [{ type: "text", text: bashText }],
      isError: false,
      details: undefined,
    } as any);
    expect(result?.content[0]?.text).toContain("[stats] lines: 200");
    expect(result?.content[0]?.text).toContain("run read /tmp/pi-archive/bash-out.txt for full output");
  });

  it("omits aggregate prefix when aggregates is false", async () => {
    const fetchImpl = mock(() =>
      Promise.resolve(Response.json({ compressed_output: "trimmed" }, { status: 200 })),
    );
    const handler = createTestToolResultHandler({
      fetchImpl,
      baseUrl: "http://127.0.0.1:8320",
      aggregates: false,
    });
    const result = await handler({
      toolName: "grep",
      toolCallId: "agg-4",
      input: { pattern: "foo" },
      content: [{ type: "text", text: "src/a.ts:10: foo\nsrc/b.ts:5: foo" }],
      isError: false,
      details: undefined,
    } as any);
    expect(result?.content[0]?.text).not.toContain("[stats]");
    expect(result?.content[0]?.text).toContain("trimmed");
  });
});

// ---------------------------------------------------------------------------
// §6 AXI — Cap large error outputs
// ---------------------------------------------------------------------------

describe("error cap behavior", () => {
  it("caps large error output with head/tail and archive, never calls Edgee", async () => {
    const fetchImpl = mock(() =>
      Promise.resolve(Response.json({ compressed_output: "should not happen" }, { status: 200 })),
    );
    const handler = createTestToolResultHandler({
      fetchImpl,
      baseUrl: "http://127.0.0.1:8320",
      capErrors: true,
      capFallbackBytes: 500,
      archiveOriginal: mock(async () => "/tmp/pi-archive/err.txt"),
    });
    const errorText = Array.from({ length: 200 }, (_, i) => `error line ${i}`).join("\n");
    const result = await handler({
      toolName: "bash",
      toolCallId: "err-1",
      input: { command: "failing-cmd" },
      content: [{ type: "text", text: errorText }],
      isError: true,
      details: undefined,
    } as any);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toBeDefined();
    const output = result?.content[0]?.text ?? "";
    expect(output).toContain("error line 0");
    expect(output).toContain("error line 199");
    expect(output).toContain("omitted by head/tail cap");
    expect(output).toContain("run read /tmp/pi-archive/err.txt for full output");
  });

  it("passes small error output through intact", async () => {
    const fetchImpl = mock(() =>
      Promise.resolve(Response.json({ compressed_output: "no" }, { status: 200 })),
    );
    const handler = createTestToolResultHandler({
      fetchImpl,
      baseUrl: "http://127.0.0.1:8320",
      capErrors: true,
      capFallbackBytes: 500,
      archiveOriginal: mock(async () => "/tmp/pi-archive/err.txt"),
    });
    const result = await handler({
      toolName: "bash",
      toolCallId: "err-2",
      input: { command: "failing-cmd" },
      content: [{ type: "text", text: "small error" }],
      isError: true,
      details: undefined,
    } as any);
    expect(result).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("passes error output through intact when capErrors is false", async () => {
    const fetchImpl = mock(() =>
      Promise.resolve(Response.json({ compressed_output: "no" }, { status: 200 })),
    );
    const handler = createTestToolResultHandler({
      fetchImpl,
      baseUrl: "http://127.0.0.1:8320",
      capErrors: false,
      capFallbackBytes: 10,
      archiveOriginal: mock(async () => "/tmp/pi-archive/err.txt"),
    });
    const result = await handler({
      toolName: "bash",
      toolCallId: "err-3",
      input: { command: "failing-cmd" },
      content: [{ type: "text", text: "a".repeat(5000) }],
      isError: true,
      details: undefined,
    } as any);
    expect(result).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("passes error through intact when archiveOriginal is not set", async () => {
    const fetchImpl = mock(() =>
      Promise.resolve(Response.json({ compressed_output: "no" }, { status: 200 })),
    );
    const handler = createTestToolResultHandler({
      fetchImpl,
      baseUrl: "http://127.0.0.1:8320",
      capErrors: true,
      capFallbackBytes: 10,
      archiveOriginal: undefined,
    });
    const result = await handler({
      toolName: "bash",
      toolCallId: "err-4",
      input: { command: "failing-cmd" },
      content: [{ type: "text", text: "a".repeat(5000) }],
      isError: true,
      details: undefined,
    } as any);
    expect(result).toBeUndefined();
  });

  it("uses default cap size when capFallbackBytes is not configured", async () => {
    const fetchImpl = mock(() =>
      Promise.resolve(Response.json({ compressed_output: "no" }, { status: 200 })),
    );
    const handler = createTestToolResultHandler({
      fetchImpl,
      baseUrl: "http://127.0.0.1:8320",
      capErrors: true,
      archiveOriginal: mock(async () => "/tmp/pi-archive/err-default.txt"),
    });
    // 20000 chars — well above DEFAULT_ERROR_CAP_BYTES (8192)
    const errorText = "x".repeat(20000);
    const result = await handler({
      toolName: "bash",
      toolCallId: "err-5",
      input: { command: "failing-cmd" },
      content: [{ type: "text", text: errorText }],
      isError: true,
      details: undefined,
    } as any);
    expect(result).toBeDefined();
    expect(fetchImpl).not.toHaveBeenCalled();
    const output = result?.content[0]?.text ?? "";
    expect(output).toContain("omitted by head/tail cap");
    expect(output).toContain("run read /tmp/pi-archive/err-default.txt for full output");
  });
});

// ---------------------------------------------------------------------------
// §5 AXI — Empty-state guard
// ---------------------------------------------------------------------------

describe("empty-state guard", () => {
  it("passes empty text output through intact", async () => {
    const fetchImpl = mock(() =>
      Promise.resolve(Response.json({ compressed_output: "x" }, { status: 200 })),
    );
    const handler = createTestToolResultHandler({
      fetchImpl,
      baseUrl: "http://127.0.0.1:8320",
      aggregates: true,
      capErrors: true,
    });
    const result = await handler({
      toolName: "bash",
      toolCallId: "empty-1",
      input: { command: "echo" },
      content: [{ type: "text", text: "" }],
      isError: false,
      details: undefined,
    } as any);
    expect(result).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("passes output below minBytes through intact without aggregate", async () => {
    const fetchImpl = mock(() =>
      Promise.resolve(Response.json({ compressed_output: "x" }, { status: 200 })),
    );
    const handler = createToolResultHandler({
      fetchImpl,
      baseUrl: "http://127.0.0.1:8320",
      minBytesByGroup: { shell: 100, read: 100, search: 100 },
      aggregates: true,
      capErrors: true,
    });
    const result = await handler({
      toolName: "bash",
      toolCallId: "empty-2",
      input: { command: "echo hi" },
      content: [{ type: "text", text: "short" }],
      isError: false,
      details: undefined,
    } as any);
    expect(result).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("capped output is never empty — always contains head content", async () => {
    const handler = createTestToolResultHandler({
      fetchImpl: mock(() =>
        Promise.resolve(Response.json({ compressed_output: null }, { status: 200 })),
      ),
      baseUrl: "http://127.0.0.1:8320",
      routingStrategy: "benchmark",
      capFallbackBytes: 300,
      aggregates: true,
      archiveOriginal: mock(async () => "/tmp/pi-archive/guard.txt"),
    });
    const source = Array.from({ length: 100 }, (_, i) => `line-${i}`).join("\n");
    const result = await handler({
      toolName: "bash",
      toolCallId: "empty-3",
      input: { command: "cat big.log" },
      content: [{ type: "text", text: source }],
      isError: false,
      details: undefined,
    } as any);
    expect(result).toBeDefined();
    const output = result?.content[0]?.text ?? "";
    expect(output.length).toBeGreaterThan(0);
    expect(output).toContain("line-0");
    expect(output).toContain("run read /tmp/pi-archive/guard.txt for full output");
  });
});
