import { describe, expect, it, mock } from "bun:test";
import { ArtifactReviewView } from "./review";

function createBody(lines: string[]) {
  return {
    render: mock((_width: number) => lines),
    invalidate: mock(() => undefined),
  };
}

const colors = {
  accent: (text: string) => `<accent>${text}</accent>`,
  dim: (text: string) => `<dim>${text}</dim>`,
  selected: (text: string) => `<selected>${text}</selected>`,
};

describe("ArtifactReviewView", () => {
  it("renders a scrollable artifact preview with transition actions", () => {
    const done = mock((_decision: "Approve" | "Reject" | "Reject with reason") => undefined);
    const requestRender = mock(() => undefined);
    const body = createBody(Array.from({ length: 8 }, (_, index) => `artifact line ${index + 1}`));
    const view = new ArtifactReviewView({
      title: "Discovery r002 → Understanding",
      subtitle: "docs/brainstorms/run/01-discovery-r002.md",
      body,
      viewportRows: 3,
      colors,
      requestRender,
      done,
    });

    const initial = view.render(80).join("\n");
    expect(initial).toContain("Discovery r002 → Understanding");
    expect(initial).toContain("artifact line 1");
    expect(initial).toContain("1-3/8");
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
        colors,
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
