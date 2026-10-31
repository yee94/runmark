import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
export const bundledSkillsDirectory = fileURLToPath(new URL("./skills/", import.meta.url));
export async function setupRunmarkSkill(ctx) {
    if (!ctx.skill)
        return;
    const path = fileURLToPath(new URL("./skills/runmark/SKILL.md", import.meta.url));
    const [content, metadata] = await Promise.all([
        readFile(path, "utf8"),
        readFile(new URL("./skills/runmark/metadata.json", import.meta.url), "utf8"),
    ]);
    const { name, description } = JSON.parse(metadata);
    const skill = { id: name, name, description, path, content };
    return ctx.skill.transform((editor) => {
        if (editor.get(name))
            editor.update(name, (current) => Object.assign(current, skill));
        else
            editor.add(skill);
    });
}
//# sourceMappingURL=skill.js.map