// 「计划」和「已完成」的分组口径（2026-08-28 用户需求单第 7、9、13 条；计划按时间那一路 2026-09-23 改成按日历切）。
// 分组是这两个视图唯一的规则，改坏了整页就是错的，所以单独钉住。
import { describe, expect, it } from "vitest";
import { newTask } from "../src/core/model";
import type { Priority } from "../src/core/model";
import { addDays, halfYearEnd } from "../src/core/dates";
import { doneGroups, planBands, planGroups } from "../src/core/plan";
import { parseQuickAdd } from "../src/core/parse";
import type { DateRow } from "../src/core/store";

const today = "2026-08-28";

function row(title: string, due: string | null, priority: Priority = 0): DateRow {
  return { task: newTask({ title, due, priority }), sub: null };
}

/** 分组结果压成「组名: 条目, 条目」，一眼看得出对不对 */
function shape(gs: { label: string; rows: DateRow[] }[]): string[] {
  return gs.filter((g) => g.rows.length).map((g) => `${g.label}: ${g.rows.map((r) => r.task.title).join(",")}`);
}

describe("按时间：今天 / 本周 / 本月 / 半年内 / 更远 / 未安排（2026-09-23 起按日历切）", () => {
  // 用户原话的例子：九月 23 号看，半年内收到明年三月底。这天是周三
  const now = "2026-09-23";
  const rows = [
    row("逾期的", "2026-09-20"),
    row("今天的", now),
    row("明天", "2026-09-24"),
    row("本周日", "2026-09-27"),
    row("下周一", "2026-09-28"),
    row("九月底", "2026-09-30"),
    row("十月一号", "2026-10-01"),
    row("明年三月底", "2027-03-31"),
    row("明年四月一号", "2027-04-01"),
    row("没日期", null),
  ];

  it("每一条都落在它该在的那一段，端点归前一段", () => {
    expect(shape(planGroups(rows, "time", now))).toEqual([
      "逾期: 逾期的",
      "今天: 今天的",
      "本周: 明天,本周日",
      "本月: 下周一,九月底",
      "半年内: 十月一号,明年三月底",
      "更远: 明年四月一号",
      "未安排: 没日期",
    ]);
  });

  it("组的顺序：逾期 / 今天 / 本周 / 本月 / 半年内 / 更远 / 未安排", () => {
    expect(planGroups([], "time", now).map((g) => g.label)).toEqual([
      "逾期",
      "今天",
      "本周",
      "本月",
      "半年内",
      "更远",
      "未安排",
    ]);
  });

  it("半年以后的事有地方去——一条都不许在界面上蒸发", () => {
    const gs = planGroups(rows, "time", now);
    const shown = gs.flatMap((g) => g.rows);
    expect(shown).toHaveLength(rows.length);
  });

  it("只有逾期那组打醒目标记", () => {
    const gs = planGroups(rows, "time", now);
    expect(gs.filter((g) => g.warn).map((g) => g.label)).toEqual(["逾期"]);
  });

  it("三段的最后一天：本周日 / 这个月最后一天 / 往后第六个月的最后一天", () => {
    expect(planBands(now).map((b) => `${b.label} ${b.end}`)).toEqual([
      "本周 2026-09-27",
      "本月 2026-09-30",
      "半年内 2027-03-31",
    ]);
    // 月份向上取整：月初看也是同一个月底
    expect(planBands("2026-09-01")[2].end).toBe("2027-03-31");
    // 跨年、落在二月、落在大月
    expect(halfYearEnd("2026-12-05")).toBe("2027-06-30");
    expect(halfYearEnd("2026-08-31")).toBe("2027-02-28");
    expect(halfYearEnd("2027-08-15")).toBe("2028-02-29");
    expect(halfYearEnd("2026-01-31")).toBe("2026-07-31");
  });

  it("月底落在本周里：本周收到周日（跨进下个月），本月那段是空的", () => {
    const mon = "2026-09-28"; // 周一，本周到 10 月 4 日
    const rs = [row("周三", "2026-09-30"), row("十月四号", "2026-10-04"), row("十月五号", "2026-10-05")];
    expect(shape(planGroups(rs, "time", mon))).toEqual(["本周: 周三,十月四号", "半年内: 十月五号"]);
  });

  it("今天就是周日：本周那段是空的，明天起进本月", () => {
    const sun = "2026-09-27";
    const rs = [row("周一", "2026-09-28"), row("十月一号", "2026-10-01")];
    expect(shape(planGroups(rs, "time", sun))).toEqual(["本月: 周一", "半年内: 十月一号"]);
  });

  it("换哪一天看都一样：从三天前到四百天后，每一条都进且只进一组", () => {
    let day = "2026-01-01";
    for (let i = 0; i < 400; i++, day = addDays(day, 1)) {
      const rs = Array.from({ length: 404 }, (_, k) => row(String(k), addDays(day, k - 3)));
      const gs = planGroups(rs, "time", day);
      const seen = gs.flatMap((g) => g.rows.map((r) => r.task.title));
      expect(seen).toHaveLength(rs.length);
      expect(new Set(seen).size).toBe(rs.length);
    }
  });

  it("「~半年内」跟「半年内」那一组的最后一天逐天一致", () => {
    let day = "2026-01-01";
    for (let i = 0; i < 800; i++, day = addDays(day, 1)) {
      const [y, m, d] = day.split("-").map(Number);
      const r = parseQuickAdd("~半年内 考驾照", { now: new Date(y, m - 1, d, 10, 0), listNames: [] });
      expect(r.due).toBe(planBands(day)[2].end);
      // 那一天本身落在「半年内」，再往后一天就进「更远」
      const gs = planGroups([row("边界", r.due), row("再往后", addDays(r.due!, 1))], "time", day);
      expect(gs.find((g) => g.key === "half")!.rows.map((x) => x.task.title)).toEqual(["边界"]);
      expect(gs.find((g) => g.key === "far")!.rows.map((x) => x.task.title)).toEqual(["再往后"]);
    }
  });
});

describe("按重要性：换的是分组维度，不只是组内排法", () => {
  const rows = [
    row("高·后天", addDays(today, 2), 3),
    row("高·今天", today, 3),
    row("中·下周", addDays(today, 6), 2),
    row("低·没日期", null, 1),
    row("普通·明天", addDays(today, 1), 0),
  ];

  it("分成 高/中/低/普通 四组", () => {
    expect(planGroups(rows, "priority", today).map((g) => g.label)).toEqual(["高", "中", "低", "普通"]);
  });

  it("每组内部按时间排，不是按重要性再排一遍", () => {
    expect(shape(planGroups(rows, "priority", today))).toEqual([
      "高: 高·今天,高·后天",
      "中: 中·下周",
      "低: 低·没日期",
      "普通: 普通·明天",
    ]);
  });

  it("这个模式下没有「逾期」这一组——逾期的按自己的重要性归档", () => {
    const gs = planGroups([row("逾期高", addDays(today, -1), 3)], "priority", today);
    expect(shape(gs)).toEqual(["高: 逾期高"]);
  });
});

describe("已完成：过去一周 / 过去一个月 / 更早", () => {
  const items = [
    { id: "a", day: today },
    { id: "b", day: addDays(today, -7) },
    { id: "c", day: addDays(today, -8) },
    { id: "d", day: addDays(today, -30) },
    { id: "e", day: addDays(today, -31) },
  ];

  it("端点归前一段，一条都不落下", () => {
    const gs = doneGroups(items, (x) => x.day, today);
    expect(gs.map((g) => `${g.label}: ${g.items.map((x) => x.id).join(",")}`)).toEqual([
      "过去一周: a,b",
      "过去一个月: c,d",
      "更早: e",
    ]);
  });
});
