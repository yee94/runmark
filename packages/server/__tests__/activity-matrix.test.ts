import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const compiler = new Bun.Transpiler({ loader: "jsx", tsconfig: { compilerOptions: { jsx: "react", jsxFactory: "h" } } });

test.each([
  [0, "0"], [725, "725"], [12_500, "12.5K"], [12_800_000, "12.8M"], [1_048_832_725, "1.05B"],
])("activity tooltip abbreviates %s as %s", (tokens, expected) => {
  const start = html.indexOf("function formatTokens(");
  const formatter = html.slice(start, html.indexOf("function formatCost(", start));
  const tooltipStart = html.indexOf("const ActivityTooltip =");
  const tooltip = html.slice(tooltipStart, html.indexOf("// 全部日行模型", tooltipStart));
  const render = runInNewContext(compiler.transformSync(formatter + tooltip) + "\nActivityTooltip", {
    component: (fn: unknown) => fn,
    activityHover: { value: { key: "2026-11-03", tokens, x: 100, y: 100 } },
    h: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children }),
  });
  expect(render().children[1].children.join("")).toBe(expected + " Token");
});

test.each([
  { year: 2026, month: 10, day: 10 },
  { year: 2027, month: 0, day: 1 },
  { year: 2024, month: 1, day: 29 },
  { year: 2026, month: 10, day: 8 },
  { year: 2026, month: 10, day: 14 },
])("activity starts with a full week and only leaves future weekdays empty (%j)", today => {
  const start = html.indexOf("const AnnualActivity = component(");
  const code = html.slice(start, html.indexOf("const ActivityTooltip =", start));
  const render = runInNewContext(compiler.transformSync(code) + "\nAnnualActivity", {
    component: (fn: unknown) => fn,
    beijingCalendarParts: () => today,
    annualStats: { value: [] },
    activityMode: { value: 'daily' },
    h: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children: children.flat(Infinity) }),
  });
  const grid = render().children[0];
  expect(grid.children).toHaveLength(53);
  const days = grid.children.flatMap((week: any) => {
    expect(week.children).toHaveLength(8);
    return week.children.slice(0, 7);
  });
  expect(days).toHaveLength(371);
  const end = Date.UTC(today.year, today.month, today.day);
  const weekday = new Date(end).getUTCDay();
  const populated = 365 + weekday;
  const first = end - (364 + weekday) * 86_400_000;
  expect(new Date(first).getUTCDay()).toBe(0);
  for (let i = 0; i < populated; i++) {
    const date = new Date(first + i * 86_400_000).toISOString().slice(0, 10);
    expect(days[i].props["aria-label"]).toBe(date + "：0 Token");
  }
  for (const day of days.slice(populated)) {
    expect(day.props.className).toBe("annual-activity-placeholder");
    expect(day.props["aria-hidden"]).toBe("true");
  }
});

test("weekly activity sums daily values into columns with a weekly tooltip", () => {
  const start = html.indexOf("const AnnualActivity = component(");
  const code = html.slice(start, html.indexOf("const ActivityTooltip =", start));
  const hover = { value: null as any };
  const render = runInNewContext(compiler.transformSync(code) + "\nAnnualActivity", {
    component: (fn: unknown) => fn,
    beijingCalendarParts: () => ({ year: 2026, month: 10, day: 10 }),
    annualStats: { value: [{ date: '2026-11-08', total_tokens: 100 }, { date: '2026-11-09', total_tokens: 200 }, { date: '2026-11-10', total_tokens: 300 }] },
    activityMode: { value: 'weekly' }, activityHover: hover, window: { innerWidth: 1200 },
    h: (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children: children.flat(Infinity) }),
  });
  const weeks = render().children[0].children;
  expect(weeks).toHaveLength(53);
  const last = weeks.at(-1);
  expect(last.props['aria-label']).toBe('2026-11-08 — 2026-11-10：600 Token');
  expect(last.children.slice(0, 7).every((day: any) => day.props.className.endsWith('--4'))).toBe(true);
  expect(weeks[0].children.slice(0, 7).every((day: any) => day.props.className.endsWith('--0'))).toBe(true);
  last.props.onMouseEnter({ currentTarget: { getBoundingClientRect: () => ({ left: 500, width: 14, top: 200 }) } });
  expect(hover.value.tokens).toBe(600);
  expect(hover.value.key).toBe('2026-11-08 — 2026-11-10');
});
