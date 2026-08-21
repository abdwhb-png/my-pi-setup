import { describe, expect, it } from "bun:test";
import { resolveMcpToolReferences, parseMcpReference, isProxyOnlyServer, namespaceProxyName } from "./resolver.ts";
// Import guard: the shared MCP resolver depends on the naming helpers, which
// must stay covered by a test (see extensions/__tests__/coverage.test.ts).
import { formatToolName, getServerPrefix, resolveToolPrefix, resourceNameToToolName } from "./naming.ts";
import type { McpConfig, MetadataCache } from "./types.ts";

function makeCache(): MetadataCache {
  return {
    version: 1,
    servers: {
      context7: {
        configHash: "h",
        cachedAt: Date.now(),
        tools: [
          { name: "resolve_library_id" },
          { name: "query_docs" },
        ],
        resources: [],
      },
      deepwiki: {
        configHash: "h",
        cachedAt: Date.now(),
        tools: [
          { name: "ask_question" },
          { name: "read_wiki_contents" },
        ],
        resources: [],
      },
      "context-mode": {
        configHash: "h",
        cachedAt: Date.now(),
        tools: [
          { name: "ctx_execute" },
          { name: "ctx_search" },
        ],
        resources: [],
      },
    },
  };
}

function makeConfig(): McpConfig {
  return {
    mcpServers: {
      context7: { url: "https://mcp.context7.com/mcp", directTools: true },
      deepwiki: { url: "https://mcp.deepwiki.com/mcp", directTools: true },
      "context-mode": { command: "context-mode", lifecycle: "eager" },
    },
  };
}

describe("formatToolName (naming helpers)", () => {
    it("applies the default server prefix", () => {
        expect(formatToolName("query_docs", "context7", "server")).toBe("context7_query_docs");
    });

    it("applies the mcp prefix style", () => {
        expect(getServerPrefix("context-mode", "mcp")).toBe("mcp__context_mode");
        expect(resolveToolPrefix(undefined, "server")).toBe("server");
    });

    it("sanitizes resource names to tool names", () => {
        expect(resourceNameToToolName("My Docs")).toBe("my_docs");
    });
});

describe("parseMcpReference", () => {
  it("returns empty for a bare mcp: with no server", () => {
    expect(parseMcpReference("mcp:")).toEqual({ raw: "mcp:" });
  });

  it("parses server-level reference", () => {
    expect(parseMcpReference("mcp:context7")).toEqual({ raw: "mcp:context7", server: "context7" });
  });

  it("parses server/tool reference", () => {
    expect(parseMcpReference("mcp:context7/query_docs")).toEqual({
      raw: "mcp:context7/query_docs",
      server: "context7",
      tool: "query_docs",
    });
  });

  it("does not treat a non-mcp reference as mcp", () => {
    expect(parseMcpReference("read")).toEqual({ raw: "read" });
  });
});

describe("isProxyOnlyServer", () => {
  it("is false for directTools: true", () => {
    expect(isProxyOnlyServer({ directTools: true }, undefined)).toBe(false);
  });

  it("is true when directTools is unset and no global directTools", () => {
    expect(isProxyOnlyServer({}, undefined)).toBe(true);
  });

  it("is true for a proxy-only server even with global directTools unset", () => {
    expect(isProxyOnlyServer({ command: "x" }, {})).toBe(true);
  });

  it("is false when global directTools is true", () => {
    expect(isProxyOnlyServer({}, { directTools: true })).toBe(false);
  });
});

describe("namespaceProxyName", () => {
  it("formats server name with mcp__ prefix and underscores", () => {
    expect(namespaceProxyName("context-mode")).toBe("mcp__context_mode");
  });
});

describe("resolveMcpToolReferences", () => {
  const cache = makeCache();
  const config = makeConfig();

  it("expands a server-level reference to all its tools", () => {
    const r = resolveMcpToolReferences(["mcp:context7"], config, cache);
    expect(r.names).toEqual(["context7_resolve_library_id", "context7_query_docs"]);
    expect(r.diagnostics).toEqual([]);
  });

  it("resolves a specific server/tool reference", () => {
    const r = resolveMcpToolReferences(["mcp:context7/query_docs"], config, cache);
    expect(r.names).toEqual(["context7_query_docs"]);
    expect(r.diagnostics).toEqual([]);
  });

  it("resolves a bare tool reference to its owning direct server tool", () => {
    const r = resolveMcpToolReferences(["mcp:ask_question"], config, cache);
    expect(r.names).toEqual(["deepwiki_ask_question"]);
    expect(r.diagnostics).toEqual([]);
  });

  it("resolves a bare tool on a proxy-only server to the namespace-proxy name", () => {
    const r = resolveMcpToolReferences(["mcp:ctx_execute"], config, cache);
    expect(r.names).toEqual(["mcp__context_mode"]);
    expect(r.diagnostics).toEqual([]);
  });

  it("resolves a server-level reference on a proxy-only server to its namespace-proxy name", () => {
    const r = resolveMcpToolReferences(["mcp:context-mode"], config, cache);
    expect(r.names).toEqual(["mcp__context_mode"]);
    expect(r.diagnostics).toEqual([]);
  });

  it("passes non-mcp references through unchanged", () => {
    const r = resolveMcpToolReferences(["read", "grep"], config, cache);
    expect(r.names).toEqual(["read", "grep"]);
    expect(r.diagnostics).toEqual([]);
  });

  it("deduplicates across references", () => {
    const r = resolveMcpToolReferences(["mcp:context7", "mcp:context7/query_docs"], config, cache);
    expect(r.names).toEqual(["context7_resolve_library_id", "context7_query_docs"]);
  });

  it("emits a diagnostic for an unknown server and no tool match", () => {
    const r = resolveMcpToolReferences(["mcp:does-not-exist"], config, cache);
    expect(r.names).toEqual([]);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });

  it("emits a diagnostic for an unknown tool on a known server", () => {
    const r = resolveMcpToolReferences(["mcp:context7/nope"], config, cache);
    expect(r.names).toEqual([]);
    expect(r.diagnostics.join(" ")).toContain("unknown tool");
  });

  it("returns a diagnostic when config is missing", () => {
    const r = resolveMcpToolReferences(["mcp:context7"], null, cache);
    expect(r.names).toEqual([]);
    expect(r.diagnostics.length).toBeGreaterThan(0);
  });
});
