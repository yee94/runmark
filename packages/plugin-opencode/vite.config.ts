import { gui } from "@opencode/plugin/gui/vite";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: { extensions: [".mts", ".ts", ".tsx", ".mjs", ".js", ".jsx", ".json"] },
  plugins: [gui({ entry: "src/gui.ts" })],
});
