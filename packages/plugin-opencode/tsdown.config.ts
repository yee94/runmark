import { defineConfig } from "tsdown";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { parse } from "yaml";

const skillSource = new URL("../../skills/runmark/", import.meta.url);
const skillOutput = new URL("./dist/skills/runmark/", import.meta.url);

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
  hooks: {
    "build:done": async () => {
      const source = await readFile(new URL("SKILL.md", skillSource), "utf8");
      const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
      const metadata = frontmatter ? parse(frontmatter) : undefined;
      if (typeof metadata?.name !== "string" || typeof metadata?.description !== "string") {
        throw new Error("skills/runmark/SKILL.md must declare name and description");
      }
      await rm(skillOutput, { recursive: true, force: true });
      await cp(skillSource, skillOutput, { recursive: true });
      await writeFile(new URL("metadata.json", skillOutput), JSON.stringify({
        name: metadata.name, description: metadata.description,
      }));
    },
  },
});
