import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  format: ["esm"],
  platform: "node",
  target: "node18",
  fixedExtension: true,
  dts: { build: true },
  clean: true,
  treeshake: true,
  minify: true,
  external: ["@opencode-ai/plugin", "@opencode-ai/sdk"],
  // 将 @agent-tracker/shared 打进包
  onlyBundle: [/^@agent-tracker\//],
});
