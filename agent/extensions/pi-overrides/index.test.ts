import { describe, expect, it } from "bun:test";
import { Container, Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piOverrides from "./index";

function createMockTheme() {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
}

function createMockExtensionApi() {
  const handlers = new Map<string, (event: object, ctx: object) => Promise<void> | void>();
  const registeredTools = new Map<string, { name: string; renderResult?: (...args: [object, object, object, object]) => object }>();
  let activeTools: string[] = ["read", "bash", "edit", "write"];
  const pi = {
    on(event: string, handler: (event: object, ctx: object) => Promise<void> | void) {
      handlers.set(event, handler);
    },
    registerTool(tool: { name: string; renderResult?: (...args: [object, object, object, object]) => object }) {
      registeredTools.set(tool.name, tool);
    },
    getActiveTools: () => activeTools,
    setActiveTools: (tools: string[]) => { activeTools = tools; },
  } as ExtensionAPI;
  return { pi, handlers, registeredTools, getActiveTools: () => activeTools };
}

describe("pi-overrides", () => {
  it("registers read grep ls find and augments active toolset", async () => {
    const { pi, handlers, registeredTools, getActiveTools } = createMockExtensionApi();
    piOverrides(pi);
    expect(getActiveTools()).toEqual(["read", "bash", "edit", "write"]);
    await handlers.get("session_start")?.({}, { cwd: "/home/abdwhb/.pi/agent" });
    expect(Array.from(registeredTools.keys()).toSorted()).toEqual(["find", "grep", "ls", "read"]);
    expect(getActiveTools()).toContain("grep");
    expect(getActiveTools()).toContain("find");
    expect(getActiveTools()).toContain("ls");
    expect(getActiveTools()).toContain("read");
    expect(getActiveTools()).toContain("bash");
    expect(getActiveTools()).toContain("edit");
    expect(getActiveTools()).toContain("write");
  });

  it("wraps read renderResult with compression footer when compression details exist", async () => {
    const { pi, handlers, registeredTools } = createMockExtensionApi();
    piOverrides(pi);
    await handlers.get("session_start")?.({}, { cwd: "/home/abdwhb/.pi/agent" });
    const readTool = registeredTools.get("read");
    if (!readTool?.renderResult) throw new Error("read tool not registered");

    const component = readTool.renderResult(
      {
        content: [{ type: "text", text: "hello" }],
        details: {
          compression: {
            originalLength: 100,
            compressedLength: 40,
            savedBytes: 60,
            savedPct: 60,
          },
        },
        isError: false,
      },
      { expanded: false, isPartial: false },
      createMockTheme(),
      {
        args: { path: "/tmp/x" },
        toolCallId: "1",
        invalidate() {},
        lastComponent: undefined,
        state: {},
        cwd: "/tmp",
        executionStarted: false,
        argsComplete: true,
        isPartial: false,
        expanded: false,
        showImages: true,
        isError: false,
      },
    );

    expect(component instanceof Container || component instanceof Text).toBe(true);
    expect(component).toBeInstanceOf(Container);
  });
});