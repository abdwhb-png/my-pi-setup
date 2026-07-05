import { describe, expect, it, mock } from "bun:test";

// Mock the shared bridge snapshot exports used by index.ts.
const snapshotMock = mock(() => []);
const subscribeMock = mock(() => () => undefined);
const refreshMock = mock(() => undefined);
const publishedSnaps: unknown[] = [];

mock.module("../_shared/fancy-footer.ts", () => ({
  getFancyFooterExtensionStatusesSnapshot: (...args: unknown[]) => snapshotMock(...args),
  subscribeFancyFooterExtensionStatuses: (...args: unknown[]) =>
    subscribeMock(...(args as [])),
  requestFancyFooterRefresh: (...args: unknown[]) => refreshMock(...args),
  publishExtensionStatusesSnapshot: (snap: unknown) => publishedSnaps.push(snap),
}));

function createMockAPI() {
  const commands = new Map<string, { description: string; getArgumentCompletions?: (prefix: string) => unknown; handler: (args: string, ctx: unknown) => Promise<void> }>();
  const pi = {
    events: { on: mock(), off: mock() },
    on: mock(),
    registerCommand: (name: string, command: unknown) => {
      commands.set(name, command as never);
    },
} as unknown as Parameters<typeof import("./index.ts")["default"]>[0];
  return { pi, commands };
}

function createCtx(selectSequence: (string | undefined)[]) {
  const selectCalls: { title: string; options: string[] }[] = [];
  let selectIndex = 0;
  const ctx = {
    hasUI: true,
    ui: {
      notify: mock(() => undefined),
      select: mock(async (title: string, options: string[]) => {
        selectCalls.push({ title, options });
        return selectSequence[selectIndex++];
      }),
      confirm: mock(async () => true),
    },
  } as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext;
  return { ctx, selectCalls };
}

describe("extension-status command", () => {
  it("registers /extension-status with autocomplete", async () => {
    const { default: factory } = await import("./index.ts");
    snapshotMock.mockImplementation(() => [
      { id: "lsp", status: "LSP: ready" },
    ]);
    const { pi, commands } = createMockAPI();
    factory(pi);

    const command = commands.get("extension-status");
    expect(command).toBeDefined();

    const completions = command!.getArgumentCompletions?.("") as {
      value: string;
      label: string;
    }[];
    expect(completions.length).toBeGreaterThan(0);
    expect(completions[0]!.value).toBe("lsp");
  });

  it("autocomplete filters by prefix against id or status", async () => {
    const { default: factory } = await import("./index.ts");
    snapshotMock.mockImplementation(() => [
      { id: "lsp", status: "ready" },
      { id: "caveman", status: "ULTRA mode" },
    ]);
    const { pi, commands } = createMockAPI();
    factory(pi);
    const command = commands.get("extension-status");

    const lspOnly = command!.getArgumentCompletions?.("lsp") as {
      value: string;
    }[];
    expect(lspOnly).toHaveLength(1);
    expect(lspOnly[0]!.value).toBe("lsp");
  });

  it("notifies when there are no statuses", async () => {
    const { default: factory } = await import("./index.ts");
    snapshotMock.mockImplementation(() => []);
    const { pi, commands } = createMockAPI();
    const { ctx } = createCtx([]);
    factory(pi);
    const command = commands.get("extension-status");

    await command!.handler("", ctx);
    // notify was called with the no-statuses message.
    expect((ctx.ui.notify as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  });
});
