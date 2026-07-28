import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrainstormArtifactStore } from "./artifacts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("brainstorm artifact store", () => {
  it("creates the first immutable phase revision and manifest", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "brainstorm-artifacts-"));
    temporaryDirectories.push(projectRoot);
    const store = createBrainstormArtifactStore({
      projectRoot,
      runId: "brainstorm-123",
      topic: "Safer phase workflow",
      now: () => "2026-07-24T12:00:00.000Z",
    });

    const result = store.submit({
      phase: "discovery",
      markdown: "# Discovery\n\nVerified facts.",
      tool: "brainstorm_submit_discovery",
    });

    expect(result).toMatchObject({
      revision: 1,
      path: "docs/brainstorms/2026-07-24-safer-phase-workflow/01-discovery-r001.md",
    });
    expect(await readFile(join(projectRoot, result.path), "utf8")).toBe("# Discovery\n\nVerified facts.\n");

    const manifest = JSON.parse(await readFile(join(projectRoot, result.manifestPath), "utf8"));
    expect(manifest).toMatchObject({
      version: 1,
      runId: "brainstorm-123",
      topic: "Safer phase workflow",
      activeRevisions: { discovery: 1 },
      revisions: [{ phase: "discovery", revision: 1, status: "active", path: result.path }],
    });
  });

  it("reads a submitted artifact through its verified run scope", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "brainstorm-artifacts-"));
    temporaryDirectories.push(projectRoot);
    const store = createBrainstormArtifactStore({
      projectRoot,
      runId: "brainstorm-review",
      topic: "Review inside Pi",
      now: () => "2026-07-24T12:00:00.000Z",
    });
    const result = store.submit({
      phase: "discovery",
      markdown: "# Discovery\n\nVisible in Pi.",
      tool: "brainstorm_submit_discovery",
    });

    expect(store.read(result.path)).toBe("# Discovery\n\nVisible in Pi.\n");
  });

  it("refuses artifact content changed outside the store", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "brainstorm-artifacts-"));
    temporaryDirectories.push(projectRoot);
    const store = createBrainstormArtifactStore({
      projectRoot,
      runId: "brainstorm-tampered",
      topic: "Tamper detection",
      now: () => "2026-07-24T12:00:00.000Z",
    });
    const result = store.submit({
      phase: "discovery",
      markdown: "trusted",
      tool: "brainstorm_submit_discovery",
    });
    await writeFile(join(projectRoot, result.path), "tampered\n");

    expect(() => store.read(result.path)).toThrow("checksum mismatch");
  });

  it("keeps immutable revisions and marks downstream artifacts stale", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "brainstorm-artifacts-"));
    temporaryDirectories.push(projectRoot);
    const store = createBrainstormArtifactStore({
      projectRoot,
      runId: "brainstorm-456",
      topic: "Revision history",
      now: () => "2026-07-24T12:00:00.000Z",
    });

    store.submit({ phase: "discovery", markdown: "first discovery", tool: "brainstorm_submit_discovery" });
    store.submit({ phase: "understanding", markdown: "requirements", tool: "brainstorm_submit_understanding" });
    const revised = store.submit({ phase: "discovery", markdown: "revised discovery", tool: "brainstorm_submit_discovery" });

    expect(revised.revision).toBe(2);
    expect(await readFile(join(projectRoot, "docs/brainstorms/2026-07-24-revision-history/01-discovery-r001.md"), "utf8")).toBe("first discovery\n");
    expect(store.getManifest().revisions).toMatchObject([
      { phase: "discovery", revision: 1, status: "stale" },
      { phase: "understanding", revision: 1, status: "stale" },
      { phase: "discovery", revision: 2, status: "active" },
    ]);
    expect(store.getManifest().activeRevisions).toEqual({ discovery: 2 });
  });

  it("keeps the original run date when a resumed session writes later", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "brainstorm-artifacts-"));
    temporaryDirectories.push(projectRoot);
    const store = createBrainstormArtifactStore({
      projectRoot,
      runId: "brainstorm-resumed",
      topic: "Long brainstorm",
      date: "2026-07-24",
      now: () => "2026-07-25T01:00:00.000Z",
    });

    const result = store.submit({ phase: "discovery", markdown: "resumed", tool: "brainstorm_submit_discovery" });
    expect(result.path).toStartWith("docs/brainstorms/2026-07-24-long-brainstorm/");
  });

  it("uses a distinct durable root when the same topic runs twice on one day", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "brainstorm-artifacts-"));
    temporaryDirectories.push(projectRoot);
    const options = { projectRoot, topic: "Same topic", now: () => "2026-07-24T12:00:00.000Z" };
    const first = createBrainstormArtifactStore({ ...options, runId: "brainstorm-first" });
    first.submit({ phase: "discovery", markdown: "first", tool: "brainstorm_submit_discovery" });

    const second = createBrainstormArtifactStore({ ...options, runId: "brainstorm-second" });
    const result = second.submit({ phase: "discovery", markdown: "second", tool: "brainstorm_submit_discovery" });

    expect(result.path).not.toBe(first.getManifest().revisions[0]!.path);
    expect(second.getManifest().root).toContain("same-topic-brainstorm-second");
  });
});
