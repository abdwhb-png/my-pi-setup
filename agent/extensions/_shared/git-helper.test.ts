import { describe, expect, it } from "bun:test";
import * as gitHelper from "./git-helper.ts";

describe("git-helper import guard", () => {
  it("exports at least one symbol", () => {
    expect(Object.keys(gitHelper).length).toBeGreaterThan(0);
  });
});
