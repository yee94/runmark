# Runmark Server 部署与更新

## 概述

开源版的服务端部署、客户端接入与健康检查，请先阅读仓库根目录 [README.md](../README.md)。Docker 部署见 [docker.md](docker.md)。

内网自动构建 / 制品分发链路已移除；打包发布流程待迁移至 GitHub Actions。若仓库仍保留 `scripts/release/package-server.sh`，可在本机手动打包 Server 安装包。

## Manifest 协议（schemaVersion 1）

自托管更新器使用以下 manifest 形状（`AGENT_TRACKER_UPDATE_MANIFEST_URL` 指向你自己托管的 JSON）：

```json
{
  "schemaVersion": 1,
  "version": "0.2.3",
  "publishedAt": "2026-07-10T08:00:00.000Z",
  "notes": "...",
  "artifact": {
    "url": "https://example.com/releases/0.2.3/agent-tracker-server-v0.2.3.tar.gz",
    "sha256": "abc123...",
    "size": 123456
  }
}
```

## 自动更新器

### 环境变量

| 变量 | 默认值 |
|------|--------|
| `AGENT_TRACKER_UPDATE_ENABLED` | `true` |
| `AGENT_TRACKER_UPDATE_MANIFEST_URL` | （需自行配置托管地址） |
| `AGENT_TRACKER_UPDATE_SCRIPT` | `/opt/runmark-updater/update.sh` |
| `AGENT_TRACKER_UPDATE_STATE_PATH` | `/opt/runmark-updater/update-state.json` |

### 更新流程

Phase: `downloading` → `verifying` → `installing` → `backing_up` → `restarting` → `health_check` → `completed`

任何停止服务后的失败进入 `rolling_back` → `rolled_back`（保证服务最终启动）。

### 手动触发

```bash
bash /opt/runmark-updater/update.sh \
  --manifest-url https://example.com/server-manifest.json \
  --expected-version 0.2.4
```

## 安全特性

- `APP_ROOT` 含 `.git` 时拒绝执行（防止误操作仓库）
- flock 独占锁，缺失时 fail-closed
- SHA-256 完整性校验，下载大小限制
- 日志脱敏 API Key/Token
- 备份代码 + DB（含 wal/shm），回滚先清后恢复
- 状态文件原子写（mv 临时文件）
