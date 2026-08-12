# Runmark Server Docker 部署

Runmark Server 以 Bun 多阶段镜像构建。运行镜像只包含编译后的 Server、Dashboard 静态资源和 Bun Runtime，SQLite 数据统一写入 `/app/data`。

## 镜像

推荐从源码本地构建，或使用你自己的容器仓库托管镜像：

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
AGENT_TRACKER_UPDATE_MANIFEST_URL=
AGENT_TRACKER_UPDATE_SCRIPT=/opt/runmark-updater/update.sh
AGENT_TRACKER_UPDATE_STATE_PATH=/app/data/update-state.json
```

将 `AGENT_TRACKER_API_KEY` 替换为密码管理工具保存的强密钥。Cursor 对账和 LLM Agent 启用时填写对应密钥。

默认启动命令使用 named volume 持久化 SQLite、WAL/SHM、日志和更新状态：

```bash
docker volume create runmark-data

docker run -d \
  --name runmark \
  --restart unless-stopped \
  -p 3456:3456 \
  -v runmark-data:/app/data \
  --env-file ./runmark.env \
  runmark-server:0.2.12
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
  runmark-server:0.2.12
```

## Docker Compose

```yaml
services:
  runmark:
    image: runmark-server:0.2.12
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
| `AGENT_TRACKER_UPDATE_MANIFEST_URL` | 空 | 更新 manifest 地址（自托管） |
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
docker build -t runmark-server:0.2.13 .
docker rm -f runmark
docker run -d \
  --name runmark \
  --restart unless-stopped \
  -p 3456:3456 \
  -v runmark-data:/app/data \
  --env-file ./runmark.env \
  runmark-server:0.2.13
```

Compose 部署更新镜像版本后执行：

```bash
docker compose pull
docker compose up -d
```

## 本地构建

```bash
docker build -t runmark-server:dev .
docker run --rm \
  -p 3456:3456 \
  -v runmark-data:/app/data \
  --env-file ./runmark.env \
  runmark-server:dev
```
