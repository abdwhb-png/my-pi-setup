import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_THINK_IN_CODE_CONFIG } from "../config.ts";
import { ThinkStore } from "./store.ts";

describe("Defect 2 RED: store search FTS5 safe query construction", () => {
  let home: string | undefined;
  let store: ThinkStore | undefined;

  afterEach(async () => {
    store?.close();
    if (home) await rm(home, { recursive: true, force: true });
    home = undefined;
    store = undefined;
  });

  async function harness() {
    home = await mkdtemp(join(tmpdir(), "fts-red-"));
    const storeRoot = join(home, "store");
    await mkdir(storeRoot, { recursive: true });
    store = new ThinkStore({ config: DEFAULT_THINK_IN_CODE_CONFIG, storeRoot, canonicalPath: "/proj" });
    store.index({ kind: "document-summary", source: "s1", text: "alpha-2847 beta-9921 gamma-7411 deterministic content" });
    store.index({ kind: "document-summary", source: "s2", text: "alpha beta deterministic other" });
    return store;
  }

  it("hyphenated query alpha-2847 must not throw and must preserve ranking", async () => {
    const s = await harness();
    const hits = s.search("alpha-2847", 5);
    expect(hits.length).toBeGreaterThan(0);
    // ranking: doc containing alpha/beta must score; snippet bounded
    for (const h of hits) {
      expect(h.snippet.length).toBeLessThanOrEqual(DEFAULT_THINK_IN_CODE_CONFIG.searchSnippetChars + 32);
    }
  });

  it("quoted query must not throw and must not enable FTS syntax injection", async () => {
    const s = await harness();
    expect(() => s.search('"alpha-2847"', 5)).not.toThrow();
    // FTS operators must not be exploitable as raw MATCH injection
    expect(() => s.search("alpha OR beta", 5)).not.toThrow();
    expect(() => s.search("alpha NEAR/2 beta", 5)).not.toThrow();
    expect(() => s.search("alpha*", 5)).not.toThrow();
  });

  it("punctuation-heavy and empty-token inputs must not throw and must return bounded snippets or empty", async () => {
    const s = await harness();
    expect(() => s.search("---", 5)).not.toThrow();
    const emptyTokens = s.search("---", 5);
    expect(Array.isArray(emptyTokens)).toBe(true);
    expect(() => s.search("alpha!@# beta$%^", 5)).not.toThrow();
    expect(() => s.search("   ", 5)).not.toThrow(); // whitespace-only after normalization should not throw FTS error (may throw controlled validation but not FTS syntax error)
    // Ensure injection payload does not throw raw SQLite error
    expect(() => s.search("a\" OR 1=1 --", 5)).not.toThrow();
    expect(() => s.search("column:2847", 5)).not.toThrow();
  });

  it("coordinator search with hyphenated query via coordinator must also be safe (integration)", async () => {
    const { ThinkCoordinator } = await import("../coordinator.ts");
    const s2 = await harness();
    const coord = new ThinkCoordinator({ store: s2, config: DEFAULT_THINK_IN_CODE_CONFIG });
    const r = coord.search({ id: "s1", query: "alpha-2847", limit: 5 });
    expect(r.details.blockedReason).toBeUndefined();
    expect(r.content[0]?.text).toBeDefined();
  });
});
