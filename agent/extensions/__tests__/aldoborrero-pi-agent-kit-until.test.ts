import { beforeAll, describe, expect, it, mock } from "bun:test";

/**
 * The until extension must render its loop status through the shared
 * `_shared/fancy-footer` createWidget bridge (fancy-footer mode with
 * automatic fallback to ctx.ui.setWidget). Capture the widget def passed
 * to createWidget and assert it drives the visible/render lifecycle.
 */
const widgetDefs: any[] = [];
const fakeHandle = {
  active: true,
  update: mock(() => undefined),
  remove: mock(() => undefined),
};

mock.module("../_shared/fancy-footer", () => ({
  createWidget: mock((_pi: any, def: any) => {
    widgetDefs.push(def);
    return fakeHandle;
  }),
}));

mock.module("../_shared/ui/ui-colors.js", () => ({
  createUiColors: () => ({
    primary: (t: string) => t,
    meta: (t: string) => t,
    subtle: (t: string) => t,
    warning: (t: string) => t,
  }),
}));

mock.module("@earendil-works/pi-ai/compat", () => ({
  complete: mock(async () => ({ stopReason: "end_turn", content: [] })),
}));

mock.module("@earendil-works/pi-coding-agent", () => ({
  compact: mock(async () => ({})),
  DynamicBorder: class {},
}));

mock.module("@earendil-works/pi-tui", () => ({
  Container: class {
    addChild() {}
    render() {
      return [];
    }
    invalidate() {}
  },
  SelectList: class {
    handleInput() {}
  },
  Text: class {},
}));

mock.module("@sinclair/typebox", () => ({
  Type: { Object: (schema: any) => schema },
}));

let untilFactory: any;
beforeAll(async () => {
  untilFactory = (await import("../until.ts")).default;
});

function createMockApi() {
  const handlers = new Map<string, any[]>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const pi = {
    on: (event: string, handler: any) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand: (name: string, command: any) =>
      commands.set(name, command),
    registerTool: (def: any) => tools.set(def.name, def),
    sendMessage: mock(() => undefined),
    appendEntry: mock(() => undefined),
  } as any;
  return { pi, handlers, commands, tools };
}

function createCtx() {
  return {
    hasUI: true,
    ui: {
      notify: mock(() => undefined),
      theme: { fg: (_c: string, t: string) => t },
    },
    sessionManager: { getEntries: () => [] },
    hasPendingMessages: () => false,
  } as any;
}

const renderCtx = { theme: { fg: (_c: string, t: string) => t } };

describe("aldoborrero-pi-agent-kit until extension", () => {
  it("registers a loop widget through createWidget", async () => {
    widgetDefs.length = 0;
    const { pi } = createMockApi();
    untilFactory(pi);

    const widget = widgetDefs.find((w) => w.id === "loop");
    expect(widget).toBeDefined();
    expect(typeof widget.render).toBe("function");
    expect(typeof widget.visible).toBe("function");
    expect(widget.visible({})).toBe(false);
  });

  it("shows loop status while active and hides it on signal success", async () => {
    widgetDefs.length = 0;
    fakeHandle.update.mockClear();
    fakeHandle.remove.mockClear();
    const { pi, commands, tools } = createMockApi();
    const ctx = createCtx();
    untilFactory(pi);

    const widget = widgetDefs.find((w) => w.id === "loop");
    const until = commands.get("until");
    expect(until).toBeDefined();

    await until.handler("tests", ctx);
    await Promise.resolve();
    await Promise.resolve();

    expect(widget.visible({})).toBe(true);
    expect(widget.render(renderCtx)).toContain("Loop active");
    expect(pi.sendMessage).toHaveBeenCalled();
    expect(fakeHandle.update).toHaveBeenCalled();

    const signal = tools.get("signal_loop_success");
    expect(signal).toBeDefined();
    const result = await signal.execute("call-1", {}, undefined, undefined, ctx);

    expect(result.details.active).toBe(false);
    expect(widget.visible({})).toBe(false);
    expect(fakeHandle.remove).toHaveBeenCalled();
  });
});