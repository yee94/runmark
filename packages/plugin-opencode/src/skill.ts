import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export type BundledSkill = {
  id: string;
  name: string;
  description: string;
  path: string;
  content: string;
};

export type SkillHost = {
  skill?: {
    transform(callback: (editor: {
      get(id: string): BundledSkill | undefined;
      add(skill: BundledSkill): void;
      update(id: string, update: (skill: BundledSkill) => void): void;
    }) => void): Promise<{ dispose(): Promise<void> }>;
  };
};

export const bundledSkillsDirectory = fileURLToPath(new URL("./skills/", import.meta.url));

export async function setupRunmarkSkill(ctx: SkillHost) {
  if (!ctx.skill) return;
  const path = fileURLToPath(new URL("./skills/runmark/SKILL.md", import.meta.url));
  const [content, metadata] = await Promise.all([
    readFile(path, "utf8"),
    readFile(new URL("./skills/runmark/metadata.json", import.meta.url), "utf8"),
  ]);
  const { name, description } = JSON.parse(metadata) as { name: string; description: string };
  const skill = { id: name, name, description, path, content };
  return ctx.skill.transform((editor) => {
    if (editor.get(name)) editor.update(name, (current) => Object.assign(current, skill));
    else editor.add(skill);
  });
}
