import { describe, expect, it } from "bun:test";
import { isHiddenSessionTitle } from "../src/hidden-session";

describe("isHiddenSessionTitle", () => {
  it("hides OpenCode SmartFetch secondary sessions", () => {
    expect(isHiddenSessionTitle("smartfetch-secondary")).toBe(true);
    expect(isHiddenSessionTitle("  smartfetch-secondary  ")).toBe(true);
  });

  it("keeps normal session titles", () => {
    expect(isHiddenSessionTitle("normal session")).toBe(false);
    expect(isHiddenSessionTitle("smartfetch")).toBe(false);
    expect(isHiddenSessionTitle("smartfetch-secondary-extra")).toBe(false);
    expect(isHiddenSessionTitle(null)).toBe(false);
    expect(isHiddenSessionTitle(undefined)).toBe(false);
    expect(isHiddenSessionTitle("")).toBe(false);
  });
});
