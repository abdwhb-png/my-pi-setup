import { describe, expect, it } from "bun:test";
import * as googleOauth from "./google-oauth.ts";

describe("google-oauth import guard", () => {
  it("exports at least one symbol", () => {
    expect(Object.keys(googleOauth).length).toBeGreaterThan(0);
  });
});
