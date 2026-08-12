import { describe, expect, it } from "bun:test";
import { shouldSkipTool } from "../src/skip-tools";

describe("shouldSkipTool", () => {
  it("skips Cursor / Claude noisy tools case-insensitively", () => {
    expect(shouldSkipTool("Read")).toBe(true);
    expect(shouldSkipTool("write")).toBe(true);
    expect(shouldSkipTool("Shell")).toBe(true);
    expect(shouldSkipTool("Bash")).toBe(true);
    expect(shouldSkipTool("GREP")).toBe(true);
    expect(shouldSkipTool("Glob")).toBe(true);
  });

  it("skips CodeBuddy / WorkBuddy IDE aliases including list_dir", () => {
    expect(shouldSkipTool("read_file")).toBe(true);
    expect(shouldSkipTool("write_file")).toBe(true);
    expect(shouldSkipTool("execute_command")).toBe(true);
    expect(shouldSkipTool("search_content")).toBe(true);
    expect(shouldSkipTool("list_dir")).toBe(true);
    expect(shouldSkipTool("list_files")).toBe(true);
    expect(shouldSkipTool("glob_file_search")).toBe(true);
  });

  it("keeps non-noisy tools", () => {
    expect(shouldSkipTool("WebFetch")).toBe(false);
    expect(shouldSkipTool("mcp__foo")).toBe(false);
    expect(shouldSkipTool("Edit")).toBe(false);
    expect(shouldSkipTool("Task")).toBe(false);
  });
});
