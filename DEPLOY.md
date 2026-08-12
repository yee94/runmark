# Runmark 发布与部署

开源版的服务端部署与本机客户端接入，请先阅读 [README.md](README.md)。Docker 运行说明见 [docs/docker.md](docs/docker.md)。

## 本地 / 自托管部署

```bash
git clone https://github.com/runmark/runmark.git
cd runmark
./setup.sh --server
```

或使用 Docker（见 [docs/docker.md](docs/docker.md)）：

```bash
docker build -t runmark-server:dev .
docker run -d --name runmark -p 3456:3456 \
  -v runmark-data:/app/data \
  --env-file ./runmark.env \
  runmark-server:dev
```

生产环境也可通过 `deploy/deploy.sh` + `deploy/setup-remote.sh` 同步代码并注册 systemd；详见脚本内注释。

## 打包发布

内网 CI（标签触发、制品分发）已移除。Server 安装包与发布流程待迁移至 GitHub Actions。

若仓库仍保留 `scripts/release/package-server.sh`，可在本机手动打包：

```bash
# 示例：生成最小 Server 安装包（以脚本实际参数为准）
bash scripts/release/package-server.sh
```

客户端 npm 包通过 Changesets 管理版本；发布到 npmjs 时在本机或 CI 中执行 `changeset publish`。

## 部署后验证

```bash
curl -fsS http://localhost:3456/health
# 期望：{"status":"ok",...}
```

Dashboard：`http://<服务器地址>:3456/`

## 回滚与数据安全

- 生产部署目录建议使用 `/opt/agent-tracker`
- 更新器（若启用）在停止服务前备份代码与 SQLite；失败可回滚
- 备份目录默认：`/opt/runmark-updater/backups/`
- 更新器会拒绝操作包含 `.git` 的目录，保护开发 worktree
