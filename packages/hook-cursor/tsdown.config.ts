import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/cli.ts", "src/hook.ts"],
  outDir: "dist",
  format: ["esm"],
  platform: "node",
  target: "node18",
  // type:module 时 tsdown 默认输出 .js，但 bin / run.sh / init 约定使用 .mjs
  fixedExtension: true,
  dts: false,
  clean: true,
  treeshake: true,
  minify: false,
  noExternal: ["@agent-tracker/shared"],
});
