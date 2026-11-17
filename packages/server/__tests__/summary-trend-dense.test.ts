import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../public/style.css", import.meta.url), "utf8");
const summaryJs = readFileSync(new URL("../public/modules/summary.eficy.js", import.meta.url), "utf8");

// 每日趋势的密集模式分两半实现：summary.eficy.js 挂类名，style.css 提供去间距规则。
test("daily trend marks dense ranges in markup", () => {
  expect(summaryJs).toContain("bar-chart-plot--dense");
  expect(summaryJs).toContain("chart.rows.length > 60");
});

test("dense columns keep width when hundreds of days are rendered", () => {
  const denseIdx = css.indexOf(".bar-chart-plot.bar-chart-plot--dense");
  expect(denseIdx).toBeGreaterThan(-1);
  expect(css.slice(denseIdx, denseIdx + 120)).toContain("gap: 0");
  const baseIdx = css.indexOf("\n.bar-chart-plot {");
  expect(baseIdx).toBeGreaterThan(-1);
  expect(css.slice(baseIdx, css.indexOf("}", baseIdx))).toContain("gap: 6px");
  expect(denseIdx).toBeGreaterThan(baseIdx);
});

test("dense mode labels only the first day of each month", () => {
  expect(summaryJs).toContain("String(row.date).slice(8, 10) === '01'");
});
