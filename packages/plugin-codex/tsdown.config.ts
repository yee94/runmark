import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "dist",
  format: ["esm"],
  platform: "node",
  target: "node18",
  fixedExtension: true,
  dts: false,
  clean: true,
  treeshake: true,
  minify: false,
  external: ["bun:sqlite"],
  // Bundle @agent-tracker/shared inline so the CLI runs standalone
  onlyBundle: [/^@agent-tracker\//],
});
