import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  expandUserPath,
  loadEnvFile,
  parseEnvFile,
  resolveEnvValue,
} from "../src/env-file";

describe("parseEnvFile", () => {
  it("parses export, quotes, and comments", () => {
    const parsed = parseEnvFile(`
# comment
export AGENT_TRACKER_ENDPOINT="http://example.com:3456"
apiKey='secret-key'
debug=true
`);
    expect(parsed).toEqual({
      AGENT_TRACKER_ENDPOINT: "http://example.com:3456",
      apiKey: "secret-key",
      debug: "true",
    });
  });
});

describe("expandUserPath", () => {
  it("expands ~ and $HOME prefixes", () => {
    const prevHome = process.env.HOME;
    process.env.HOME = "/Users/tester";
    try {
      expect(expandUserPath("~/.config/agent-tracker/plugin.log"))
        .toBe("/Users/tester/.config/agent-tracker/plugin.log");
      expect(expandUserPath("$HOME/.config/agent-tracker/plugin.log"))
        .toBe("/Users/tester/.config/agent-tracker/plugin.log");
      expect(expandUserPath("${HOME}/.config/agent-tracker/plugin.log"))
        .toBe("/Users/tester/.config/agent-tracker/plugin.log");
      expect(expandUserPath("/absolute/path.log")).toBe("/absolute/path.log");
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
    }
  });
});

describe("resolveEnvValue", () => {
  it("prefers process.env over file env", () => {
    const prev = process.env.AGENT_TRACKER_ENDPOINT;
    process.env.AGENT_TRACKER_ENDPOINT = "http://from-process";
    try {
      expect(resolveEnvValue({ AGENT_TRACKER_ENDPOINT: "http://from-file" }, "AGENT_TRACKER_ENDPOINT"))
        .toBe("http://from-process");
    } finally {
      if (prev === undefined) delete process.env.AGENT_TRACKER_ENDPOINT;
      else process.env.AGENT_TRACKER_ENDPOINT = prev;
    }
  });

  it("falls back to file aliases", () => {
    const prevEndpoint = process.env.AGENT_TRACKER_ENDPOINT;
    const prevApiKey = process.env.AGENT_TRACKER_API_KEY;
    delete process.env.AGENT_TRACKER_ENDPOINT;
    delete process.env.AGENT_TRACKER_API_KEY;
    try {
      expect(resolveEnvValue({ endpoint: "http://from-file" }, "AGENT_TRACKER_ENDPOINT", "endpoint"))
        .toBe("http://from-file");
      expect(resolveEnvValue({ apiKey: "k" }, "AGENT_TRACKER_API_KEY", "apiKey", "api_key"))
        .toBe("k");
    } finally {
      if (prevEndpoint === undefined) delete process.env.AGENT_TRACKER_ENDPOINT;
      else process.env.AGENT_TRACKER_ENDPOINT = prevEndpoint;
      if (prevApiKey === undefined) delete process.env.AGENT_TRACKER_API_KEY;
      else process.env.AGENT_TRACKER_API_KEY = prevApiKey;
    }
  });
});

describe("loadEnvFile", () => {
  it("loads from a custom path", () => {
    const dir = mkdtempSync(join(tmpdir(), "at-env-"));
    const path = join(dir, "env");
    writeFileSync(path, 'endpoint="http://custom:3456"\napiKey=abc\n');
    expect(loadEnvFile(path)).toEqual({
      endpoint: "http://custom:3456",
      apiKey: "abc",
    });
  });

  it("returns empty object when file is missing", () => {
    expect(loadEnvFile("/tmp/agent-tracker-missing-env-file")).toEqual({});
  });
});
