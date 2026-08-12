#!/usr/bin/env node
/**
 * npx @runmarks/runmark 入口：转发到同目录 install.sh
 * 使用 CommonJS，避免部分环境下 npx 对 ESM bin 解析失败。
 */
const { spawnSync } = require("node:child_process");
const { dirname, resolve } = require("node:path");

const script = resolve(__dirname, "../install.sh");
const result = spawnSync("bash", [script, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});

process.exit(result.status ?? 1);
