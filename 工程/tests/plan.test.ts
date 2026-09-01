// 「计划」和「已完成」的分组口径（2026-08-28 用户需求单第 7、9、13 条）。
// 分组是这两个视图唯一的规则，改坏了整页就是错的，所以单独钉住。
import { describe, expect, it } from "vitest";
import { newTask } from "../src/core/model";
import type { Priority } from "../src/core/model";
import { addDays } from "../src/core/dates";
import { doneGroups, planGroups, PLAN_BANDS } from "../src/core/plan";
import type { DateRow } from "../src/core/store";

const today = "2026-08-28";

function row(title: string, due: string | null, priority: Priority = 0): DateRow {
  return { task: newTask({ title, due, priority }), sub: null };
}

/** 分组结果压成「组名: 条目, 条目」，一眼看得出对不对 */
function shape(gs: { label: string; rows: DateRow[] }[]): string[] {
  return gs.filter((g) => g.rows.length).map((g) => `${g.label}: ${g.rows.map((r) => r.task.title).join(",")}`);
}

describe("按时间：接下来切成一周内 / 一个月内 / 半年内", () => {
  const rows = [
    row("逾期的", addDays(today, -3)),
    row("今天的", today),
    row("明天", addDays(today, 1)),
    row("第七天", addDays(today, 7)),
    row("第八天", addDays(today, 8)),
    row("三十天", addDays(today, 30)),
    row("三十一天", addDays(today, 31)),
    row("半年整", addDays(today, 182)),
    row("半年零一天", addDays(today, 183)),
    row("没日期", null),
  ];

  it("每一条都落在它该在的那一段，端点归前一段", () => {
    expect(shape(planGroups(rows, "time", today))).toEqual([
      "逾期: 逾期的",
      "今天: 今天的",
      "一周内: 明天,第七天",
      "一个月内: 第八天,三十天",
      "半年内: 三十一天,半年整",
      "更远: 半年零一天",
      "未安排: 没日期",
    ]);
  });

  it("半年以后的事有地方去——一条都不许在界面上蒸发", () => {
    const gs = planGroups(rows, "time", today);
    const shown = gs.flatMap((g) => g.rows);
    expect(shown).toHaveLength(rows.length);
  });

  it("只有逾期那组打醒目标记", () => {
    const gs = planGroups(rows, "time", today);
    expect(gs.filter((g) => g.warn).map((g) => g.label)).toEqual(["逾期"]);
  });

  it("分界天数就是 7 / 30 / 182，别被顺手改了", () => {
    expect(PLAN_BANDS.map((b) => b.days)).toEqual([7, 30, 182]);
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
