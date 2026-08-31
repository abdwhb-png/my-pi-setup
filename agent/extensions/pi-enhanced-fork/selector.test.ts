import { describe, expect, it, mock } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

const extensionModule = (await import("./index.ts")) as Record<
  string,
  unknown
>;

interface Candidate {
  entryId: string;
  text: string;
}

interface SelectorLike {
  render(width: number): string[];
  handleInput(data: string): void;
}

interface SelectorTui {
  terminal: { rows: number };
  requestRender(): void;
}

type SelectorConstructor = new (
  candidates: readonly Candidate[],
  tui: SelectorTui,
  theme: Theme,
  done: (entryId: string | undefined) => void,
) => SelectorLike;

const theme = {
  fg: (_role: string, text: string) => text,
  bg: (_role: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  inverse: (text: string) => text,
  underline: (text: string) => text,
} as Theme;

function candidates(count: number): Candidate[] {
  return Array.from({ length: count }, (_, index) => ({
    entryId: `entry-${index + 1}`,
    text: `Prompt ${index + 1}`,
  }));
}

function createSelector(count: number, rows = 27, selectorTheme = theme) {
  const Selector = extensionModule.EnhancedForkSelector as
    | SelectorConstructor
    | undefined;
  expect(Selector).toBeFunction();

  const tui = {
    terminal: { rows },
    requestRender: mock(() => undefined),
  };
  const done = mock((_entryId: string | undefined) => undefined);
  const selector = new Selector!(candidates(count), tui, selectorTheme, done);
  return { selector, tui, done };
}

function selectedLine(selector: SelectorLike): string {
  return selector.render(60).find((line) => line.includes("› ")) ?? "";
}

describe("EnhancedForkSelector", () => {
  it("renders a bounded shared rounded frame with a closing footer", () => {
    const { selector } = createSelector(3, 27);
    const lines = selector.render(60);

    expect(lines[0]).toStartWith("╭");
    expect(lines.at(-1)).toEndWith("╯");
    expect(lines.every((line) => visibleWidth(line) === 56)).toBeTrue();
  });

  it("renders candidate indexes through the shared muted color", () => {
    const mutedTheme = {
      ...theme,
      fg: (role: string, text: string) =>
        role === "muted" ? `<muted>${text}</muted>` : text,
    } as Theme;
    const { selector } = createSelector(3, 27, mutedTheme);

    expect(selectedLine(selector)).toContain("<muted>[3/3]</muted>");
  });

  it("starts on the newest candidate and keeps it visible in a 27-row pane", () => {
    const { selector } = createSelector(8, 27);
    const lines = selector.render(60);

    expect(selectedLine(selector)).toContain("[8/8]");
    for (let index = 1; index <= 8; index += 1) {
      expect(lines.some((line) => line.includes(`Prompt ${index}`))).toBeTrue();
    }
  });

  it("preserves a visible valid selection across small and large resizes", () => {
    const { selector, tui } = createSelector(12, 40);
    selector.handleInput("\x1b[A");
    expect(selectedLine(selector)).toContain("[11/12]");

    tui.terminal.rows = 9;
    expect(selectedLine(selector)).toContain("[11/12]");
    expect(selector.render(60).length).toBeLessThanOrEqual(7);

    tui.terminal.rows = 40;
    expect(selectedLine(selector)).toContain("[11/12]");
  });

  it("navigates with legacy and Kitty sequences for every supported key", () => {
    const sequenceSets = [
      {
        up: "\x1b[A",
        down: "\x1b[B",
        pageUp: "\x1b[5~",
        pageDown: "\x1b[6~",
        home: "\x1b[H",
        end: "\x1b[F",
      },
      {
        up: "\x1b[57419u",
        down: "\x1b[57420u",
        pageUp: "\x1b[57421u",
        pageDown: "\x1b[57422u",
        home: "\x1b[57423u",
        end: "\x1b[57424u",
      },
    ];

    for (const keys of sequenceSets) {
      const up = createSelector(6, 10);
      up.selector.handleInput(keys.up);
      expect(selectedLine(up.selector)).toContain("[5/6]");

      const down = createSelector(6, 10);
      down.selector.handleInput(keys.down);
      expect(selectedLine(down.selector)).toContain("[1/6]");

      const pageUp = createSelector(6, 10);
      pageUp.selector.handleInput(keys.pageUp);
      expect(selectedLine(pageUp.selector)).toContain("[2/6]");

      const pageDown = createSelector(6, 10);
      pageDown.selector.handleInput(keys.home);
      pageDown.selector.handleInput(keys.pageDown);
      expect(selectedLine(pageDown.selector)).toContain("[5/6]");

      const home = createSelector(6, 10);
      home.selector.handleInput(keys.home);
      expect(selectedLine(home.selector)).toContain("[1/6]");

      const end = createSelector(6, 10);
      end.selector.handleInput(keys.home);
      end.selector.handleInput(keys.end);
      expect(selectedLine(end.selector)).toContain("[6/6]");

      expect(up.tui.requestRender).toHaveBeenCalledTimes(1);
    }
  });

  it("ignores Kitty key-release events", () => {
    const { selector, tui } = createSelector(6, 10);
    selector.handleInput("\x1b[57420;1:3u");

    expect(selectedLine(selector)).toContain("[6/6]");
    expect(tui.requestRender).not.toHaveBeenCalled();
  });

  it("navigates wheel up and down in SGR and legacy X10 encodings", () => {
    const encodings = [
      { up: "\x1b[<64;10;5M", down: "\x1b[<65;10;5M" },
      {
        up: String.fromCharCode(27, 91, 77, 96, 43, 38),
        down: String.fromCharCode(27, 91, 77, 97, 43, 38),
      },
    ];

    for (const wheel of encodings) {
      const { selector, tui } = createSelector(6, 10);
      selector.handleInput(wheel.up);
      expect(selectedLine(selector)).toContain("[5/6]");
      selector.handleInput(wheel.down);
      expect(selectedLine(selector)).toContain("[6/6]");
      expect(tui.requestRender).toHaveBeenCalledTimes(2);
    }
  });

  it("resolves Enter with the selected ID and Escape as cancellation", () => {
    const selected = createSelector(4);
    selected.selector.handleInput("\x1b[A");
    selected.selector.handleInput("\r");
    expect(selected.done).toHaveBeenCalledWith("entry-3");

    const cancelled = createSelector(4);
    cancelled.selector.handleInput("\x1b");
    expect(cancelled.done).toHaveBeenCalledWith(undefined);
  });
});
