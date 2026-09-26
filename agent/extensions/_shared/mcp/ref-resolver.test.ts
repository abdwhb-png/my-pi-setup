import { describe, expect, it, mock } from "bun:test";
import { computeServerHash } from "pi-mcp-adapter/metadata-cache";
import { createMcpRefResolver } from "./ref-resolver.ts";

const direct = { command: "fixture", directTools: true } as const;
const proxy = { command: "fixture" } as const;
const config = { mcpServers: { direct, proxy } };
const cache = {
    version: 1,
    servers: {
        direct: {
            configHash: computeServerHash(direct),
            cachedAt: Date.now(),
            tools: [{ name: "search" }],
            resources: [],
        },
        proxy: {
            configHash: computeServerHash(proxy),
            cachedAt: Date.now(),
            tools: [{ name: "lookup" }, { name: "search" }],
            resources: [],
        },
    },
};

const sources = {
    loadConfig: () => config,
    loadCache: () => cache,
};

describe("MCP reference resolver", () => {
    it("passes non-MCP names without loading configuration", () => {
        const loadConfig = mock(() => config);
        const resolve = createMcpRefResolver("/unused", {
            ...sources,
            loadConfig,
        });
        expect(resolve("read")).toEqual(["read"]);
        expect(loadConfig).not.toHaveBeenCalled();
    });

    it("resolves direct tools and proxy-only servers from one config snapshot", () => {
        const loadConfig = mock(() => config);
        const loadCache = mock(() => cache);
        const resolve = createMcpRefResolver("/unused", {
            ...sources,
            loadConfig,
            loadCache,
        });
        expect(resolve("mcp:direct/search")).toEqual(["direct_search"]);
        expect(resolve("mcp:proxy")).toEqual(["mcp__proxy"]);
        expect(resolve("mcp:proxy/proxy_lookup")).toEqual(["mcp__proxy"]);
        expect(resolve("mcp:proxy/missing")).toEqual([]);
        expect(resolve("mcp:unknown")).toEqual([]);
        expect(loadConfig).toHaveBeenCalledTimes(1);
        expect(loadCache).toHaveBeenCalledTimes(1);
    });

    it("preserves unprefixed server/tool references for proxy-only servers", () => {
        const resolve = createMcpRefResolver("/unused", sources);
        expect(resolve("mcp:proxy/lookup")).toEqual(["mcp__proxy"]);
        expect(resolve("mcp:proxy/missing")).toEqual([]);
    });

    it("rejects stale cache metadata instead of granting a nonexistent tool", () => {
        const resolve = createMcpRefResolver("/unused", {
            ...sources,
            loadCache: () => ({
                ...cache,
                servers: {
                    ...cache.servers,
                    proxy: { ...cache.servers.proxy, configHash: "stale" },
                },
            }),
        });
        expect(resolve("mcp:proxy")).toEqual([]);
    });

    it("passes partial MCP_DIRECT_TOOLS selectors in the official string-array format", () => {
        const resolve = createMcpRefResolver("/unused", {
            ...sources,
            envDirectTools: ["proxy/search"],
        });
        expect(resolve("mcp:proxy/search")).toEqual(["proxy_search"]);
        expect(resolve("mcp:proxy/proxy_lookup")).toEqual(["mcp__proxy"]);
    });

    it("does not double-prefix names already prefixed by their MCP server", () => {
        const firecrawl = { command: "fixture", directTools: true } as const;
        const resolve = createMcpRefResolver("/unused", {
            loadConfig: () => ({ mcpServers: { firecrawl } }),
            loadCache: () => ({
                version: 1,
                servers: {
                    firecrawl: {
                        configHash: computeServerHash(firecrawl),
                        cachedAt: Date.now(),
                        tools: [{ name: "firecrawl_scrape" }],
                        resources: [],
                    },
                },
            }),
        });
        expect(resolve("mcp:firecrawl/firecrawl_scrape")).toEqual([
            "firecrawl_scrape",
        ]);
    });

    it("reports a load failure and retries on the next reference", () => {
        const loadConfig = mock()
            .mockImplementationOnce(() => {
                throw new Error("config unavailable");
            })
            .mockImplementation(() => config);
        const resolve = createMcpRefResolver("/unused", {
            ...sources,
            loadConfig,
        });
        expect(() => resolve("mcp:direct/search")).toThrow("config unavailable");
        expect(resolve("mcp:direct/search")).toEqual(["direct_search"]);
        expect(loadConfig).toHaveBeenCalledTimes(2);
    });
});
