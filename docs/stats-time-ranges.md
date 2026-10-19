# 统计时间范围

`/v1/stats/summary`、`/v1/stats/by-model`、`/v1/stats/by-agent`、`/v1/stats/daily` 共用时间参数：

- `range`: `today`、`24h`、`7d`、`month`、`last_month`、`all`、`custom`，默认 `month`。
- `from` / `to`: 成对传入带时区的 ISO 8601 时间戳，优先于预设范围；上下界均包含。`custom` 必须提供两者。缺失、非法或倒置返回 400。
- 未传显式边界的预设沿用 UTC 日历，`last_month` 表示完整上个 UTC 月。
- Dashboard 的今天、本月、上个月与自定义日期按浏览器本地日历转换为显式 UTC 边界。自定义结束日期包含整天，切换到自定义才展示日期选择器，点击“应用”查询。
- summary 返回实际采用的 `from` / `to`，便于固定快照与核对统计。费用读取 `cost_cny`，总 Token 读取 `tokens.total`。

例如北京时间 2026-10-18 全天（URL 中 `+` 必须编码为 `%2B`）：

```text
/v1/stats/summary?range=custom&from=2026-10-17T16%3A00%3A00.000Z&to=2026-10-18T15%3A59%3A59.999Z
```

键盘主题等调用方可将本地午夜与采集时刻转换为 UTC 后调用该接口，不再需要分页拉取 turns。不同采集时刻仍会产生数据差异。

现有统计实体口径不变：summary / by-model 按 turn 时间；by-agent 按 session 开始时间及累计量；daily 按 UTC 日期分组。会话列表独立于统计筛选。
