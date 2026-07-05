import { describe, it, expect, mock } from "bun:test";

// Mock pi-tui modules before importing the module under test
mock.module("@earendil-works/pi-tui", () => ({
  fuzzyFilter: <T>(items: T[], query: string, getText: (item: T) => string): T[] => {
    if (!query) return items;
    return items.filter((item) => getText(item).toLowerCase().includes(query.toLowerCase()));
  },
  fuzzyMatch: () => ({ matches: true, score: 0 }),
}));

const {
  parseAtValue,
  rebuildAtValue,
  findUnresolvedAtRefs,
  transformAtValue,
  getSearchRoots,
} = await import("./pi-file-resolver.ts");

describe("parseAtValue", () => {
  it("parses simple relative path", () => {
    const result = parseAtValue("@path/to/file");
    expect(result).toEqual({ path: "path/to/file", isQuoted: false, isDirectory: false });
  });

  it("parses quoted path with spaces", () => {
    const result = parseAtValue('@"/path with spaces/file.md"');
    expect(result).toEqual({ path: "/path with spaces/file.md", isQuoted: true, isDirectory: false });
  });

  it("parses absolute path", () => {
    const result = parseAtValue("@/absolute/path");
    expect(result).toEqual({ path: "/absolute/path", isQuoted: false, isDirectory: false });
  });

  it("parses directory path", () => {
    const result = parseAtValue("@relative/path/");
    expect(result).toEqual({ path: "relative/path/", isQuoted: false, isDirectory: true });
  });

  it("parses bare filename", () => {
    const result = parseAtValue("@file.md");
    expect(result).toEqual({ path: "file.md", isQuoted: false, isDirectory: false });
  });

  it("parses path without @ prefix", () => {
    const result = parseAtValue("relative/path");
    expect(result).toEqual({ path: "relative/path", isQuoted: false, isDirectory: false });
  });
});

describe("rebuildAtValue", () => {
  it("rebuilds simple relative path", () => {
    const result = rebuildAtValue("/home/user/file.md", {
      path: "file.md",
      isQuoted: false,
      isDirectory: false,
    });
    expect(result).toBe("@/home/user/file.md");
  });

  it("rebuilds quoted path", () => {
    const result = rebuildAtValue("/home/user/path with spaces/file.md", {
      path: "path with spaces/file.md",
      isQuoted: true,
      isDirectory: false,
    });
    expect(result).toBe('@"/home/user/path with spaces/file.md"');
  });

  it("rebuilds directory path", () => {
    const result = rebuildAtValue("/home/user/dir/", {
      path: "dir/",
      isQuoted: false,
      isDirectory: true,
    });
    expect(result).toBe("@/home/user/dir/");
  });

  it("preserves absolute passthrough", () => {
    const result = rebuildAtValue("/already/absolute", {
      path: "/already/absolute",
      isQuoted: false,
      isDirectory: false,
    });
    expect(result).toBe("@/already/absolute");
  });

  it("rebuilds bare filename", () => {
    const result = rebuildAtValue("/home/user/file.md", {
      path: "file.md",
      isQuoted: false,
      isDirectory: false,
    });
    expect(result).toBe("@/home/user/file.md");
  });
});

describe("findUnresolvedAtRefs", () => {
  it("finds bare @filename in text", () => {
    const refs = findUnresolvedAtRefs("check @plan-file.md for details");
    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual({ raw: "@plan-file.md", name: "plan-file.md" });
  });

  it("skips already absolute paths", () => {
    const refs = findUnresolvedAtRefs("read @/home/user/file.md");
    expect(refs).toHaveLength(0);
  });

  it("skips scoped paths (with /)", () => {
    const refs = findUnresolvedAtRefs("check @path/to/file.md");
    expect(refs).toHaveLength(0);
  });

  it("skips ~/ paths", () => {
    const refs = findUnresolvedAtRefs("look at @~/file.md");
    expect(refs).toHaveLength(0);
  });

  it("finds multiple bare refs", () => {
    const refs = findUnresolvedAtRefs("@a.md and @b.txt and ignore @/abs/path and @c.ts");
    expect(refs).toHaveLength(3);
    expect(refs.map((r) => r.name)).toEqual(["a.md", "b.txt", "c.ts"]);
  });

  it("returns empty for text with no @ refs", () => {
    const refs = findUnresolvedAtRefs("just some text without refs");
    expect(refs).toHaveLength(0);
  });

  it("does not match @ mid-word", () => {
    const refs = findUnresolvedAtRefs("email@example.com");
    expect(refs).toHaveLength(0);
  });
});

describe("transformAtValue", () => {
  it("transforms relative @value to absolute", () => {
    const result = transformAtValue("@relative/file.md", "/home/user");
    expect(result).toBe("@/home/user/relative/file.md");
  });

  it("leaves absolute @value unchanged", () => {
    const result = transformAtValue("@/already/absolute", "/home/user");
    expect(result).toBe("@/already/absolute");
  });

  it("handles @value without @ prefix", () => {
    const result = transformAtValue("relative/file.md", "/home/user");
    expect(result).toBe("@/home/user/relative/file.md");
  });

  it("handles bare filename", () => {
    const result = transformAtValue("@file.md", "/home/user");
    expect(result).toBe("@/home/user/file.md");
  });

  it("handles quoted path with spaces", () => {
    const result = transformAtValue('@"path with spaces/file.md"', "/home/user");
    expect(result).toBe('@"/home/user/path with spaces/file.md"');
  });

  it("handles directory path", () => {
    const result = transformAtValue("@dir/", "/home/user");
    expect(result).toBe("@/home/user/dir/");
  });

  it("handles ~/ prefixed paths", () => {
    const result = transformAtValue("@~/file.md", "/home/user");
    expect(result).toBe("@~/file.md");
  });
});

describe("getSearchRoots", () => {
  it("returns all configured roots", () => {
    const roots = getSearchRoots("/current/project");
    expect(roots).toContain("/current/project");
    expect(roots).toContain("/home/abdwhb/.pi/agent");
    expect(roots).toContain("/home/abdwhb/.pi/agent/extensions");
    expect(roots).toContain("/home/abdwhb/.pi/pi-prompts");
    expect(roots).toContain("/home/abdwhb/.pi/docs");
  });

  it("deduplicates roots", () => {
    const roots = getSearchRoots("/home/abdwhb/.pi/agent/");
    const unique = new Set(roots);
    expect(roots.length).toBe(unique.size);
  });
});

describe("parseAtValue -> rebuildAtValue round-trip", () => {
  const cases = [
    "@simple-file.md",
    "@/absolute/path/file.ts",
    '@"path with spaces/file.md"',
    "@relative/dir/",
    "@file-in-cwd.ts",
  ];

  for (const input of cases) {
    it(`round-trips ${input}`, () => {
      const parsed = parseAtValue(input);
      const rebuilt = rebuildAtValue(parsed.path, parsed);
      expect(rebuilt).toBe(input);
    });
  }
});
