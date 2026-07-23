import { describe, expect, it } from "bun:test";
import { Type } from "@sinclair/typebox";
import { parseSddPlan } from "./plan-parser.ts";
import { parseStrictJson } from "./schemas.ts";
import { PROFILES } from "./types.ts";

describe("profiles", () => {
  it("orders the supported execution profiles", () => {
    expect(PROFILES).toEqual(["direct", "light", "standard", "critical"]);
  });
});

describe("parseSddPlan", () => {
  it("parses optional qa and browser metadata", () => {
    const plan = [
      "# Feature",
      "",
      "### Task 1: Add parser",
      "",
      "~~~sdd-task",
      JSON.stringify({
        id: "task-1",
        dependsOn: [],
        files: ["src/parser.ts", "src/parser.test.ts"],
        verify: [{ id: "parser", command: "bun test src/parser.test.ts" }],
        qa: [{ id: "a11y", command: "bun run test:a11y parser" }],
        browser: [
          {
            id: "parser-flow",
            baseUrl: "http://localhost:4173",
            preconditions: ["Parser UI loads"],
            steps: ["Open parser page", "Run checks", "Submit form"],
            expected: ["Checks complete"],
          },
        ],
      }),
      "~~~",
      "",
      "Implement with TDD.",
    ].join("\n");

    expect(parseSddPlan(plan).tasks[0]).toEqual({
      id: "task-1",
      ordinal: 1,
      title: "Add parser",
      body: "Implement with TDD.",
      dependsOn: [],
      files: ["src/parser.ts", "src/parser.test.ts"],
      verify: [{ id: "parser", command: "bun test src/parser.test.ts" }],
      qa: [{ id: "a11y", command: "bun run test:a11y parser" }],
      browser: [
        {
          id: "parser-flow",
          baseUrl: "http://localhost:4173",
          preconditions: ["Parser UI loads"],
          steps: ["Open parser page", "Run checks", "Submit form"],
          expected: ["Checks complete"],
        },
      ],
    });
  });

  it("compiles an exact task heading and sdd-task metadata", () => {
    const plan = [
      "# Feature",
      "",
      "### Task 1: Add parser",
      "",
      "~~~sdd-task",
      JSON.stringify({
        id: "task-1",
        dependsOn: [],
        files: ["src/parser.ts", "src/parser.test.ts"],
        verify: [{ id: "parser", command: "bun test src/parser.test.ts" }],
      }),
      "~~~",
      "",
      "Implement with TDD.",
    ].join("\n");

    expect(parseSddPlan(plan).tasks[0]).toEqual({
      id: "task-1",
      ordinal: 1,
      title: "Add parser",
      body: "Implement with TDD.",
      dependsOn: [],
      files: ["src/parser.ts", "src/parser.test.ts"],
      verify: [{ id: "parser", command: "bun test src/parser.test.ts" }],
    });
  });

  it("canonicalizes relative file aliases before parallelism analysis", () => {
    const plan = [
      "# Feature",
      "### Task 1: Normalize files",
      "~~~sdd-task",
      JSON.stringify({
        id: "task-1",
        dependsOn: [],
        files: ["./src/a.ts", "src/../src/a.ts"],
        verify: [{ id: "test", command: "bun test" }],
      }),
      "~~~",
    ].join("\n");

    expect(parseSddPlan(plan).tasks[0]?.files).toEqual(["src/a.ts"]);
  });

  it("rejects absolute file paths and paths escaping the project root", () => {
    for (const file of ["/tmp/a.ts", "../outside.ts", "C:\\outside.ts"]) {
      const plan = [
        "# Feature",
        "### Task 1: Invalid file",
        "~~~sdd-task",
        JSON.stringify({
          id: "task-1",
          dependsOn: [],
          files: [file],
          verify: [{ id: "test", command: "bun test" }],
        }),
        "~~~",
      ].join("\n");

      expect(() => parseSddPlan(plan)).toThrow("must stay within the project root");
    }
  });

  it("rejects a plan without a level-one title", () => {
    expect(() =>
      parseSddPlan([
        "### Task 1: Add parser",
        "~~~sdd-task",
        '{"id":"task-1","dependsOn":[],"files":["src/parser.ts"],"verify":[{"id":"test","command":"bun test"}]}',
        "~~~",
      ].join("\n")),
    ).toThrow("SDD plan requires one level-one title.");
  });

  it("rejects a split-line level-one title", () => {
    const plan = [
      "#",
      "Feature",
      "### Task 1: Add parser",
      "~~~sdd-task",
      '{"id":"task-1","dependsOn":[],"files":["src/parser.ts"],"verify":[{"id":"test","command":"bun test"}]}',
      "~~~",
    ].join("\n");

    expect(() => parseSddPlan(plan)).toThrow("SDD plan requires one level-one title.");
  });

  it("rejects duplicate level-one titles", () => {
    const plan = [
      "# Feature",
      "# Duplicate",
      "### Task 1: Add parser",
      "~~~sdd-task",
      '{"id":"task-1","dependsOn":[],"files":["src/parser.ts"],"verify":[{"id":"test","command":"bun test"}]}',
      "~~~",
    ].join("\n");

    expect(() => parseSddPlan(plan)).toThrow("SDD plan requires one level-one title.");
  });

  it("rejects loose legacy task headings", () => {
    const plan = ["# Legacy", "", "## Task 1: Loose heading", "", "Do the work."].join(
      "\n",
    );

    expect(() => parseSddPlan(plan)).toThrow(
      "SDD plan requires at least one exact ### Task N: Title heading.",
    );
  });

  it("rejects a split-line task heading", () => {
    const plan = [
      "# Feature",
      "### Task 1:",
      "Add parser",
      "~~~sdd-task",
      '{"id":"task-1","dependsOn":[],"files":["src/parser.ts"],"verify":[{"id":"test","command":"bun test"}]}',
      "~~~",
    ].join("\n");

    expect(() => parseSddPlan(plan)).toThrow(
      "SDD plan requires at least one exact ### Task N: Title heading.",
    );
  });

  it("rejects a task without metadata", () => {
    expect(() => parseSddPlan("# Feature\n\n### Task 1: Missing metadata\n\nDo the work.")).toThrow(
      "Task 1 must start with exactly one ~~~sdd-task JSON block.",
    );
  });

  it("rejects a task with more than one metadata block", () => {
    const metadata =
      '{"id":"task-1","dependsOn":[],"files":["src/parser.ts"],"verify":[{"id":"test","command":"bun test"}]}';
    const plan = [
      "# Feature",
      "",
      "### Task 1: Duplicate metadata",
      "",
      "~~~sdd-task",
      metadata,
      "~~~",
      "",
      "~~~sdd-task",
      metadata,
      "~~~",
    ].join("\n");

    expect(() => parseSddPlan(plan)).toThrow(
      "Task 1 must start with exactly one ~~~sdd-task JSON block.",
    );
  });

  it("rejects duplicate or skipped task ordinals", () => {
    const task = (ordinal: number) => [
      `### Task ${ordinal}: Task ${ordinal}`,
      "~~~sdd-task",
      JSON.stringify({
        id: `task-${ordinal}`,
        dependsOn: [],
        files: [`src/task-${ordinal}.ts`],
        verify: [{ id: "test", command: "bun test" }],
      }),
      "~~~",
    ];

    for (const ordinals of [
      [1, 1],
      [1, 3],
    ]) {
      const plan = ["# Feature", "", ...ordinals.flatMap(task)].join("\n");
      expect(() => parseSddPlan(plan)).toThrow(
        "Task headings must be contiguous and ordered from 1.",
      );
    }
  });

  it("rejects metadata whose id does not match its task ordinal", () => {
    const plan = [
      "# Feature",
      "### Task 1: Mismatched id",
      "~~~sdd-task",
      '{"id":"task-2","dependsOn":[],"files":["src/parser.ts"],"verify":[{"id":"test","command":"bun test"}]}',
      "~~~",
    ].join("\n");

    expect(() => parseSddPlan(plan)).toThrow("Task 1 metadata id must be task-1.");
  });

  it("rejects invalid metadata JSON", () => {
    const plan = [
      "# Feature",
      "### Task 1: Invalid JSON",
      "~~~sdd-task",
      '{"id":"task-1",}',
      "~~~",
    ].join("\n");

    expect(() => parseSddPlan(plan)).toThrow("Task 1 metadata is invalid JSON.");
  });

  it("rejects empty task files", () => {
    const plan = [
      "# Feature",
      "### Task 1: No files",
      "~~~sdd-task",
      '{"id":"task-1","dependsOn":[],"files":[],"verify":[{"id":"test","command":"bun test"}]}',
      "~~~",
    ].join("\n");

    expect(() => parseSddPlan(plan)).toThrow("Task 1 metadata is invalid:");
  });

  it("rejects empty verification ids or commands", () => {
    for (const verify of [
      { id: "", command: "bun test" },
      { id: "test", command: "" },
    ]) {
      const plan = [
        "# Feature",
        "### Task 1: Invalid verification",
        "~~~sdd-task",
        JSON.stringify({
          id: "task-1",
          dependsOn: [],
          files: ["src/parser.ts"],
          verify: [verify],
        }),
        "~~~",
      ].join("\n");

      expect(() => parseSddPlan(plan)).toThrow("Task 1 metadata is invalid:");
    }
  });

  it("rejects unknown task dependencies", () => {
    const plan = [
      "# Feature",
      "### Task 1: Unknown dependency",
      "~~~sdd-task",
      '{"id":"task-1","dependsOn":["task-2"],"files":["src/parser.ts"],"verify":[{"id":"test","command":"bun test"}]}',
      "~~~",
    ].join("\n");

    expect(() => parseSddPlan(plan)).toThrow("task-1 depends on unknown task task-2.");
  });

  it("rejects self-dependencies", () => {
    const plan = [
      "# Feature",
      "### Task 1: Self dependency",
      "~~~sdd-task",
      '{"id":"task-1","dependsOn":["task-1"],"files":["src/parser.ts"],"verify":[{"id":"test","command":"bun test"}]}',
      "~~~",
    ].join("\n");

    expect(() => parseSddPlan(plan)).toThrow("task-1 cannot depend on itself.");
  });

  it("rejects extra metadata properties", () => {
    const plan = [
      "# Feature",
      "### Task 1: Extra metadata",
      "~~~sdd-task",
      '{"id":"task-1","dependsOn":[],"files":["src/parser.ts"],"verify":[{"id":"test","command":"bun test"}],"extra":true}',
      "~~~",
    ].join("\n");

      expect(() => parseSddPlan(plan)).toThrow("Task 1 metadata is invalid:");
  });

  it("rejects duplicate qa ids", () => {
    const plan = [
      "# Feature",
      "### Task 1: Duplicate qa ids",
      "~~~sdd-task",
      JSON.stringify({
        id: "task-1",
        dependsOn: [],
        files: ["src/parser.ts"],
        verify: [{ id: "test", command: "bun test" }],
        qa: [
          { id: "a11y", command: "bun run test:a11y parser" },
          { id: "a11y", command: "bun run test:a11y ui" },
        ],
      }),
      "~~~",
    ].join("\n");

    expect(() => parseSddPlan(plan)).toThrow("Task 1 metadata is invalid:");
  });

  it("rejects duplicate browser scenario ids", () => {
    const plan = [
      "# Feature",
      "### Task 1: Duplicate browser ids",
      "~~~sdd-task",
      JSON.stringify({
        id: "task-1",
        dependsOn: [],
        files: ["src/parser.ts"],
        verify: [{ id: "test", command: "bun test" }],
        browser: [
          {
            id: "flow",
            baseUrl: "http://localhost:4173",
            preconditions: ["Parser UI loads"],
            steps: ["Open page"],
            expected: ["Parser loads"],
          },
          {
            id: "flow",
            baseUrl: "http://localhost:4173",
            preconditions: ["Parser UI loads"],
            steps: ["Open page"],
            expected: ["Parser loads"],
          },
        ],
      }),
      "~~~",
    ].join("\n");

    expect(() => parseSddPlan(plan)).toThrow("Task 1 metadata is invalid:");
  });

  it("rejects empty browser step and expected values", () => {
    for (const browser of [
      {
        id: "missing-steps",
        baseUrl: "http://localhost:4173",
        preconditions: ["Parser UI loads"],
        steps: [],
        expected: ["Parser loads"],
      },
      {
        id: "missing-expected",
        baseUrl: "http://localhost:4173",
        preconditions: ["Parser UI loads"],
        steps: ["Open page"],
        expected: [],
      },
    ]) {
      const plan = [
        "# Feature",
        "### Task 1: Empty browser checks",
        "~~~sdd-task",
        JSON.stringify({
          id: "task-1",
          dependsOn: [],
          files: ["src/parser.ts"],
          verify: [{ id: "test", command: "bun test" }],
          browser: [browser],
        }),
        "~~~",
      ].join("\n");

      expect(() => parseSddPlan(plan)).toThrow("Task 1 metadata is invalid:");
    }
  });

  it("rejects unknown qa fields", () => {
    const plan = [
      "# Feature",
      "### Task 1: Unknown qa field",
      "~~~sdd-task",
      JSON.stringify({
        id: "task-1",
        dependsOn: [],
        files: ["src/parser.ts"],
        verify: [{ id: "test", command: "bun test" }],
        qa: [{ id: "a11y", command: "bun run test:a11y parser", timeout: 5000 }],
      }),
      "~~~",
    ].join("\n");

    expect(() => parseSddPlan(plan)).toThrow("Task 1 metadata is invalid:");
  });

  it("rejects unknown browser fields", () => {
    const plan = [
      "# Feature",
      "### Task 1: Unknown browser field",
      "~~~sdd-task",
      JSON.stringify({
        id: "task-1",
        dependsOn: [],
        files: ["src/parser.ts"],
        verify: [{ id: "test", command: "bun test" }],
        browser: [
          {
            id: "parser-flow",
            baseUrl: "http://localhost:4173",
            preconditions: ["Parser UI loads"],
            steps: ["Open page"],
            expected: ["Parser loads"],
            extra: true,
          },
        ],
      }),
      "~~~",
    ].join("\n");

    expect(() => parseSddPlan(plan)).toThrow("Task 1 metadata is invalid:");
  });

  it("rejects blank and overlong validation metadata text", () => {
    const blank = [
      "# Feature",
      "### Task 1: Blank validation text",
      "~~~sdd-task",
      JSON.stringify({
        id: "task-1",
        dependsOn: [],
        files: ["src/parser.ts"],
        verify: [{ id: "test", command: "bun test" }],
        qa: [{ id: "   ", command: "bun test" }],
      }),
      "~~~",
    ].join("\n");
    const overlong = [
      "# Feature",
      "### Task 1: Overlong browser text",
      "~~~sdd-task",
      JSON.stringify({
        id: "task-1",
        dependsOn: [],
        files: ["src/parser.ts"],
        verify: [{ id: "test", command: "bun test" }],
        browser: [{
          id: "flow",
          baseUrl: "http://localhost:4173",
          preconditions: ["Ready"],
          steps: ["x".repeat(4097)],
          expected: ["Complete"],
        }],
      }),
      "~~~",
    ].join("\n");

    expect(() => parseSddPlan(blank)).toThrow("Task 1 metadata is invalid:");
    expect(() => parseSddPlan(overlong)).toThrow(
      "Task 1 metadata is invalid:",
    );
  });
});

describe("parseStrictJson", () => {
  const schema = Type.Object({ ok: Type.Boolean() }, { additionalProperties: false });

  it("parses a raw JSON object", () => {
    expect(parseStrictJson('{"ok":true}', schema)).toEqual({ ok: true });
  });

  it("parses exactly one complete fenced JSON object", () => {
    expect(parseStrictJson('~~~json\n{"ok":true}\n~~~', schema)).toEqual({ ok: true });
  });

  it("rejects prose surrounding JSON", () => {
    expect(() => parseStrictJson('Result:\n{"ok":true}', schema)).toThrow();
  });

  it("rejects a schema mismatch", () => {
    expect(() => parseStrictJson('{"ok":"yes"}', schema)).toThrow(
      "Structured output is invalid:",
    );
  });
});
