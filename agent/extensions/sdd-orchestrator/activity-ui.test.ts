import { describe, expect, it } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";

import type { SddRunActivity } from "./activity-store";
import {
  SddLiveComponent,
  openSddLive,
  renderSddActivityWidget,
  type SddActivitySource,
} from "./activity-ui";

function theme() {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    bg: (_color: string, text: string) => text,
    italic: (text: string) => text,
    underline: (text: string) => text,
    inverse: (text: string) => text,
    strikethrough: (text: string) => text,
  } as never;
}

function activityRun(state: SddRunActivity["state"] = "running"): SddRunActivity {
  return {
    runId: "run-1",
    planTitle: "Live plan",
    state,
    revision: 3,
    live: true,
    startedAt: Date.parse("2026-08-02T10:00:00Z"),
    presentationTerminal: ["needs_input", "failed", "cancelled", "completed"].includes(state),
    tasks: ["one", "two", "three", "four"].map((name, index) => ({
      id: `task-${index + 1}`,
      title: `Task ${name} with a deliberately long title`,
      state: index < 3 ? (index === 1 ? "reviewing" : "implementing") : "verified",
      delegations: index < 3
        ? [{
            requestId: `request-${index + 1}`,
            stage: index === 1 ? "combined" : "worker",
            attempt: 1,
            agent: index === 1 ? "combined-reviewer" : "quick-worker",
            model: "model-a",
            phase: "running" as const,
            currentTool: { tool: "exec", args: '{"cmd":"bun test"}' },
            recentTools: [{ tool: "read", args: "src/file.ts" }],
            recentOutputLines: Array.from({ length: 12 }, (_, line) => `output ${line + 1}`),
            durationMs: 2_500,
            tokens: 1234,
            toolCount: 3,
          }]
        : [],
    })),
  };
}

class MutableSource implements SddActivitySource {
  current = activityRun();
  listeners = new Set<() => void>();

  getRun(runId: string): SddRunActivity | undefined {
    return runId === this.current.runId ? structuredClone(this.current) : undefined;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(): void {
    for (const listener of this.listeners) listener();
  }
}

describe("SDD activity widget", () => {
  it("renders at most five lines with two active tasks and overflow", () => {
    const lines = renderSddActivityWidget(activityRun(), 80, theme(), Date.parse("2026-08-02T10:01:05Z"));
    expect(lines).toHaveLength(5);
    expect(lines.join("\n")).toContain("quick-worker");
    expect(lines.join("\n")).toContain("combined-reviewer");
    expect(lines.at(-1)).toContain("+1 more");
    expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
  });

  it("truncates task titles before real agent names on narrow terminals", () => {
    const lines = renderSddActivityWidget(activityRun(), 36, theme(), Date.now());
    expect(lines.some((line) => line.includes("quick-worker"))).toBe(true);
    expect(lines.every((line) => visibleWidth(line) <= 36)).toBe(true);
  });

    it("renders a terminal summary without active task rows", () => {
        const base = activityRun("completed");
        const run: SddRunActivity = {
            ...base,
            tasks: base.tasks.map((task) => ({
                ...task,
                state: "verified",
                delegations: task.delegations.map((delegation) => ({
                    ...delegation,
                    phase: "terminal",
                    status: "completed",
                })),
            })),
        };
    const lines = renderSddActivityWidget(run, 60, theme(), Date.now());
    expect(lines.join("\n")).toContain("completed");
    expect(lines.join("\n")).toContain("4 verified");
    expect(lines.length).toBeLessThanOrEqual(5);
  });
});

describe("SDD live overlay", () => {
  it("keeps a bounded responsive frame at 36, 60, and 96 columns and low heights", () => {
    for (const width of [36, 60, 96]) {
      for (const rows of [8, 16, 32]) {
        const source = new MutableSource();
        const component = new SddLiveComponent(
          { requestRender() {}, terminal: { rows } } as never,
          theme(),
          source,
          "run-1",
          () => {},
        );
        const rendered = component.render(width);
        const budget = Math.max(1, Math.min(Math.floor(rows * 0.85), rows - 2));
        expect(rendered.length).toBeLessThanOrEqual(budget);
        expect(rendered.every((line) => visibleWidth(line) <= width)).toBe(true);
        expect(rendered[0]).toStartWith("╭");
        expect(rendered.at(-1)).toStartWith("╰");
        component.dispose();
      }
    }
  });

  it("shows active pane feedback and supports legacy plus Kitty navigation", () => {
    const source = new MutableSource();
    let renders = 0;
    const component = new SddLiveComponent(
      { requestRender() { renders += 1; }, terminal: { rows: 32 } } as never,
      theme(),
      source,
      "run-1",
      () => {},
    );
    expect(component.render(60).join("\n")).toContain("▸ TASKS");
    component.handleInput("\x1b[B");
    expect(component.selectedTaskId).toBe("task-2");
    component.handleInput("\x1b[57420u");
    expect(component.selectedTaskId).toBe("task-3");
    component.handleInput("\t");
    expect(component.render(60).join("\n")).toContain("▸ ACTIVITY");
    expect(renders).toBe(3);
    component.dispose();
  });

  it("keeps selection stable, bounds scrolling, and only rerenders observable updates", () => {
    const source = new MutableSource();
    let renders = 0;
    const component = new SddLiveComponent(
      { requestRender() { renders += 1; }, terminal: { rows: 20 } } as never,
      theme(),
      source,
      "run-1",
      () => {},
    );
    component.render(60);
    component.handleInput("\x1b[B");
    expect(component.selectedTaskId).toBe("task-2");
    source.emit();
    expect(renders).toBe(1);
    source.current = { ...source.current, revision: 4, tasks: [source.current.tasks[3]!, ...source.current.tasks.slice(0, 3)] };
    source.emit();
    expect(component.selectedTaskId).toBe("task-2");
    expect(renders).toBe(2);
    component.handleInput("\t");
    component.handleInput("\x1b[6~");
    component.handleInput("\x1b[57424u");
    expect(component.render(60).join("\n")).toContain("output 12");
    component.dispose();
    expect(source.listeners.size).toBe(0);
  });

  it("closes via legacy Escape and Kitty q and refuses non-TUI opening", async () => {
    const source = new MutableSource();
    let closes = 0;
    for (const key of ["\x1b", "\x1b[113u"]) {
      const component = new SddLiveComponent(
        { requestRender() {}, terminal: { rows: 32 } } as never,
        theme(),
        source,
        "run-1",
        () => { closes += 1; },
      );
      component.handleInput(key);
    }
    expect(closes).toBe(2);
    await expect(openSddLive({ mode: "rpc" } as never, source, "run-1")).rejects.toThrow("requires TUI mode");
  });
});
