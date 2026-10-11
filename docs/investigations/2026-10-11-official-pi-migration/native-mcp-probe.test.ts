import { expect, test } from "bun:test";
import {
    getMcpToolExposure,
    mcpNamespace,
    validateMcpServerConfig,
} from "/tmp/pi-official-1.1.0-source/packages/coding-agent/src/core/mcp-servers.ts";

test("legacy directTools is not interpreted as native direct exposure", () => {
    const result = validateMcpServerConfig("fixture", {
        url: "https://example.invalid/mcp",
        directTools: true,
        lifecycle: "lazy",
    });
    expect(typeof result).not.toBe("string");
    if (typeof result === "string") throw new Error(result);
    expect(getMcpToolExposure(result, "lookup")).toBe("codemode");
});

test("legacy bearer authentication requires explicit conversion", () => {
    const result = validateMcpServerConfig("fixture", {
        url: "https://example.invalid/mcp",
        auth: "bearer",
        bearerToken: "${FIXTURE_TOKEN}",
    });
    expect(result).toBe('server "fixture": auth.provider must be a provider name');
});

test("native bearer header and mixed tool exposure validate without credentials", () => {
    const result = validateMcpServerConfig("fixture", {
        url: "https://example.invalid/mcp",
        headers: { Authorization: "Bearer ${FIXTURE_TOKEN}" },
        exposure: "codemode",
        toolExposure: { lookup: "direct", "delete_*": "hidden" },
    });
    expect(typeof result).not.toBe("string");
    if (typeof result === "string") throw new Error(result);
    expect(getMcpToolExposure(result, "lookup")).toBe("direct");
    expect(getMcpToolExposure(result, "other")).toBe("codemode");
    expect(getMcpToolExposure(result, "delete_item")).toBe("hidden");
});

test("native namespaces normalize hyphens and require translated selectors", () => {
    expect(mcpNamespace("fixture-server")).toBe("mcp__fixture_server");
});
