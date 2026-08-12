import { describe, expect, it } from "bun:test";
import { shouldSkipTool } from "../src/constants";

describe("shouldSkipTool (re-export from shared)", () => {
  it("skips Cursor-aligned noisy tools including Glob", () => {
    expect(shouldSkipTool("Read")).toBe(true);
    expect(shouldSkipTool("Bash")).toBe(true);
    expect(shouldSkipTool("Glob")).toBe(true);
    expect(shouldSkipTool("list_dir")).toBe(true);
  });

  it("keeps non-noisy tools", () => {
    expect(shouldSkipTool("WebFetch")).toBe(false);
    expect(shouldSkipTool("mcp__foo")).toBe(false);
    expect(shouldSkipTool("Edit")).toBe(false);
  });
});
