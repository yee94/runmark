import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

test("npm package registers the current single-source skill with all relative resources", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "runmark-skill-package-")));
  const packageDirectory = resolve(import.meta.dir, "..");
  const sourceDirectory = resolve(packageDirectory, "../../skills/runmark");
  async function run(command: string[], cwd: string) {
    const proc = Bun.spawn(command, {
      cwd, stdout: "pipe", stderr: "pipe",
      env: { ...process.env, AGENT_TRACKER_MEMORY_ENABLED: "false", AGENT_TRACKER_DEBUG: "false" },
    });
    const [code, stdout, stderr] = await Promise.all([
      proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
    ]);
    if (code !== 0) throw new Error(`${command.join(" ")}: ${stdout}\n${stderr}`);
    return stdout;
  }
  try {
    await run(["npm", "pack", "--silent", "--pack-destination", directory], packageDirectory);
    const archive = (await readdir(directory)).find(file => file.endsWith(".tgz"))!;
    expect(archive).toStartWith("runmarks-opencode-plugin-");
    await run(["tar", "-xzf", join(directory, archive)], directory);
    const installed = join(directory, "package");
    const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
    expect(manifest.icon).toStartWith("data:image/svg+xml;base64,");
    expect(manifest.icon.length).toBeLessThan(3 << 19);
    const icon = Buffer.from(manifest.icon.slice("data:image/svg+xml;base64,".length), "base64").toString("utf8");
    expect(icon).toBe(await readFile(resolve(packageDirectory, "../../docs/images/runmark-icon.svg"), "utf8"));
    expect(icon).toContain('viewBox="0 0 128 128"');
    expect(icon).toContain("<path ");
    expect(icon).not.toMatch(/<(?:image|script|foreignObject|linearGradient|radialGradient)\b|data:image\//i);
    expect(icon).not.toContain("<rect");
    expect(icon).not.toMatch(/\b(?:fill|style)\s*=/i);
    expect(manifest.exports["./gui-experimental"]).toBe("./dist/gui-experimental.cjs");
    expect((await readFile(join(installed, manifest.exports["./gui-experimental"]), "utf8")).length).toBeGreaterThan(0);
    const result = JSON.parse(await run(["node", "--input-type=module", "-e", `
      import plugin from ${JSON.stringify(join(installed, "dist/index.mjs"))};
      const skills = new Map([["runmark", { id: "runmark", content: "stale" }], ["other", { id: "other" }]]);
      let disposed = false;
      const dispose = await plugin.setup({ skill: { async transform(callback) {
        callback({
          get(id) { return skills.get(id); },
          add(skill) { if (!skills.has(skill.id)) skills.set(skill.id, skill); },
          update(id, update) { update(skills.get(id)); },
        });
        return { async dispose() { disposed = true; } };
      } } });
      dispose();
      globalThis.fetch = async () => new Response("ok");
      const hooks = await plugin.server({ project: {}, directory: ${JSON.stringify(directory)}, client: {}, $: {} });
      const config = { skills: { paths: ["/existing/skills"] } };
      await hooks.config(config);
      await hooks.config(config);
      console.log(JSON.stringify({ skills: [...skills.values()], disposed, config }));
    `], directory));
    expect(result.skills).toHaveLength(2);
    expect(result.disposed).toBe(true);
    const skill = result.skills.find((item: { id: string }) => item.id === "runmark");
    const source = await readFile(join(sourceDirectory, "SKILL.md"), "utf8");
    expect(skill.content).toBe(source);
    expect(skill.description).toBe(source.match(/^description: (.+)$/m)![1]);
    expect(skill.path).toBe(join(installed, "dist/skills/runmark/SKILL.md"));
    expect(result.config.skills.paths).toEqual(["/existing/skills", join(installed, "dist/skills") + "/"]);
    for (const file of await readdir(sourceDirectory, { recursive: true, withFileTypes: true })) {
      if (!file.isFile()) continue;
      const relative = join(file.parentPath.slice(sourceDirectory.length), file.name);
      expect(await readFile(join(dirname(skill.path), relative))).toEqual(await readFile(join(sourceDirectory, relative)));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
