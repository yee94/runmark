import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPluginConfig } from "../src/config.ts";

test("reporting uses options.endpoint and apiKey before environment config, with env fallback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runmark-options-"));
  const file = join(directory, "env");
  const keys = ["RUNMARK_ENDPOINT", "RUNMARK_API_KEY", "AGENT_TRACKER_ENDPOINT", "AGENT_TRACKER_API_KEY"];
  const previous = keys.map(key => process.env[key]);
  try {
    await writeFile(file, "endpoint=https://file.example\napiKey=file-key\n");
    process.env.RUNMARK_ENDPOINT = "https://process.example";
    process.env.RUNMARK_API_KEY = "process-key";
    expect(loadPluginConfig(file, { endpoint: " https://options.example/proxy ", apiKey: "options-key" }))
      .toMatchObject({ endpoint: "https://options.example/proxy", apiKey: "options-key" });
    expect(loadPluginConfig(file, { endpoint: "", apiKey: 123 }))
      .toMatchObject({ endpoint: "https://process.example", apiKey: "process-key" });
    expect(loadPluginConfig(file, { memoryEnabled: true })).toMatchObject({
      endpoint: "https://process.example", apiKey: "process-key", memoryEnabled: true,
    });
    keys.forEach(key => { delete process.env[key]; });
    expect(loadPluginConfig(file)).toMatchObject({ endpoint: "https://file.example", apiKey: "file-key" });
    expect(loadPluginConfig(join(directory, "missing")))
      .toMatchObject({ endpoint: "http://localhost:3456", apiKey: "dev-key-change-me" });
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
    await rm(directory, { recursive: true, force: true });
  }
});
