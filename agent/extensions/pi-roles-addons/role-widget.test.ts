import { describe, expect, it } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { createUiColors } from "../_shared/ui-colors";
import { renderActiveRoleWidget } from "./role-widget";

/** Minimal mock theme: fg wraps text as [color]text so tests get deterministic output. */
const mockTheme = { fg: (color: string, text: string) => `[${color}]${text}` } as unknown as Theme;
const colors = createUiColors(mockTheme);

describe("renderActiveRoleWidget", () => {
  it("renders active role name with themed colors", () => {
    const role = { name: "pi-caveman", source: "user" as const, path: "/roles/pi-caveman.md", appliedAt: 1 };
    expect(renderActiveRoleWidget(role, colors)).toContain("[accent]pi-caveman");
  });

  it("hides when no active role exists", () => {
    expect(renderActiveRoleWidget(null, colors)).toContain("No active role");
  });
});
