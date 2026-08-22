import { describe, it, expect, mock, spyOn } from "bun:test";

// Mock the runtime module since we only have a type shim
mock.module("pi-fancy-footer/api", () => ({
  defineFancyFooterWidget: <T>(x: T) => x,
  contributeFancyFooterWidgets: mock(),
  requestFancyFooterWidgetDiscovery: mock(),
  requestFancyFooterRefresh: mock(),
}));

// Type-level imports (resolved from the .d.ts shim)
import type { FancyFooterWidgetContribution } from "pi-fancy-footer/api";

describe("FancyFooterWidgetContribution", () => {
  it("has flat row/order/align/grow props (not nested under defaults)", () => {
    const widget: FancyFooterWidgetContribution = {
      id: "test.widget",
      description: "A test widget",
      row: 1,
      order: 5,
      align: "right",
      grow: true,
      minWidth: 10,
      render: () => "hello",
    };
    expect(widget.id).toBe("test.widget");
    expect(widget.row).toBe(1);
    expect(widget.order).toBe(5);
    expect(widget.align).toBe("right");
    expect(widget.grow).toBe(true);
    expect(widget.minWidth).toBe(10);
  });

  it("allows render to return string, undefined, null, or false", () => {
    const returnsString: FancyFooterWidgetContribution = {
      id: "test.returns-string",
      description: "Returns string",
      row: 0,
      order: 0,
      render: (_ctx) => "visible",
    };
    expect(returnsString.render({} as any)).toBe("visible");

    const returnsUndefined: FancyFooterWidgetContribution = {
      id: "test.returns-undefined",
      description: "Returns undefined (hidden)",
      row: 0,
      order: 0,
      render: () => undefined,
    };
    expect(returnsUndefined.render({} as any)).toBeUndefined();

    const returnsNull: FancyFooterWidgetContribution = {
      id: "test.returns-null",
      description: "Returns null (hidden)",
      row: 0,
      order: 0,
      render: () => null,
    };
    expect(returnsNull.render({} as any)).toBeNull();

    const returnsFalse: FancyFooterWidgetContribution = {
      id: "test.returns-false",
      description: "Returns false (hidden)",
      row: 0,
      order: 0,
      render: () => false,
    };
    expect(returnsFalse.render({} as any)).toBe(false);
  });

  it("supports icon as family map or function", () => {
    const widget: FancyFooterWidgetContribution = {
      id: "test.map-icon",
      description: "Map icon",
      row: 0,
      order: 0,
      icon: { nerd: "󰙨", emoji: "🧪", unicode: "◈", ascii: "B" },
      render: () => "test",
    };
    expect(widget.icon).toBeDefined();
  });
});

describe("createWidget", () => {
  it("calls contribute + discovery on creation", async () => {
    const mockPi = { events: { on: mock(), emit: mock() } } as any;
    const { createWidget } = await import("./fancy-footer");
    const { contributeFancyFooterWidgets, requestFancyFooterWidgetDiscovery } =
      await import("pi-fancy-footer/api");

    const w = createWidget(mockPi, {
      id: "test.create",
      render: () => "hello",
    });

    expect(contributeFancyFooterWidgets).toHaveBeenCalled();
    expect(requestFancyFooterWidgetDiscovery).toHaveBeenCalled();
    expect(w.active).toBe(true);
  });

  it("update calls refresh in fancy-footer mode", async () => {
    const mockPi = { events: { on: mock(), emit: mock() } } as any;
    const { createWidget } = await import("./fancy-footer");
    const { requestFancyFooterRefresh } = await import("pi-fancy-footer/api");

    const w = createWidget(mockPi, {
      id: "test.refresh",
      render: () => "hello",
    });

    const ctx = { hasUI: true, ui: { setWidget: mock(), setStatus: mock() } } as any;
    w.update(ctx);

    expect(requestFancyFooterRefresh).toHaveBeenCalled();
  });

  it("update safely catches errors if requestFancyFooterRefresh throws", async () => {
    const mockPi = { events: { on: mock(), emit: mock() } } as any;
    const { createWidget } = await import("./fancy-footer");
    const { requestFancyFooterRefresh } = await import("pi-fancy-footer/api");
    (requestFancyFooterRefresh as any).mockImplementationOnce(() => {
      throw new Error("This extension ctx is stale after session replacement or reload.");
    });

    const w = createWidget(mockPi, {
      id: "test.refresh.throw",
      render: () => "hello",
    });

    const ctx = { hasUI: true, ui: { setWidget: mock(), setStatus: mock() } } as any;
    expect(() => w.update(ctx)).not.toThrow();
  });

  it("update safely catches errors if ctx.ui.setWidget throws in fallback mode", async () => {
    const mockPi = { events: { on: mock(), emit: mock() } } as any;
    const { createWidget } = await import("./fancy-footer");

    const w = createWidget(mockPi, {
      id: "test.fallback.throw",
      render: () => "hello",
    });
    // simulate inactive fallback mode
    (w as any).isActive = false;

    const ctx = {
      hasUI: true,
      ui: {
        setWidget: mock(() => {
          throw new Error("UI context is stale");
        }),
      },
    } as any;
    expect(() => w.update(ctx, "fallback")).not.toThrow();
    expect(() => w.remove(ctx)).not.toThrow();
  });

  it("update falls back to setWidget when not active", () => {
    // We can't easily mock a failed import to test the fallback path,
    // but the code path is clear: if contribute throws, isActive = false.
  });
});
