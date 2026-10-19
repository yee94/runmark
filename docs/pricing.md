# Token 费用与历史回算

Runmark 的服务端估算表示 API 标准定价下的等值费用，不是 ChatGPT 订阅的实际扣款。OpenCode 在 ChatGPT OAuth 模式下将模型价格清空，插件把零费用留给服务端估算；非零客户端费用仍按既有规则优先，历史估价通过显式回算修正。

## Astra 计价

核对来源：https://developers.openai.com/api/docs/models/gpt-6-astra （2026-10-18）。美元 / 百万 token：

| 单次输入 | 非缓存输入 | 缓存读 | 缓存写 | 输出 / 推理 |
|---|---:|---:|---:|---:|
| ≤272,000 | 10 | 1 | 12.5 | 50 |
| >272,000 | 20 | 2 | 25 | 75 |

阈值按 `input_tokens + cache_read_tokens + cache_write_tokens` 判断，命中后整次请求采用该档价格。恰好 272,000 不加价。不能按会话累计 token 判断。

`gpt-6-astra-fast` 使用两倍价格，包括长上下文档。未上报计费模式的普通模型名按 Standard 估算，不能据此还原 Flex/Batch 或隐藏的 Fast 请求账单。

Server 0.2.36 同步登记 GPT-6 Sol（输入/输出/缓存读/缓存写 $2/$10/$0.20/$2.50）、Luna（$0.10/$0.50/$0.01/$0.125）、GPT-6.1 Sol（$2/$10/$0.10/$2.50）。三款均在超过 272K 时输入与缓存价格翻倍、输出及推理价格乘 1.5；Fast 再乘 2。精确 SKU 优先于跨渠道泛型号回退，避免误套 Astra 费率。

OpenCode 的输出与推理 token 是分开的，两者分别计价。Codex transcript 的 `output_tokens` 已含推理；服务端依据 session 的 `agent=codex` 标记避免再次收取推理费用。

实现参考：

- OpenCode：`packages/core/src/session/usage.ts` 的 `calculateCost()`；OAuth 清空价格位于 `packages/core/src/plugin/provider/openai.ts`。
- Magpie：`internal/catalog/catalog.go` 的 `Price.At()` / `Price.Cost()`；边界测试位于 `internal/catalog/price_tiers_test.go`。

## 配置价格

`ModelPricing.context_tiers` 是可选数组，各项包括 `above`、`input_price`、`output_price` 和可选的缓存、推理单价。选取最高命中的阈值，未填写的可选单价沿用基础价格；显式 `0` 表示免费。

数据库以 JSON 保存分档；`GET /v1/pricing` 返回数组，`PUT /v1/pricing` 接收相同结构。旧编辑器不传 `context_tiers` 时保留已有值，传 `[]` 清除。内置价格在启动时仍按代码中的默认表同步。

## 历史回算

OpenCode 插件 0.2.7 的 V2 适配器会跳过 `finish=tool-calls` 的模型轮次，只保存最终回答。0.2.8 修复此漏报。服务端 0.2.35 修正计价公式，但无法自行恢复从未上报的轮次：旧会话必须从来源 OpenCode 的完整记录补采后再回算，不能把现有明细的回算费用当作完整会话费用。

部署新服务端后，先预览指定会话：

```bash
source skills/agent-tracker-api/runmark-api.sh
runmark_post /v1/pricing/reprice \
  -H 'Content-Type: application/json' \
  -d '{"session_id":"ses_eb242bdf4ffeCafw9mS6KggPPM","model_contains":"gpt-6-astra","dry_run":true}'
```

返回 `scanned`、`updated`（预览时为将修改条数）、`delta_usd` 和样例。将 `dry_run` 改为 `false` 执行回算；可以同时按 provider、时间和模型过滤。

回算在同一事务中更新 turn 费用并从现存计费 turn 汇总 session 费用，保留 session 的累计 token、请求数与模型字段。若会话只采集到部分 turn，回算值也只覆盖这些明细，不等于完整用量的最终账单。重复执行不会累加费用。

此次核对保存的 11 条 Astra 明细：原费用 $1.084581，按上述 Standard 规则重算 $2.723762。
