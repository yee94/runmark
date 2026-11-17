# 月度 SQLite 大字段存储

本阶段是**大字段按月外置**，不是会话整表分片。通过新版 updater 升级时会自动开启并迁移历史数据；现有 HTTP 接口、统计 SQL、Token/费用口径、外键和消息全文搜索不变。

## 数据布局

```text
agent-tracker.db                  # 结构、消息、统计、配置和 payload_refs 引用目录
agent-tracker.db.payloads/
  2026-09.db
  2026-10.db
```

大于等于 4096 UTF-8 字节的下列字段使用无损 deflate 压缩，月库内按原文 SHA-256 去重：

| 表 | 字段 |
| --- | --- |
| tool_calls | args / output_metadata / output_text |
| agent_jobs | input_json / prompt / output_json |
| agent_tool_calls | args / result（已有数据；当前在线工具日志不保存这两项正文） |
| ingest_events | 非 session 事件的完整 event_json |

月份按记录时间的北京时间计算；原始事件优先使用事件 created_at，否则使用 received_at。迟到数据和跨月续聊可以写历史月，不按会话开始时间强行归档。月库不是该月用量的统计来源。

消息正文和 session 事件的完整元数据仍留主库。原始事件的查询投影保留在主库，包含固定长度摘要，避免正文在唯一索引里重复膨胀；原有唯一约束保留以兼容旧版。只有迁过的非 session 大事件才会释放对应索引页，不能据此承诺整个旧索引消失。

月库正文只追加，不原地覆盖或在线删除。先独立持久化正文，再在主库事务提交引用；失败允许留下无引用正文，不允许提交悬空引用。更新和删除主库行会同步清理对应引用。读取缺片、损坏或摘要不匹配时返回错误，不将其替换成空文本。

## 平滑启用与验证

新版 updater 在升级前备份主库及引用月库并记录外键基线，先启动兼容新版并完成健康检查，再在线分批开启、迁移历史正文，最后校验并将升级标记为完成。迁移完成标记保存在主库，后续版本会跳过完整历史扫描。显式设置 `RUNMARK_PAYLOAD_SHARDING=false` 可禁用自动迁移。

以下命令用于副本演练或直接部署（没有使用 updater）的场景。只针对明确指定的数据库；不要对仍运行旧版代码的服务运行 enable/migrate。

```bash
# 旧库原样可备份；不会隐式初始化或启用外置写入
bun scripts/sqlite-storage.ts backup --db /data/agent-tracker.db --out /backup/runmark

# 仅开启后续新写入；也可配置 RUNMARK_PAYLOAD_SHARDING=true 后启动新服务
bun scripts/sqlite-storage.ts enable --db /data/agent-tracker.db

# 有界批次、持久化进度；被中断后原命令重跑
bun scripts/sqlite-storage.ts migrate --db /data/agent-tracker.db --batch-size 100

# updater 使用此命令：首次开启并迁移，已完成时直接跳过；inline 后会重新迁移
bun scripts/sqlite-storage.ts upgrade --db /data/agent-tracker.db --batch-size 100

# 小步演练：只执行一个批次，complete=false 是未完成而非失败
bun scripts/sqlite-storage.ts migrate --db /data/agent-tracker.db --batch-size 10 --max-batches 1

# 主库/月库 quick_check、外键、引用归属、逐正文解压及摘要校验
bun scripts/sqlite-storage.ts verify --db /data/agent-tracker.db

# 如旧库已有外键违规，可与可信备份清单中的违规集合比对；仍会报告违规数量
bun scripts/sqlite-storage.ts verify --db /data/agent-tracker.db --baseline-manifest /backup/runmark/manifests/具体清单.json
```

新旧数据可以共存。未指定 `RUNMARK_PAYLOAD_SHARDING` 时沿用库内开关；显式 `false` 只关闭新外置写入，已有引用仍可读取。迁移时不要同时运行多个维护命令或 VACUUM；批次会短暂占用主库写锁，CLI 等待锁的超时为 5 秒。失败退出非零，当前批次回滚，前面成功的批次保留。迁移完成会清理进度表，重复执行可重新检查在此期间改写过的旧行。

建议在副本完成 HTTP 详情/分享/搜索、跨月补写、verify、backup/restore 演练后再用于生产。当前自动测试使用本地 WAL 文件库，不等同于生产量级数据库的迁移耗时和磁盘压力验证。

## 无损回退到单库

不是把旧快照覆盖回来，而是把**全部现有引用（包括升级后新写入）**还原到主库：

```bash
# 先停服务，并移除 RUNMARK_PAYLOAD_SHARDING=true 或改成 false
bun scripts/sqlite-storage.ts inline --db /data/agent-tracker.db --batch-size 100
bun scripts/sqlite-storage.ts verify --db /data/agent-tracker.db
```

确认 `references=0`、`enabled=false` 后才能启动不支持月库的旧版本。inline 可以中断重试；缺片或损坏时明确失败，未恢复的引用保留。修复对应月库后重试。提前确认主库回填所需磁盘空间；月库文件不会被自动删除。

## 按变化备份与恢复

```bash
bun scripts/sqlite-storage.ts backup --db /data/agent-tracker.db --out /backup/runmark
# 输出 manifest 路径、copiedMonths 和 reusedMonths

bun scripts/sqlite-storage.ts restore \
  --manifest /backup/runmark/manifests/具体清单.json \
  --out /data/runmark-restored
bun scripts/sqlite-storage.ts verify --db /data/runmark-restored/main.db
```

备份先用 `VACUUM INTO` 固定主库水位，再为该快照引用的月份生成一致性快照。月库只追加，故随后快照不会丢失该水位所需正文。主库每次仍需快照；月份按该快照需要的正文集合决定是否复用对象，迟到补写会使旧月份重新备份。不是复制运行中的裸 `.db`，也不是 SQLite 页级增量备份。

备份不修复或删除旧库外键违规，而在清单中记录违规数量及集合摘要；恢复时要求违规集合完全一致，并在输出中报告数量。默认 `verify` 仍严格拒绝任何违规；`--baseline-manifest` 只接受与清单**完全一致**的历史违规，新增、减少或变更均需重新核对，不表示数据库外键完整。旧清单没有基线时仍采用严格校验。清单应与备份对象一起妥善保护，摘要不是签名，不能用于验证不可信清单。

备份和校验优先以只读方式打开主库。对 WAL 模式且缺少侧文件的数据库，若 SQLite 无法只读打开，会尝试以可写连接建立 SQLite 的 WAL/SHM 侧文件，不更改业务记录；此情形需要源目录有写权限。

`objects/` 保存按文件 SHA-256 命名的不可变 SQLite 快照；`manifests/` 保存独立恢复清单；`shards/` 是复用索引。清单与对象均完成持久化后才交付成功。恢复先检查全部文件校验和，再在临时目录重建主库与月库、校验引用，最后发布整个新目录。拒绝覆盖已有目标，不会替换运行库。

异机备份必须包含清单和其所有对象，不能只拷贝清单，也不要只复制主库。对象可能被多个清单共享，**不得按月份或 mtime 单独清理对象**；本阶段不提供自动 GC/保留策略，备份根目录需独立监控容量。

## 自动更新与空间回收

Server 发布包包含 `scripts/sqlite-storage.ts`。更新后的 `deploy/runmark-update.sh` 检测外置存储后，使用备份目录下共享的 `storage/` 对象库保存月库，避免每次发布重新复制所有历史月份；不支持月库的目标版本会被拦截，需先 inline 再降级。失败回滚会还原快照中的月库。**必须一并更新外部 updater 脚本**，仅换 server 包不会更新已经安装的旧 updater。

自动更新的应急回滚仍沿用现有“升级前快照水位恢复”语义，不承诺保留快照之后上报的数据；需要保留所有新增数据时使用上面的 inline 回退流程。部署前应在隔离环境使用合成数据验证升级、故障自动回滚和回填降级，再评估实际数据库的耗时与磁盘需求。

迁移释放的是主库可复用页，不自动缩小原 `.db` 的物理大小。确认备份和恢复后，可停服务使用经过验证的恢复目录替换部署的数据目录（同步修改 DB_PATH）；恢复出的主库已经由 VACUUM INTO 紧凑化。不要在迁移中间整理库，不要复制运行中的 DB，也不要删除旧数据目录，直到核对恢复后的 HTTP 内容及统计。在线月库 GC、整表分片、多机写入与生产量级压力测试不在本阶段范围内。
