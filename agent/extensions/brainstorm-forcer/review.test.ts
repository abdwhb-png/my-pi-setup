import { describe, expect, it, mock } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ArtifactReviewView } from "./review";

function createBody(lines: string[]) {
  return {
    render: mock((_width: number) => lines),
    invalidate: mock(() => undefined),
  };
}

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  italic: (text: string) => text,
  inverse: (text: string) => text,
  underline: (text: string) => text,
} as any;

describe("ArtifactReviewView", () => {
  it("wraps a long artifact path without widening the review frame", () => {
    const view = new ArtifactReviewView({
      title: "Documenting r001 → Complete brainstorm",
      subtitle: `docs/${"very-long-path-segment-".repeat(5)}artifact.md`,
      body: createBody(["content"]),
      viewportRows: 3,
      theme,
      requestRender: () => undefined,
      done: () => undefined,
    });

    const lines = view.render(80);

    expect(lines.some((line) => line.includes("docs/"))).toBe(true);
    expect(lines.some((line) => line.includes("artifact.md"))).toBe(true);
    expect(lines.every((line) => visibleWidth(line) === 76)).toBe(true);
  });

  it("renders a scrollable artifact preview with transition actions", () => {
    const done = mock((_decision: "Approve" | "Reject" | "Reject with reason") => undefined);
    const requestRender = mock(() => undefined);
    const body = createBody(Array.from({ length: 8 }, (_, index) => `artifact line ${index + 1}`));
    const view = new ArtifactReviewView({
      title: "Discovery r002 → Understanding",
      subtitle: "docs/brainstorms/run/01-discovery-r002.md",
      body,
      viewportRows: 3,
      theme,
      requestRender,
      done,
    });

    const initial = view.render(80).join("\n");
    expect(initial).toContain("Discovery r002 → Understanding");
    expect(initial).toContain("artifact line 1");
    // BoxRenderer emits scroll info as [offset/max↑↓] in the footer
    expect(initial).toContain("[0/5↑↓]");
    expect(initial).toContain("[ Approve ]");

    view.handleInput("j");
    expect(view.render(80).join("\n")).toContain("artifact line 4");
    expect(requestRender).toHaveBeenCalled();
  });

  it("returns the selected decision and treats escape as rejection", () => {
    const decisions: string[] = [];
    const makeView = () =>
      new ArtifactReviewView({
        title: "Review",
        subtitle: "artifact.md",
        body: createBody(["content"]),
        viewportRows: 3,
        theme,
        requestRender: () => undefined,
        done: (decision) => decisions.push(decision),
      });

    const selected = makeView();
    selected.handleInput("l");
    selected.handleInput("\r");
    expect(decisions.at(-1)).toBe("Reject");

    makeView().handleInput("\u001b");
    expect(decisions.at(-1)).toBe("Reject");
  });
});
