import { describe, expect, it } from "vitest";
import { defaultData, migrate } from "../src/core/model";
import { dateOptions } from "../src/core/options";
import { dateShortcutLabel, defaultDateShortcuts, resolveDateShortcut, validDateShortcuts, type DateShortcutRule } from "../src/core/dateShortcuts";

const end = (period: "month" | "quarter" | "halfYear" | "year", mode: "calendar" | "workday" = "calendar"): DateShortcutRule => ({ id: period, kind: "end", period, mode });

describe("桌面自定义快捷日期", () => {
  it("旧设置不变；默认配置与原五项一致，周末取当前偏好", () => {
    for (const day of ["2026-10-21", "2026-10-24", "2026-10-25", "2026-10-31", "2026-12-31"]) {
      for (const weekendDay of ["sat", "sun"] as const) {
        expect(dateOptions(day, { dateShortcuts: defaultDateShortcuts(), weekendDay })).toEqual(dateOptions(day, { weekendDay }));
      }
    }
  });
  it("几天后按自然日跨月；工作日跳周末且不查节假日", () => {
    expect(resolveDateShortcut("2026-10-30", { id: "a", kind: "days", days: 3 })).toBe("2026-11-02");
    expect(resolveDateShortcut("2026-10-30", { id: "a", kind: "days", days: 3, mode: "workday" })).toBe("2026-11-04");
    expect(resolveDateShortcut("2026-10-01", { id: "a", kind: "days", days: 1, mode: "workday" })).toBe("2026-10-02");
    expect(resolveDateShortcut("2026-10-25", { id: "a", kind: "days", days: 0, mode: "workday" })).toBe("2026-10-26");
  });
  it("本周、下周、下下周指定星期；周末继续按周六/周日偏好", () => {
    for (const [weeks, date] of [[0, "2026-10-23"], [1, "2026-10-30"], [2, "2026-11-06"]] as const) {
      expect(resolveDateShortcut("2026-10-21", { id: "w", kind: "week", weeks, day: 5 })).toBe(date);
    }
    expect(resolveDateShortcut("2026-12-31", { id: "w", kind: "week", weeks: 1, day: 0 })).toBe("2027-01-10");
    expect(resolveDateShortcut("2026-10-21", { id: "w", kind: "week", weeks: 0, day: "weekend" }, "sat")).toBe("2026-10-24");
  });
  it("月末自然日与最后工作日分别计算，涵盖闰年", () => {
    expect(resolveDateShortcut("2026-10-21", end("month"))).toBe("2026-10-31");
    expect(resolveDateShortcut("2026-10-21", end("month", "workday"))).toBe("2026-10-30");
    expect(resolveDateShortcut("2027-02-01", end("month", "workday"))).toBe("2027-02-26");
    expect(resolveDateShortcut("2028-02-01", end("month"))).toBe("2028-02-29");
  });
  it("季度末取当前自然季度；结束在周日时取本季最后周五", () => {
    expect(resolveDateShortcut("2029-05-01", end("quarter"))).toBe("2029-06-30");
    expect(resolveDateShortcut("2029-05-01", end("quarter", "workday"))).toBe("2029-06-29");
    expect(resolveDateShortcut("2030-05-01", end("quarter", "workday"))).toBe("2030-06-28");
  });
  it("半年末固定6月/12月，不改变已有半年内的滚动口径", () => {
    expect(resolveDateShortcut("2030-01-01", end("halfYear"))).toBe("2030-06-30");
    expect(resolveDateShortcut("2030-01-01", end("halfYear", "workday"))).toBe("2030-06-28");
    expect(resolveDateShortcut("2026-07-01", end("halfYear"))).toBe("2026-12-31");
    expect(resolveDateShortcut("2026-12-31", end("year"))).toBe("2026-12-31");
    expect(resolveDateShortcut("2028-01-01", end("year", "workday"))).toBe("2028-12-29");
  });
  it("顺序按配置；同日保留最前一条；过去日期隐藏；顺延只留晚于现日期", () => {
    const dateShortcuts: DateShortcutRule[] = [
      { id: "q", kind: "end", period: "quarter", name: "交稿" },
      { id: "d", kind: "days", days: 1 },
      { id: "same", kind: "days", days: 1 },
      { id: "past", kind: "week", weeks: 0, day: 1 },
    ];
    expect(dateOptions("2026-10-21", { dateShortcuts }).map((o) => o.key)).toEqual(["q", "d"]);
    expect(dateOptions("2026-10-21", { dateShortcuts, after: "2026-10-22" }).map((o) => o.key)).toEqual(["q"]);
  });
  it("可以删除全部快捷项；取消配置等于回到默认，不影响任意日期入口", () => {
    expect(dateOptions("2026-10-21", { dateShortcuts: [] })).toEqual([]);
    expect(dateOptions("2026-10-21", { dateShortcuts: undefined }).length).toBe(5);
  });
  it("异常配置忽略；不接受负数/小数/超量/重复编号/未知规则", () => {
    const okay = { id: "a", kind: "days", days: 2 };
    expect(validDateShortcuts([okay, okay, { id: "x", kind: "days", days: -1 }, { id: "y", kind: "days", days: 1.5 }, { id: "z", kind: "days", days: 3651 }, { id: "r", kind: "end", period: "future" }])).toEqual([okay]);
    expect(validDateShortcuts(null)).toEqual(defaultDateShortcuts());
  });
  it("日期配置及未知字段读写后保留，数据版本不变", () => {
    const raw = defaultData();
    raw.settings.dateShortcuts = [{ id: "future", kind: "end", period: "year", futureRule: "retain" } as DateShortcutRule];
    const read = migrate(JSON.parse(JSON.stringify(raw)));
    expect(read.settings.dateShortcuts).toEqual(raw.settings.dateShortcuts);
    expect(read.version).toBe(raw.version);
    expect(dateShortcutLabel({ id: "a", kind: "days", days: 3, mode: "workday" })).toBe("3个工作日后");
  });
});
