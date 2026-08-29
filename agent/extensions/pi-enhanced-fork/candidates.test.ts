import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

const extensionModule = (await import("./index.ts")) as Record<
  string,
  unknown
>;

type ExtractForkCandidates = (
  entries: readonly SessionEntry[],
) => Array<{ entryId: string; text: string }>;

describe("extractForkCandidates", () => {
  it("keeps exact user entry IDs and skips non-user or empty entries", () => {
    const extractForkCandidates = extensionModule.extractForkCandidates as
      | ExtractForkCandidates
      | undefined;
    const entries = [
      {
        type: "message",
        id: "assistant-id",
        parentId: null,
        timestamp: "2026-08-29T00:00:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Ignore me" }],
          api: "openai-responses",
          provider: "openai",
          model: "test",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: 0,
        },
      },
      {
        type: "message",
        id: "empty-id",
        parentId: "assistant-id",
        timestamp: "2026-08-29T00:00:01.000Z",
        message: { role: "user", content: "   ", timestamp: 1 },
      },
      {
        type: "message",
        id: "first-user-id",
        parentId: "empty-id",
        timestamp: "2026-08-29T00:00:02.000Z",
        message: { role: "user", content: "First prompt", timestamp: 2 },
      },
      {
        type: "message",
        id: "second-user-id",
        parentId: "first-user-id",
        timestamp: "2026-08-29T00:00:03.000Z",
        message: {
          role: "user",
          content: [
            { type: "text", text: "Second" },
            { type: "image", data: "AA==", mimeType: "image/png" },
            { type: "text", text: " prompt" },
          ],
          timestamp: 3,
        },
      },
    ] satisfies SessionEntry[];

    expect(extractForkCandidates).toBeFunction();
    expect(extractForkCandidates?.(entries)).toEqual([
      { entryId: "first-user-id", text: "First prompt" },
      { entryId: "second-user-id", text: "Second prompt" },
    ]);
  });
});

describe("compactExpandedSkillInput", () => {
  it("restores leading expanded skill blocks as a compact skill command", () => {
    const compactExpandedSkillInput = extensionModule.compactExpandedSkillInput as
      | ((text: string) => string | undefined)
      | undefined;
    const expanded =
      '<skill name="diagnose" location="/skills/diagnose/SKILL.md">instructions</skill>\n\n' +
      '<skill name="bun" location="/skills/bun/SKILL.md">instructions</skill>\n\n' +
      "Investigate the selector";

    expect(compactExpandedSkillInput).toBeFunction();
    expect(compactExpandedSkillInput?.(expanded)).toBe(
      "/skill:diagnose,bun Investigate the selector",
    );
    expect(compactExpandedSkillInput?.("Ordinary prompt")).toBeUndefined();
  });
});
