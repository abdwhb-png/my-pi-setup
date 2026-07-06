import { describe, expect, it, afterEach } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { stat as fsStat } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { handleReadOnDirectory, handleLsOnFile } from "./path-redirect";

describe("handleReadOnDirectory", () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  async function makeDir(entries: string[]): Promise<string> {
    tmpDir = await mkdtemp(nodePath.join(tmpdir(), "path-redirect-test-"));
    for (const entry of entries) {
      const full = nodePath.join(tmpDir, entry);
      if (entry.includes(".")) {
        await writeFile(full, `content of ${entry}`);
      } else {
        const { mkdir } = await import("node:fs/promises");
        await mkdir(full, { recursive: true });
      }
    }
    return tmpDir;
  }

  it("returns clear header + sorted listing for directory with files", async () => {
    const dir = await makeDir(["b.txt", "a.ts", "c.md"]);
    const result = await handleReadOnDirectory(dir, async (p: string) => {
      const { readdir } = await import("node:fs/promises");
      return readdir(p);
    });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Path is a directory. Contents of");
    expect(text).toContain("a.ts");
    expect(text).toContain("b.txt");
    expect(text).toContain("c.md");
    // entries should be sorted
    const idxA = text.indexOf("a.ts");
    const idxB = text.indexOf("b.txt");
    const idxC = text.indexOf("c.md");
    expect(idxA).toBeLessThan(idxB);
    expect(idxB).toBeLessThan(idxC);
  });

  it("handles empty directory", async () => {
    tmpDir = await mkdtemp(nodePath.join(tmpdir(), "path-redirect-test-"));
    const result = await handleReadOnDirectory(tmpDir, async () => []);

    expect(result.content).toHaveLength(1);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Path is a directory. Contents of");
    expect(text).toContain("(empty directory)");
  });

  it("includes trailing / in path header", async () => {
    tmpDir = await mkdtemp(nodePath.join(tmpdir(), "path-redirect-test-"));
    const result = await handleReadOnDirectory(tmpDir, async () => []);

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain(`${tmpDir}/`);
  });

  it("returns undefined details", async () => {
    tmpDir = await mkdtemp(nodePath.join(tmpdir(), "path-redirect-test-"));
    const result = await handleReadOnDirectory(tmpDir, async () => []);
    expect(result.details).toBeUndefined();
  });
});

describe("handleLsOnFile", () => {
  let tmpDir: string;
  let filePath: string;

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  async function makeFile(content: string | Buffer, name = "test.txt"): Promise<string> {
    tmpDir = await mkdtemp(nodePath.join(tmpdir(), "path-redirect-test-"));
    filePath = nodePath.join(tmpDir, name);
    await writeFile(filePath, content);
    return filePath;
  }

  it("returns stat info + first 20 lines for text file", async () => {
    const lines = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`);
    const path = await makeFile(lines.join("\n"));
    const stat = await fsStat(path);

    const result = await handleLsOnFile(path, readFile, fsStat);

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Path is a file.");
    expect(text).toContain(`Size: ${stat.size} bytes`);
    expect(text).toContain("First 20 lines:");
    for (let i = 1; i <= 20; i++) {
      expect(text).toContain(`line ${i}`);
    }
    expect(text).not.toContain("line 21"); // only 20 lines
  });

  it("handles file with fewer than 20 lines", async () => {
    const path = await makeFile("one\ntwo\nthree");
    const result = await handleLsOnFile(path, readFile, fsStat);

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("one");
    expect(text).toContain("two");
    expect(text).toContain("three");
    expect(text).toContain("First 20 lines:");
  });

  it("handles empty file", async () => {
    const path = await makeFile("");
    const stat = await fsStat(path);

    const result = await handleLsOnFile(path, readFile, fsStat);

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Path is a file.");
    expect(text).toContain(`Size: ${stat.size} bytes`);
    expect(text).toContain("(empty file)");
  });

  it("detects binary file and skips content preview", async () => {
    const buf = Buffer.alloc(100, 0);
    buf.write("some text at start", 0);
    const path = await makeFile(buf, "binary.bin");
    const stat = await fsStat(path);

    const result = await handleLsOnFile(path, readFile, fsStat);

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Path is a file.");
    expect(text).toContain(`Size: ${stat.size} bytes`);
    expect(text).toContain("(binary file, preview skipped)");
    expect(text).not.toContain("First 20 lines:");
  });

  it("returns undefined details", async () => {
    const path = await makeFile("hello");
    const result = await handleLsOnFile(path, readFile, fsStat);
    expect(result.details).toBeUndefined();
  });

  it("includes modified time in output", async () => {
    const path = await makeFile("hello");
    const result = await handleLsOnFile(path, readFile, fsStat);

    const text = (result.content[0] as { text: string }).text;
    expect(text).toMatch(/Modified:/);
  });
});
