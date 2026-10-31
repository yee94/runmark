import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");
const source = await Bun.file(resolve(import.meta.dir, "../openapi.yaml")).text();
const spec = Bun.YAML.parse(source) as any;
const errors: string[] = [];
let section = "";
const keys = new Set<string>();
for (const line of source.split("\n")) {
  const top = line.match(/^([\w-]+):/);
  if (top) section = top[1];
  const child = line.match(/^  ([\w/{}-]+):/);
  const key = top ? top[1] : child && ["paths", "components"].includes(section) ? `${section}.${child[1]}` : null;
  if (!key) continue;
  if (keys.has(key)) errors.push(`重复索引键: ${key}`);
  keys.add(key);
}
const documented = new Set<string>();
const methods = new Set(["get", "post", "put", "patch", "delete"]);
for (const [path, item] of Object.entries(spec.paths) as [string, any][]) {
  for (const method of Object.keys(item)) {
    if (methods.has(method)) documented.add(`${method} ${path}`);
  }
}
const implemented = new Set<string>();
const routes = resolve(root, "packages/server/src/routes");
for (const file of await readdir(routes)) {
  if (!file.endsWith(".ts")) continue;
  const text = await Bun.file(resolve(routes, file)).text();
  for (const match of text.matchAll(/app\.(get|post|put|patch|delete)\("([^"]+)"/g)) {
    implemented.add(`${match[1]} ${match[2].replace(/:([\w]+)/g, "{$1}")}`);
  }
}
implemented.add("get /health");
for (const route of implemented) if (!documented.has(route)) errors.push(`未记录: ${route}`);
for (const route of documented) if (!implemented.has(route)) errors.push(`失效路由: ${route}`);
function visit(value: any) {
  if (!value || typeof value !== "object") return;
  if (typeof value.$ref === "string" && value.$ref.startsWith("#/")) {
    const target = value.$ref.slice(2).split("/").reduce((node: any, key: string) => node?.[key.replace(/~1/g, "/").replace(/~0/g, "~")], spec);
    if (target === undefined) errors.push(`失效引用: ${value.$ref}`);
  }
  for (const child of Object.values(value)) visit(child);
}
visit(spec);
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`通过：${implemented.size} 个方法/路径均有文档，所有本地 $ref 可解析。`);
