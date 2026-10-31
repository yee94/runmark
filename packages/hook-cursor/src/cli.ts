#!/usr/bin/env node
import { runInit } from "./init";

function printHelp(): void {
  console.log(`Runmark — Cursor Hook 初始化

用法:
  npx @runmarks/cursor-hooks init [选项]
  runmark-cursor init [选项]

选项:
  --project    安装到当前项目的 .cursor/（默认：用户级 ~/.cursor/）
  --force      与默认行为相同，保留以便后续扩展
  -h, --help   显示帮助

说明:
  1. 复制 Hook 脚本到 .cursor/hooks/${"agent-tracker-hook.mjs"}
  2. 合并 ~/.cursor/hooks.json（或项目 .cursor/hooks.json）
  3. 新建配置使用 ~/.config/runmark/env（与 OpenCode 插件共用）

配置后重启 Cursor IDE，会话数据将以 agent=cursor 写入 Runmark。
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "-h" || cmd === "--help") {
    printHelp();
    process.exit(cmd ? 0 : 1);
    return;
  }

  if (cmd !== "init") {
    console.error(`未知命令: ${cmd}\n`);
    printHelp();
    process.exit(1);
    return;
  }

  const project = args.includes("--project");
  const force = args.includes("--force");

  try {
    const result = runInit({ project, force });
    console.log("Runmark Cursor Hook 已安装\n");
    console.log(`  Cursor 配置目录: ${result.cursorDir}`);
    console.log(`  hooks.json:      ${result.hooksPath}`);
    console.log(`  Hook 命令:       ${result.hookCommand}`);
    console.log(`  环境变量文件:    ${result.envPath}${result.envCreated ? " (已新建)" : ""}`);
    console.log("\n下一步:");
    console.log("  1. 编辑环境变量文件，设置 endpoint 与 apiKey");
    console.log("  2. 重启 Cursor IDE");
    console.log("  3. 在 Runmark Dashboard 的「会话」页查看 agent=cursor 的数据");
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
