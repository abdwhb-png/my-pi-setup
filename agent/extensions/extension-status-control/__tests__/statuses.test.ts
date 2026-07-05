import { describe, expect, it } from "bun:test";
import {
  classifyStatus,
  decorateStatuses,
  filterStatuses,
  toCompletions,
} from "../statuses.ts";
import { isHidden, toggleHidden } from "../visibility.ts";

describe("statuses classify/decode", () => {
  it("classifies error keywords", () => {
    expect(classifyStatus("LSP: missing server")).toBe("error");
    expect(classifyStatus("extension locked")).toBe("error");
    expect(classifyStatus("client off")).toBe("error");
  });

  it("classifies warning keywords", () => {
    expect(classifyStatus("setup required")).toBe("warning");
    expect(classifyStatus("no-key configured")).toBe("warning");
  });

  it("defaults to info", () => {
    expect(classifyStatus("caveman level: ULTRA")).toBe("info");
    expect(classifyStatus("ready")).toBe("info");
  });

  it("decorates statuses with icon + label", () => {
    const decorated = decorateStatuses([
      { id: "lsp", status: "LSP: ready" },
      { id: "noisy", status: "missing config" },
    ]);
    expect(decorated[0]).toEqual({
      id: "lsp",
      status: "LSP: ready",
      severity: "info",
      icon: "·",
      label: "· lsp — LSP: ready",
    });
    expect(decorated[1]!.severity).toBe("error");
    expect(decorated[1]!.icon).toBe("●");
  });

  it("filters by query matching id or status", () => {
    const decorated = decorateStatuses([
      { id: "lsp", status: "ready" },
      { id: "caveman", status: "ULTRA" },
    ]);
    expect(filterStatuses(decorated, "lsp")).toHaveLength(1);
    expect(filterStatuses(decorated, "ultra")).toHaveLength(1);
    expect(filterStatuses(decorated, "")).toHaveLength(2);
  });

  it("builds completions capped by limit", () => {
    const decorated = decorateStatuses(
      Array.from({ length: 40 }, (_, i) => ({
        id: `ext${i}`,
        status: `ok${i}`,
      })),
    );
    const completions = toCompletions(decorated);
    expect(completions).toHaveLength(30);
    expect(completions[0]).toEqual({
      value: "ext0",
      label: "· ext0 — ok0",
      description: "ok0",
    });
  });
});

describe("visibility helpers", () => {
  it("isHidden checks membership", () => {
    expect(isHidden(["lsp"], "lsp")).toBe(true);
    expect(isHidden(["lsp"], "caveman")).toBe(false);
  });

  it("toggleHidden flips membership", () => {
    const hidden = toggleHidden(["lsp"], "lsp");
    expect(hidden.nowHidden).toBe(false);
    expect(hidden.hiddenIds).toEqual([]);

    const shown = toggleHidden([], "caveman");
    expect(shown.nowHidden).toBe(true);
    expect(shown.hiddenIds).toEqual(["caveman"]);
  });
});
