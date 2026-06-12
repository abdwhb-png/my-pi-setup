/**
 * Tests for sdd-orchestrator plan parser (parsePlan).
 *
 * Tests the core logic: parsing markdown plans into structured tasks.
 * Pi-specific imports are mocked so we can import from the real module.
 */

import { mock, describe, it, expect } from "bun:test";

mock.module("@earendil-works/pi-coding-agent", () => ({}));
mock.module("@sinclair/typebox", () => ({
  Type: {
    Object: mock(),
    String: mock(),
    Optional: mock(),
  },
}));

const { parsePlan } = await import("./index.ts");

describe("parsePlan", () => {
  describe("task heading detection", () => {
    it("parses ## Task N: Title format", () => {
      const plan = `# My Plan

## Task 1: Install dependencies

Run pnpm add -D vitest.

## Task 2: Write tests

Write vitest tests for the extension.`;

      const result = parsePlan(plan);
      expect(result.title).toBe("My Plan");
      expect(result.tasks).toHaveLength(2);

      expect(result.tasks[0]).toMatchObject({
        id: 1,
        title: "Install dependencies",
      });
      expect(result.tasks[0].description).toContain("Run pnpm add -D vitest");

      expect(result.tasks[1]).toMatchObject({
        id: 2,
        title: "Write tests",
      });
      expect(result.tasks[1].description).toContain("Write vitest tests");
    });

    it("parses ### Task N: Title format (deeper heading)", () => {
      const plan = `# Plan

### Task 1: Do the thing

Description here.

### Task 2: Do another

More description.`;

      const result = parsePlan(plan);
      expect(result.tasks).toHaveLength(2);
      expect(result.tasks[0].title).toBe("Do the thing");
      expect(result.tasks[1].title).toBe("Do another");
    });

    it("parses ## N. Title format (no 'Task' prefix)", () => {
      const plan = `# Plan

## 1. First step

Do something.

## 2. Second step

Do something else.`;

      const result = parsePlan(plan);
      expect(result.tasks).toHaveLength(2);
      expect(result.tasks[0].id).toBe(1);
      expect(result.tasks[0].title).toBe("First step");
      expect(result.tasks[1].id).toBe(2);
      expect(result.tasks[1].title).toBe("Second step");
    });

    it("parses #### Task N: Title (4-level heading)", () => {
      const plan = `# Plan

#### Task 1: Deep task

#### Task 2: Also deep`;

      const result = parsePlan(plan);
      expect(result.tasks).toHaveLength(2);
    });

    it("handles colons in titles correctly", () => {
      const plan = `# Plan

## Task 1: Auth: OAuth2 implementation

Build OAuth2 flow.`;

      const result = parsePlan(plan);
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].title).toBe("Auth: OAuth2 implementation");
    });
  });

  describe("description extraction", () => {
    it("extracts description between task headings", () => {
      const plan = `# Plan

## Task 1: Setup

First install dependencies.
Then configure the environment.

## Task 2: Build

Implement the feature.`;

      const result = parsePlan(plan);
      expect(result.tasks[0].description).toContain("First install dependencies");
      expect(result.tasks[0].description).toContain("Then configure the environment");
      expect(result.tasks[0].description).not.toContain("## Task 2");
      expect(result.tasks[1].description).toContain("Implement the feature");
    });

    it("preserves multi-paragraph descriptions", () => {
      const plan = `# Plan

## Task 1: Complex task

Paragraph one with details.

Paragraph two with more details.

- Bullet one
- Bullet two`;

      const result = parsePlan(plan);
      expect(result.tasks[0].description).toContain("Paragraph one");
      expect(result.tasks[0].description).toContain("Paragraph two");
    });
  });

  describe("edge cases", () => {
    it("returns single task for plan without task headings", () => {
      const plan = `# My Plan

Just do the one thing. It's all there is.`;

      const result = parsePlan(plan);
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].id).toBe(1);
      expect(result.tasks[0].title).toBe("My Plan");
      expect(result.tasks[0].description).toContain("Just do the one thing");
    });

    it("returns 'Untitled Plan' for plan without any heading", () => {
      const plan = "Just some content here.\n\nNo headings at all.";

      const result = parsePlan(plan);
      expect(result.title).toBe("Untitled Plan");
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].description).toContain("Just some content here");
    });

    it("handles empty plan gracefully", () => {
      const result = parsePlan("");
      expect(result.title).toBe("Untitled Plan");
      expect(result.tasks).toHaveLength(1);
    });

    it("handles whitespace-only plan", () => {
      const result = parsePlan("   \n\n  \n");
      expect(result.tasks).toHaveLength(1);
    });

    it("does NOT match text containing 'Task' in body as task heading", () => {
      const plan = `# Plan

## Task 1: Main thing

This is the main thing. Task 2 is not here yet.

It mentions "Task" in the body but only ## headings should match.`;

      const result = parsePlan(plan);
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].description).toContain("Task 2");
    });
  });

  describe("task numbering", () => {
    it("preserves original task numbers (not sequential renumbering)", () => {
      const plan = `# Plan

## Task 5: Late task

## Task 10: Even later`;

      const result = parsePlan(plan);
      expect(result.tasks).toHaveLength(2);
      expect(result.tasks[0].id).toBe(5);
      expect(result.tasks[1].id).toBe(10);
    });

    it("handles out-of-order numbering", () => {
      const plan = `# Plan

## Task 3: Third

## Task 1: First

## Task 2: Second`;

      const result = parsePlan(plan);
      expect(result.tasks).toHaveLength(3);
      expect(result.tasks[0].id).toBe(3);
      expect(result.tasks[1].id).toBe(1);
      expect(result.tasks[2].id).toBe(2);
    });
  });
});