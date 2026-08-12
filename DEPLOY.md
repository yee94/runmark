# Runmark 发布与部署

开源版的服务端部署与本机客户端接入，请先阅读 [README.md](README.md)。Docker 运行说明见 [docs/docker.md](docs/docker.md)。

## 本地 / 自托管部署

```bash
git clone https://github.com/yee94/runmark.git
cd runmark
./setup.sh --server
```

或使用 Docker（见 [docs/docker.md](docs/docker.md)）：

```bash
docker build -t runmark-server:dev .
docker run -d --name runmark -p 3456:3456 \
  -v runmark-data:/app/data \
  -e AGENT_TRACKER_API_KEY='your-strong-secret' \
  runmark-server:dev
```

生产环境也可通过 `deploy/deploy.sh` + `deploy/setup-remote.sh` 同步代码并注册 systemd。

## CI / 发布（GitHub Actions）

| 产物 | 触发标签 | Workflow | 版本约束 |
|------|----------|----------|----------|
| npm 客户端包 | `npm-v<release>` | [.github/workflows/npm-release.yml](.github/workflows/npm-release.yml) | 包版本由 Changesets / 各 `package.json` 决定；标签仅用于触发 |
| Server 安装包 + Docker + GitHub Release | `server-vX.Y.Z` | [.github/workflows/server-release.yml](.github/workflows/server-release.yml) | 标签版本必须等于 `packages/server/package.json` |
| PR / main 检查 | — | [.github/workflows/ci.yml](.github/workflows/ci.yml) | `bun install` → `build` → `test` |

**规则：** 先把发布提交推到 `main`，再打对应类型的标签。每次发布只打一种标签。

### npm 客户端发布

1. 用 Changesets  bump 客户端包版本（`@runmark/*`），提交到 `main`。
2. 打标签并推送：

```bash
git tag -a npm-v0.2.6 -m "npm clients"
git push origin npm-v0.2.6
```

3. 流水线执行 `changeset publish`，发布到 **npmjs**（scope `@runmark`）。

**需要配置的 Secret：**

| Secret | 用途 |
|--------|------|
| `NPM_TOKEN` | npmjs 自动化发布 token（Automation），且对 `@runmark` scope 有发布权限 |

仓库需在 [npmjs.com](https://www.npmjs.com) 创建 `@runmark` 组织（或用户 scope），并把 token 对应账号加入该 scope。

### Server + Docker + GitHub Release

1. 确认 `packages/server/package.json` 的 `version` 已升到目标值，并已合入 `main`。
2. 打标签：

```bash
VERSION=$(bun -e "console.log(require('./packages/server/package.json').version)")
git tag -a "server-v${VERSION}" -m "server ${VERSION}"
git push origin "server-v${VERSION}"
```

3. 流水线会：
   - 打包 `dist/agent-tracker-server-vX.Y.Z.tar.gz` + `.sha256`
   - 生成 `dist/server-manifest.json`（自动更新器用）
   - 构建并推送 Docker 镜像到 **GHCR**：
     - `ghcr.io/yee94/runmark/runmark-server:X.Y.Z`
     - `ghcr.io/yee94/runmark/runmark-server:latest`（仅正式 semver，不含 pre-release）
   - 创建 GitHub Release `server-vX.Y.Z`，并上传上述 3 个资产

**需要配置的 Secret：** 无额外 secret。`GITHUB_TOKEN` 由 Actions 自动注入（`contents: write` + `packages: write`）。

首次从 GHCR 拉取私有镜像时，需登录：

```bash
echo $GITHUB_TOKEN | docker login ghcr.io -u USERNAME --password-stdin
docker pull ghcr.io/yee94/runmark/runmark-server:latest
```

若仓库改为 public，且 GHCR 包可见性设为 public，则可免登录拉取。

### 自动更新默认地址

Server 默认：

```text
AGENT_TRACKER_UPDATE_MANIFEST_URL=https://github.com/yee94/runmark/releases/latest/download/server-manifest.json
```

对应 `server-v*` Release 里上传的 `server-manifest.json`。Docker 部署默认关闭文件式更新（`AGENT_TRACKER_UPDATE_ENABLED=false`），改拉新镜像升级。

**私有仓库注意：** GitHub 私有 Release 资产需要鉴权才能下载。当前更新器按公开 URL 拉取，因此：

- 仓库 / Release 设为 **public** 后，默认 manifest 即可用；或
- 保持私有时，把 `server-manifest.json` + tar 挂到你自己的 HTTPS 地址，并设置 `AGENT_TRACKER_UPDATE_MANIFEST_URL`。

## 本机手动打包（调试）

```bash
VERSION=$(bun -e "console.log(require('./packages/server/package.json').version)")
bash scripts/release/package-server.sh "$VERSION"
bun run scripts/release/generate-manifest.ts "$VERSION"
# 产物在 dist/
```

## 部署后验证

```bash
curl -fsS http://localhost:3456/health
# 期望：{"status":"ok",...}
```

Dashboard：`http://<服务器地址>:3456/`
