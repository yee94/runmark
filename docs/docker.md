# Runmark Server Docker 部署

Runmark Server 以 Bun 多阶段镜像构建。运行镜像只包含编译后的 Server、Dashboard 静态资源和 Bun Runtime，SQLite 数据统一写入 `/app/data`。

## 镜像

### GHCR（推荐）

`server-vX.Y.Z` 标签触发 GitHub Actions，构建并推送：

```text
ghcr.io/yee94/runmark/runmark-server:X.Y.Z
ghcr.io/yee94/runmark/runmark-server:latest
```

#### 认证（私有仓库）

GHCR 包可见性与仓库一致。**仓库当前是 private**，包也是私有，拉取需要登录：

```bash
# 1. 创建 classic PAT（scope: read:packages），或 fine-grained token（只读该仓库的 Packages）
# 2. 用任意 GitHub 用户名 + PAT 登录
echo <PAT> | docker login ghcr.io -u yee94 --password-stdin
docker pull ghcr.io/yee94/runmark/runmark-server:latest
```

> 注意：Actions 内置的 `GITHUB_TOKEN` 只存在于 CI 运行时，**不能**用于日常 `docker login`。服务器/本机拉取请用带 `read:packages` 的 PAT。

#### 公开化后免认证

把仓库改为 public，并在 **Packages → runmark-server → Package settings** 里把包可见性设为 public 后，可免登录拉取：

```bash
docker pull ghcr.io/yee94/runmark/runmark-server:latest
```

### 本地构建（调试）

```bash
docker build -t runmark-server:X.Y.Z .
docker tag runmark-server:X.Y.Z runmark-server:latest
```

生产部署使用 `X.Y.Z` 固定版本标签，升级时显式切换版本号。

## 启动服务

创建完整运行配置 `runmark.env`：

```dotenv
AGENT_TRACKER_PORT=3456
AGENT_TRACKER_API_KEY=replace-with-a-strong-secret
AGENT_TRACKER_EXTRA_API_KEYS=
AGENT_TRACKER_DB_PATH=/app/data/agent-tracker.db
AGENT_TRACKER_PUBLIC_DIR=/app/public
AGENT_TRACKER_PUBLIC_DASHBOARD=false
AGENT_TRACKER_DEBUG=false
AGENT_TRACKER_LOG_FILE=/app/data/agent-tracker.log

AGENT_TRACKER_CURSOR_SYNC_ENABLED=false
AGENT_TRACKER_CURSOR_API_KEY=replace-with-the-main-api-key
AGENT_TRACKER_CURSOR_CRYPTO_KEY=

AGENT_TRACKER_LLM_BASE_URL=https://api.openai.com/v1/chat/completions
AGENT_TRACKER_LLM_API_KEY=
AGENT_TRACKER_LLM_MODEL=gpt-4o-mini
AGENT_TRACKER_AGENT_THROTTLE_MS=600000
AGENT_TRACKER_AGENT_AUTO_RUN_ENABLED=true

AGENT_TRACKER_UPDATE_ENABLED=false
AGENT_TRACKER_UPDATE_MANIFEST_URL=https://github.com/yee94/runmark/releases/latest/download/server-manifest.json
AGENT_TRACKER_UPDATE_SCRIPT=/opt/runmark-updater/update.sh
AGENT_TRACKER_UPDATE_STATE_PATH=/app/data/update-state.json
```

将 `AGENT_TRACKER_API_KEY` 替换为密码管理工具保存的强密钥。Cursor 对账和 LLM Agent 启用时填写对应密钥。

默认启动命令使用 named volume 持久化 SQLite、WAL/SHM、日志和更新状态：

```bash
docker volume create runmark-data

# 私有仓库：先按上文认证；公开后免登录
docker pull ghcr.io/yee94/runmark/runmark-server:0.2.27

docker run -d \
  --name runmark \
  --restart unless-stopped \
  -p 3456:3456 \
  -v runmark-data:/app/data \
  --env-file ./runmark.env \
  ghcr.io/yee94/runmark/runmark-server:0.2.27
```

镜像会拒绝空 API Key 和开发默认值 `dev-key-change-me`。验证服务：

```bash
docker ps --filter name=runmark
curl http://127.0.0.1:3456/health
```

Dashboard 地址为 `http://<服务器地址>:3456/`。

宿主机目录挂载适合需要直接查看数据库和日志的环境：

```bash
mkdir -p ./runmark-data
chown 1000:1000 ./runmark-data

docker run -d \
  --name runmark \
  --restart unless-stopped \
  -p 3456:3456 \
  -v "$(pwd)/runmark-data:/app/data" \
  --env-file ./runmark.env \
  ghcr.io/yee94/runmark/runmark-server:0.2.27
```

## Docker Compose

```yaml
services:
  runmark:
    image: ghcr.io/yee94/runmark/runmark-server:0.2.27
    container_name: runmark
    restart: unless-stopped
    ports:
      - "3456:3456"
    env_file:
      - ./runmark.env
    volumes:
      - runmark-data:/app/data

volumes:
  runmark-data:
```

启动：

```bash
docker compose up -d
docker compose ps
```

## 环境变量

| 变量 | 镜像默认值 | 说明 |
| --- | --- | --- |
| `AGENT_TRACKER_PORT` | `3456` | HTTP 监听端口 |
| `AGENT_TRACKER_API_KEY` | 应由部署方提供 | Dashboard 登录密码和写接口鉴权 |
| `AGENT_TRACKER_EXTRA_API_KEYS` | 空 | 额外 API Key，逗号分隔 |
| `AGENT_TRACKER_DB_PATH` | `/app/data/agent-tracker.db` | SQLite 文件路径 |
| `AGENT_TRACKER_PUBLIC_DIR` | `/app/public` | Dashboard 静态资源目录 |
| `AGENT_TRACKER_PUBLIC_DASHBOARD` | `false` | Dashboard 读接口鉴权开关 |
| `AGENT_TRACKER_LOG_FILE` | `/app/data/agent-tracker.log` | 文件日志路径 |
| `AGENT_TRACKER_DEBUG` | `false` | 文件日志开关 |
| `AGENT_TRACKER_CURSOR_SYNC_ENABLED` | `false` | Cursor Usage API 定时同步 |
| `AGENT_TRACKER_CURSOR_API_KEY` | 与主 API Key 相同 | Cursor 同步接口鉴权 Key |
| `AGENT_TRACKER_CURSOR_CRYPTO_KEY` | 空 | Cursor Session Token 加密密钥 |
| `AGENT_TRACKER_LLM_BASE_URL` | 空 | Agent LLM Endpoint |
| `AGENT_TRACKER_LLM_API_KEY` | 空 | Agent LLM API Key |
| `AGENT_TRACKER_LLM_MODEL` | 空 | Agent 默认模型 |
| `AGENT_TRACKER_AGENT_THROTTLE_MS` | `600000` | Agent 自动触发最小间隔，单位毫秒 |
| `AGENT_TRACKER_AGENT_AUTO_RUN_ENABLED` | `true` | Ingest 后自动调度 Agent |
| `AGENT_TRACKER_UPDATE_ENABLED` | `false` | 容器内文件式自动更新开关 |
| `AGENT_TRACKER_UPDATE_MANIFEST_URL` | GitHub Release latest | 文件式更新 manifest（Docker 默认关更新） |
| `AGENT_TRACKER_UPDATE_SCRIPT` | `/opt/runmark-updater/update.sh` | 文件式更新脚本路径 |
| `AGENT_TRACKER_UPDATE_STATE_PATH` | `/app/data/update-state.json` | 更新状态持久化路径 |

Docker 部署采用镜像版本升级，`AGENT_TRACKER_UPDATE_ENABLED=false` 保持容器文件系统与镜像一致。文件式更新器服务于 tar/systemd 部署。Cursor 同步启用示例：

```yaml
environment:
  AGENT_TRACKER_CURSOR_SYNC_ENABLED: "true"
  AGENT_TRACKER_CURSOR_CRYPTO_KEY: ${AGENT_TRACKER_CURSOR_CRYPTO_KEY}
```

## 数据持久化

`/app/data` 包含 SQLite 数据库、WAL/SHM 文件和可选日志。Docker named volume 会在容器重建后保留数据。

一致性备份采用停容器后归档 volume：

```bash
docker stop runmark
docker run --rm \
  -v runmark-data:/data:ro \
  -v "$PWD":/backup \
  alpine:3.20 \
  tar -czf /backup/runmark-data.tar.gz -C /data .
docker start runmark
```

恢复数据时先停止 Runmark 容器，再将备份解压到对应 volume。

## 升级

```bash
docker pull ghcr.io/yee94/runmark/runmark-server:0.2.28
docker rm -f runmark
docker run -d \
  --name runmark \
  --restart unless-stopped \
  -p 3456:3456 \
  -v runmark-data:/app/data \
  --env-file ./runmark.env \
  ghcr.io/yee94/runmark/runmark-server:0.2.28
```

Compose 部署更新镜像版本后执行：

```bash
docker compose pull
docker compose up -d
```
