# Runmark Server 部署与更新

## 概述

服务端部署、客户端接入与健康检查见仓库根目录 [README.md](../README.md)。Docker 见 [docker.md](docker.md)。CI 发布见根目录 [DEPLOY.md](../DEPLOY.md)。

## Manifest 协议（schemaVersion 1）

自动更新器读取 `AGENT_TRACKER_UPDATE_MANIFEST_URL` 指向的 JSON：

```json
{
  "schemaVersion": 1,
  "version": "0.2.27",
  "publishedAt": "2026-08-12T08:00:00.000Z",
  "notes": "...",
  "artifact": {
    "url": "https://github.com/yee94/runmark/releases/download/server-v0.2.27/agent-tracker-server-v0.2.27.tar.gz",
    "sha256": "abc123...",
    "size": 123456
  }
}
```

`server-v*` GitHub Actions 会生成该文件并上传到对应 Release。默认 URL：

```text
https://github.com/yee94/runmark/releases/latest/download/server-manifest.json
```

## 自动更新器

### 环境变量

| 变量 | 默认值 |
|------|--------|
| `AGENT_TRACKER_UPDATE_ENABLED` | `true` |
| `AGENT_TRACKER_UPDATE_MANIFEST_URL` | GitHub Release latest `server-manifest.json` |
| `AGENT_TRACKER_UPDATE_SCRIPT` | `/opt/runmark-updater/update.sh` |
| `AGENT_TRACKER_UPDATE_STATE_PATH` | `/opt/runmark-updater/update-state.json` |

### 更新流程

Phase: `downloading` → `verifying` → `installing` → `backing_up` → `restarting` → `health_check` → `completed`

任何停止服务后的失败进入 `rolling_back` → `rolled_back`（保证服务最终启动）。

### 手动触发

```bash
bash /opt/runmark-updater/update.sh \
  --manifest-url https://github.com/yee94/runmark/releases/latest/download/server-manifest.json \
  --expected-version 0.2.28
```

## 安全特性

- `APP_ROOT` 含 `.git` 时拒绝执行（防止误操作仓库）
- flock 独占锁，缺失时 fail-closed
- SHA-256 完整性校验，下载大小限制
- 日志脱敏 API Key/Token
- 备份代码 + DB（含 wal/shm），回滚先清后恢复
- 状态文件原子写（mv 临时文件）
