// 「选日子 / 选循环」全应用唯一一份选项（core/options.ts，用户 09-21 定的口径）。
// 用户原话：「各个地方的循环可选项要对齐一致，包括延期选项也要对齐，现在不同的地方点进去可以选择的方案不一样」。
//
// 这里逐项钉住顺序与去重规则；各入口有没有真的用它，见 date-presets / postpone-presets / repeat-picker 那几份的源码守卫。
//
// 参照日历（自己核过）：2026-09-21 周一 · 09-26 周六 · 09-27 周日 · 09-29 周二 · 09-30 周三 · 2026-12-31 周四
import { describe, expect, it } from "vitest";
import { addDays, cmpYMD } from "../src/core/dates";
import type { RepeatRule } from "../src/core/model";
import {
  dateOptions, everyNDays, PICK_DATE_LABEL, repeatCommon, repeatMenu, sameRepeat,
  REPEAT_CLEAR_LABEL, REPEAT_CUSTOM_LABEL, REPEAT_EVERY_LABEL,
} from "../src/core/options";

const labels = (today: string, opts?: Parameters<typeof dateOptions>[1]) => dateOptions(today, opts).map((o) => o.label);

describe("dateOptions：今天 / 明天 / 本周末 / 下周末 / 本月末", () => {
  it("平常的一天五项都在，按这个顺序（周一，周末日周日）", () => {
    expect(dateOptions("2026-09-21", { weekendDay: "sun" })).toEqual([
      { key: "today", label: "今天", ymd: "2026-09-21" },
      { key: "tomorrow", label: "明天", ymd: "2026-09-22" },
      { key: "weekend", label: "本周末", ymd: "2026-09-27" },
      { key: "nextWeekend", label: "下周末", ymd: "2026-10-04" },
      { key: "monthEnd", label: "本月末", ymd: "2026-09-30" },
    ]);
  });

  it("不给周末日按周日（跟设置默认值一个口径）", () => {
    expect(dateOptions("2026-09-21")).toEqual(dateOptions("2026-09-21", { weekendDay: "sun" }));
  });

  it("周末日设成周六：本周末 / 下周末落在周六", () => {
    const o = dateOptions("2026-09-21", { weekendDay: "sat" });
    expect(o.find((x) => x.key === "weekend")!.ymd).toBe("2026-09-26");
    expect(o.find((x) => x.key === "nextWeekend")!.ymd).toBe("2026-10-03");
  });

  it("「本周五」「本周日」这两种写法没有了", () => {
    let d = "2026-01-01";
    for (let i = 0; i < 400; i++) {
      for (const wd of ["sat", "sun"] as const) {
        for (const l of labels(d, { weekendDay: wd })) {
          expect(["今天", "明天", "本周末", "下周末", "本月末"]).toContain(l);
        }
      }
      d = addDays(d, 1);
    }
  });

  it("跟前面某项撞同一天的不出：周六、周末日周日 → 本周末 = 明天，只留「明天」", () => {
    expect(labels("2026-09-26", { weekendDay: "sun" })).toEqual(["今天", "明天", "下周末", "本月末"]);
  });

  it("本周末落在今天：周日、周末日周日 → 不出「本周末」，只留「下周末」", () => {
    expect(labels("2026-09-27", { weekendDay: "sun" })).toEqual(["今天", "明天", "下周末", "本月末"]);
  });

  it("本周末已经过了：周日、周末日周六 → 也不出「本周末」", () => {
    const o = dateOptions("2026-09-27", { weekendDay: "sat" });
    expect(o.map((x) => x.key)).not.toContain("weekend");
    expect(o.find((x) => x.key === "nextWeekend")!.ymd).toBe("2026-10-03");
  });

  it("月末那天：本月末 = 今天，不出；倒数第二天：本月末 = 明天，也不出", () => {
    expect(labels("2026-09-30", { weekendDay: "sun" })).not.toContain("本月末");
    expect(labels("2026-09-29", { weekendDay: "sun" })).not.toContain("本月末");
  });

  it("本月末跟下周末撞同一天：只留排在前面的「下周末」", () => {
    // 2026-10-25 周日：下周末 = 10-31 周六（周末日周六），本月末也是 10-31
    expect(labels("2026-10-25", { weekendDay: "sat" })).toEqual(["今天", "明天", "下周末"]);
  });

  it("跨年：12 月 31 日，明天是 2027-01-01，本周末、下周末都在新年", () => {
    const o = dateOptions("2026-12-31", { weekendDay: "sun" });
    expect(o.map((x) => x.key)).toEqual(["today", "tomorrow", "weekend", "nextWeekend"]);
    expect(o[1].ymd).toBe("2027-01-01");
    expect(o[2].ymd).toBe("2027-01-03");
  });

  // 顺序是固定的（用户定的那一套），不是按日子排：月底那周「本月末」会早于「下周末」，照样排在它后面
  it("400 天 × 两种周末日：今天、明天、下周末永远在，没有两项同一天，全都晚于今天（今天那项除外），顺序固定", () => {
    let d = "2026-01-01";
    for (let i = 0; i < 400; i++) {
      for (const wd of ["sat", "sun"] as const) {
        const o = dateOptions(d, { weekendDay: wd });
        const keys = o.map((x) => x.key);
        expect(keys[0]).toBe("today");
        expect(keys[1]).toBe("tomorrow");
        expect(keys).toContain("nextWeekend");
        expect(new Set(o.map((x) => x.ymd)).size, `${d} ${wd}`).toBe(o.length);
        for (const x of o.slice(1)) expect(cmpYMD(x.ymd, d), `${d} ${wd} ${x.label}`).toBeGreaterThan(0);
        const order = ["today", "tomorrow", "weekend", "nextWeekend", "monthEnd"];
        expect(keys).toEqual(order.filter((k) => keys.includes(k as never)));
      }
      d = addDays(d, 1);
    }
  });
});

describe("dateOptions：顺延类入口的 after（不晚于现有日期的藏掉）", () => {
  it("过期的事：after 在今天以前，五项照旧", () => {
    expect(labels("2026-09-21", { weekendDay: "sun", after: "2026-09-10" })).toEqual(["今天", "明天", "本周末", "下周末", "本月末"]);
  });

  it("等于 after 的也藏（原地不动不叫顺延）", () => {
    expect(labels("2026-09-21", { weekendDay: "sun", after: "2026-09-21" })).toEqual(["明天", "本周末", "下周末", "本月末"]);
    expect(labels("2026-09-21", { weekendDay: "sun", after: "2026-09-27" })).toEqual(["下周末", "本月末"]);
  });

  it("先去重、再藏：今天被藏了，跟今天同一天的本周末不会顶上来", () => {
    expect(labels("2026-09-27", { weekendDay: "sun", after: "2026-09-27" })).toEqual(["明天", "下周末", "本月末"]);
  });

  it("after = null / 不给：不藏", () => {
    expect(dateOptions("2026-09-21", { after: null })).toEqual(dateOptions("2026-09-21"));
  });

  it("「选日期…」的名字只有一处", () => {
    expect(PICK_DATE_LABEL).toBe("选日期…");
  });
});

describe("repeatCommon / repeatMenu：每天 / 每个工作日 / 每周X / 每月X号 / 每隔几天… / 自定义… / 不重复", () => {
  it("常用项按这件事的日期取形（2026-09-21 周一 → 每周一、每月21号）", () => {
    expect(repeatCommon("2026-09-21")).toEqual([
      { kind: "daily", every: 1 },
      { kind: "workday" },
      { kind: "weekly", days: [1] },
      { kind: "monthly", day: 21 },
    ]);
  });

  it("没有循环时：七项里没有「不重复」，也没有打勾的", () => {
    const m = repeatMenu("2026-09-21", null);
    expect(m.map((x) => x.label)).toEqual(["每天", "每个工作日", "每周一", "每月21号", REPEAT_EVERY_LABEL, REPEAT_CUSTOM_LABEL]);
    expect(m.some((x) => x.kind === "rule" && x.on)).toBe(false);
  });

  it("现值在常用项里：那一项打勾，末尾出「不重复」", () => {
    const m = repeatMenu("2026-09-21", { kind: "workday" });
    expect(m.map((x) => x.label)).toEqual([
      "每天", "每个工作日", "每周一", "每月21号", REPEAT_EVERY_LABEL, REPEAT_CUSTOM_LABEL, REPEAT_CLEAR_LABEL,
    ]);
    expect(m.filter((x) => x.kind === "rule" && x.on).map((x) => x.label)).toEqual(["每个工作日"]);
  });

  it("现值不在常用项里（每3天 / 每周一三五）：最上面单独挂现值，常用项都不打勾", () => {
    for (const cur of [{ kind: "daily", every: 3 }, { kind: "weekly", days: [1, 3, 5] }] as RepeatRule[]) {
      const m = repeatMenu("2026-09-21", cur);
      expect(m[0].kind).toBe("current");
      expect(m.slice(1).map((x) => x.kind)).toEqual(["rule", "rule", "rule", "rule", "every", "custom", "clear"]);
      expect(m.some((x) => x.kind === "rule" && x.on)).toBe(false);
    }
    expect(repeatMenu("2026-09-21", { kind: "daily", every: 3 })[0].label).toBe("每3天");
  });

  it("每周那几天顺序不同也认成同一个（[1] 对 [1]、[5,1] 对 [1,5]）", () => {
    expect(sameRepeat({ kind: "weekly", days: [5, 1] }, { kind: "weekly", days: [1, 5] })).toBe(true);
    const m = repeatMenu("2026-09-21", { kind: "weekly", days: [1] });
    expect(m[0].kind).toBe("rule");
    expect(m.find((x) => x.kind === "rule" && x.on)!.label).toBe("每周一");
  });

  it("31 号那天：常用项写「每月最后一天」", () => {
    expect(repeatMenu("2026-10-31", null).map((x) => x.label)).toContain("每月最后一天");
  });

  it("没日期按今天取形是调用方的事：anchor 换一天，每周X / 每月X号跟着换", () => {
    const labelsOf = (a: string) => repeatMenu(a, null).map((x) => x.label);
    expect(labelsOf("2026-09-26")).toContain("每周六");
    expect(labelsOf("2026-09-26")).toContain("每月26号");
  });
});

describe("everyNDays：「每隔几天…」填的字", () => {
  it("1–365 的整数收下", () => {
    expect(everyNDays("3")).toEqual({ kind: "daily", every: 3 });
    expect(everyNDays(" 14 ")).toEqual({ kind: "daily", every: 14 });
    expect(everyNDays(365)).toEqual({ kind: "daily", every: 365 });
    expect(everyNDays("1")).toEqual({ kind: "daily", every: 1 });
  });

  it("别的一律不收", () => {
    for (const v of ["", "0", "-2", "366", "2.5", "abc"]) expect(everyNDays(v), v).toBeNull();
  });
});
