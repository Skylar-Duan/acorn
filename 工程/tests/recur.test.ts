// recur.ts 测试：全部用固定日期字符串，不依赖真实当前时间。
// 周几参照：2026-08-17 是周一（08-18 二 … 08-21 五 08-22 六 08-23 日 08-24 一）；
// 2026-12-31 是周四；2027 为平年，2028 为闰年。

import { describe, it, expect } from "vitest";
import { nextOccurrence, firstOccurrence, describeRepeat } from "../src/core/recur";
import type { RepeatRule } from "../src/core/model";

describe("nextOccurrence · daily", () => {
  it("every=1 顺推一天", () => {
    expect(nextOccurrence({ kind: "daily", every: 1 }, "2026-08-17")).toBe("2026-08-18");
  });

  it("every=3 顺推三天", () => {
    expect(nextOccurrence({ kind: "daily", every: 3 }, "2026-08-17")).toBe("2026-08-20");
  });

  it("every=7 顺推一周", () => {
    expect(nextOccurrence({ kind: "daily", every: 7 }, "2026-08-17")).toBe("2026-08-24");
  });

  it("跨月", () => {
    expect(nextOccurrence({ kind: "daily", every: 3 }, "2026-08-30")).toBe("2026-09-02");
  });

  it("跨年", () => {
    expect(nextOccurrence({ kind: "daily", every: 1 }, "2026-12-31")).toBe("2027-01-01");
  });

  it("闰年跨过 2 月 29 日", () => {
    expect(nextOccurrence({ kind: "daily", every: 1 }, "2028-02-28")).toBe("2028-02-29");
    expect(nextOccurrence({ kind: "daily", every: 1 }, "2028-02-29")).toBe("2028-03-01");
  });
});

describe("nextOccurrence · weekly", () => {
  const mwf: RepeatRule = { kind: "weekly", days: [1, 3, 5] };

  it("周一之后落到周三", () => {
    expect(nextOccurrence(mwf, "2026-08-17")).toBe("2026-08-19");
  });

  it("严格大于：after 本身是落点也要跳到下一个", () => {
    expect(nextOccurrence(mwf, "2026-08-19")).toBe("2026-08-21");
  });

  it("跨周末：只选周一时周五推到下周一", () => {
    expect(nextOccurrence({ kind: "weekly", days: [1] }, "2026-08-21")).toBe("2026-08-24");
  });

  it("跨年：12-31 周四之后下一个周一落到次年", () => {
    expect(nextOccurrence({ kind: "weekly", days: [1] }, "2026-12-31")).toBe("2027-01-04");
  });

  it("周日用 0 表示", () => {
    expect(nextOccurrence({ kind: "weekly", days: [0] }, "2026-08-17")).toBe("2026-08-23");
  });

  it("days 为空数组时抛错", () => {
    expect(() => nextOccurrence({ kind: "weekly", days: [] }, "2026-08-17")).toThrow();
  });
});

describe("nextOccurrence · monthly", () => {
  it("本月候选还没到就用本月", () => {
    expect(nextOccurrence({ kind: "monthly", day: 28 }, "2026-08-17")).toBe("2026-08-28");
  });

  it("本月候选已过则落到下月", () => {
    expect(nextOccurrence({ kind: "monthly", day: 10 }, "2026-08-17")).toBe("2026-09-10");
  });

  it("严格大于：after 恰是落点时推到下月", () => {
    expect(nextOccurrence({ kind: "monthly", day: 17 }, "2026-08-17")).toBe("2026-09-17");
  });

  it("每月 31 号连推：1月31 → 2月28（平年）→ 3月31，clamp 不永久降级", () => {
    const rule: RepeatRule = { kind: "monthly", day: 31 };
    const feb = nextOccurrence(rule, "2027-01-31");
    expect(feb).toBe("2027-02-28");
    expect(nextOccurrence(rule, feb)).toBe("2027-03-31");
  });

  it("闰年 2 月落到 29 号", () => {
    const rule: RepeatRule = { kind: "monthly", day: 31 };
    const feb = nextOccurrence(rule, "2028-01-31");
    expect(feb).toBe("2028-02-29");
    expect(nextOccurrence(rule, feb)).toBe("2028-03-31");
  });

  it("每月 30 号过 2 月：clamp 到 28 后 3 月回到 30", () => {
    const rule: RepeatRule = { kind: "monthly", day: 30 };
    const feb = nextOccurrence(rule, "2027-01-30");
    expect(feb).toBe("2027-02-28");
    expect(nextOccurrence(rule, feb)).toBe("2027-03-30");
  });

  it("after 在月末 clamp 落点之前时仍用当月", () => {
    expect(nextOccurrence({ kind: "monthly", day: 31 }, "2027-02-27")).toBe("2027-02-28");
  });

  it("12 月落点已过则跨年到 1 月", () => {
    expect(nextOccurrence({ kind: "monthly", day: 5 }, "2026-12-20")).toBe("2027-01-05");
  });
});

describe("nextOccurrence · workday", () => {
  it("周一推周二", () => {
    expect(nextOccurrence({ kind: "workday" }, "2026-08-17")).toBe("2026-08-18");
  });

  it("周五跳过周末推周一", () => {
    expect(nextOccurrence({ kind: "workday" }, "2026-08-21")).toBe("2026-08-24");
  });

  it("周六推周一", () => {
    expect(nextOccurrence({ kind: "workday" }, "2026-08-22")).toBe("2026-08-24");
  });

  it("跨年：12-31 周四推 1-1 周五", () => {
    expect(nextOccurrence({ kind: "workday" }, "2026-12-31")).toBe("2027-01-01");
  });
});

describe("firstOccurrence（大于等于 from）", () => {
  it("daily 任意日期都是落点，返回 from 本身", () => {
    expect(firstOccurrence({ kind: "daily", every: 3 }, "2026-08-17")).toBe("2026-08-17");
  });

  it("weekly：from 命中周几时返回 from", () => {
    expect(firstOccurrence({ kind: "weekly", days: [1, 3, 5] }, "2026-08-17")).toBe("2026-08-17");
  });

  it("weekly：from 未命中时推到下一个落点", () => {
    expect(firstOccurrence({ kind: "weekly", days: [1, 3, 5] }, "2026-08-18")).toBe("2026-08-19");
  });

  it("monthly：from 恰是当月落点时返回 from", () => {
    expect(firstOccurrence({ kind: "monthly", day: 28 }, "2026-08-28")).toBe("2026-08-28");
  });

  it("monthly：2 月的 clamp 落点也算命中", () => {
    expect(firstOccurrence({ kind: "monthly", day: 31 }, "2027-02-28")).toBe("2027-02-28");
  });

  it("monthly：from 未命中时推进", () => {
    expect(firstOccurrence({ kind: "monthly", day: 28 }, "2026-08-17")).toBe("2026-08-28");
  });

  it("workday：工作日返回自身，周末推到周一", () => {
    expect(firstOccurrence({ kind: "workday" }, "2026-08-19")).toBe("2026-08-19");
    expect(firstOccurrence({ kind: "workday" }, "2026-08-22")).toBe("2026-08-24");
  });
});

describe("describeRepeat", () => {
  it("每天", () => {
    expect(describeRepeat({ kind: "daily", every: 1 })).toBe("每天");
  });

  it("每 N 天", () => {
    expect(describeRepeat({ kind: "daily", every: 3 })).toBe("每3天");
  });

  it("每周多天", () => {
    expect(describeRepeat({ kind: "weekly", days: [1, 3, 5] })).toBe("每周一、三、五");
  });

  it("每周含周日与周六", () => {
    expect(describeRepeat({ kind: "weekly", days: [0, 6] })).toBe("每周日、六");
  });

  it("每周单天", () => {
    expect(describeRepeat({ kind: "weekly", days: [2] })).toBe("每周二");
  });

  it("每月 N 号", () => {
    expect(describeRepeat({ kind: "monthly", day: 28 })).toBe("每月28号");
  });

  it("每个工作日", () => {
    expect(describeRepeat({ kind: "workday" })).toBe("每个工作日");
  });
});
