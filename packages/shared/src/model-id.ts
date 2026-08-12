/**
 * 模型 id 规范化（定价匹配用）
 *
 * 参考 opencode-providers `model-display-name.ts`：
 * - 各渠道后缀（-ioa / -official / …）归一到同一计价 key
 * - 点号 / 下划线 / 大小写统一，便于 Claude-Opus-4.8 ↔ claude-opus-4-8
 * - 少量硬编码别名（hy3 → hy-3）覆盖自动规则搞不定的情况
 *
 * Codex / OpenCode / Cursor / Claude-compat 上报的 model 都经此函数再查 DEFAULT_PRICING。
 */

/** 渠道 / 部署后缀：剥掉后按基座模型计价 */
const CHANNEL_SUFFIXES = [
  "-volc-ioa",
  "-ioa",
  "-official",
  "-external",
  "-internal",
  "-preview",
] as const;

/**
 * 硬编码别名：规范化后的 key → 定价表使用的 canonical model id
 * 只列自动剥后缀仍对不齐的条目（对齐 opencode-shared display name 语义）。
 */
const MODEL_PRICING_ALIASES: Record<string, string> = {
  // CodeBuddy / 混元
  hy3: "hy-3",
  hunyuan3: "hy-3",
  "hunyuan-3": "hy-3",
  // GLM 版本写法
  "glm-5-0": "glm-5",
  "glm-5v-turbo": "glm-5-turbo",
  // 点号变体已由 normalize 处理；此处兜底旧 id
  "gemini-3-1-pro": "gemini-3.1-pro",
  "gemini-3-5-flash": "gemini-3.5-flash",
};

/** 统一 model id：大小写 / 点号 / 下划线 → 连字符 */
export function normalizeModelId(model: string): string {
  return model.toLowerCase().replace(/[._]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

/** 剥掉渠道后缀（可多次，如 deepseek-v3-2-volc-ioa） */
function stripChannelSuffixes(modelNorm: string): string {
  let current = modelNorm;
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of CHANNEL_SUFFIXES) {
      if (current.endsWith(suffix) && current.length > suffix.length) {
        current = current.slice(0, -suffix.length);
        changed = true;
        break;
      }
    }
  }
  // 上下文窗口标记：claude-opus-5-300k / claude-opus-4-8-1m → 基座 id（同价）
  if (/(^|-)\d+(k|m)$/i.test(current)) {
    current = current.replace(/-\d+(k|m)$/i, "");
  }
  return current;
}

/**
 * 定价用 canonical model id：
 * glm-5.2-ioa → glm-5-2；hy3-ioa → hy-3；Claude-Opus-4.8-1m → claude-opus-4-8
 */
export function canonicalizeModelId(model: string): string {
  const normalized = normalizeModelId(model);
  const stripped = stripChannelSuffixes(normalized);
  const aliased = MODEL_PRICING_ALIASES[stripped];
  if (aliased) return normalizeModelId(aliased);
  return stripped;
}

/** 导出别名表供测试 / Dashboard 展示对齐 */
export function getModelPricingAliases(): Readonly<Record<string, string>> {
  return MODEL_PRICING_ALIASES;
}
