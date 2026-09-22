// 习惯的周期选项（09-21 统一口径）。用户原话：「习惯界面每天、每个工作日、每月、每N天（手动输入）、日历自行勾选」，
// 并且「各个地方的循环可选项要对齐一致」——所以习惯不再自己留一份选项表，跟任务的循环读同一份
// core/options.repeatMenu，只差两处：没有日期（每周X / 每月X号按今天算）、没有「不重复」。
//
// 参照日历：2026-09-21 周一 · 2026-09-30 周三 · 2026-10-31 周六
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type { RepeatRule } from "../src/core/model";
import { habitRepeatMenu, DEFAULT_HABIT_REPEAT } from "../src/core/habits";
import { repeatMenu, REPEAT_CUSTOM_LABEL, REPEAT_EVERY_LABEL } from "../src/core/options";

const MON = "2026-09-21";
const labels = (today: string, cur: RepeatRule | null) => habitRepeatMenu(today, cur).map((it) => it.label);

describe("habitRepeatMenu", () => {
  it("每天 / 每个工作日 / 每周X / 每月X号 / 每隔几天… / 自定义…，X 按今天，没有「不重复」", () => {
    expect(labels(MON, { kind: "daily", every: 1 })).toEqual([
      "每天", "每个工作日", "每周一", "每月21号", REPEAT_EVERY_LABEL, REPEAT_CUSTOM_LABEL,
    ]);
  });

  it("就是任务那份菜单去掉「不重复」，一项不多一项不少", () => {
    const cur: RepeatRule = { kind: "weekly", days: [1, 3, 5] };
    expect(habitRepeatMenu(MON, cur)).toEqual(repeatMenu(MON, cur).filter((it) => it.kind !== "clear"));
  });

  it("31 号那天打开：每月那项说「每月最后一天」", () => {
    expect(labels("2026-10-31", DEFAULT_HABIT_REPEAT)).toContain("每月最后一天");
  });

  it("现在的周期是常用项：它打勾，最上面不另挂", () => {
    const items = habitRepeatMenu(MON, { kind: "workday" });
    expect(items[0].kind).toBe("rule");
    const on = items.filter((it) => it.kind === "rule" && it.on).map((it) => it.label);
    expect(on).toEqual(["每个工作日"]);
  });

  it("自定义面板里七天全勾 = 每天：「每天」打勾，最上面不另挂「每周日、一…六」（09-22）", () => {
    const items = habitRepeatMenu(MON, { kind: "weekly", days: [0, 1, 2, 3, 4, 5, 6] });
    expect(items[0].kind).toBe("rule");
    const on = items.filter((it) => it.kind === "rule" && it.on).map((it) => it.label);
    expect(on).toEqual(["每天"]);
  });

  it("已经存下的周期不在常用项里（每周一三五 / 每 2 天 / 每月 8 号）：挂在最上面，不会被改成别的", () => {
    for (const cur of [
      { kind: "weekly", days: [1, 3, 5] },
      { kind: "daily", every: 2 },
      { kind: "monthly", day: 8 },
    ] as RepeatRule[]) {
      const items = habitRepeatMenu(MON, cur);
      expect(items[0]).toEqual({ kind: "current", rule: cur, label: expect.any(String) });
      expect(items.some((it) => it.kind === "rule" && it.on)).toBe(false);
    }
    expect(habitRepeatMenu(MON, { kind: "weekly", days: [1, 3, 5] })[0].label).toBe("每周一、三、五");
    expect(habitRepeatMenu(MON, { kind: "daily", every: 2 })[0].label).toBe("每2天");
  });

  it("没传周期按每天（习惯的兜底），仍然没有「不重复」", () => {
    const items = habitRepeatMenu(MON, null);
    expect(items.some((it) => it.kind === "clear")).toBe(false);
    expect(items.find((it) => it.kind === "rule" && it.on)?.label).toBe("每天");
  });
});

describe("三处入口都走这一份（源码守卫）", () => {
  const habits = readFileSync("src/views/Habits.tsx", "utf8");
  const sheet = readFileSync("src/mobile/HabitSheet.tsx", "utf8");
  const menu = readFileSync("src/components/RepeatMenu.tsx", "utf8");

  it("桌面：新建那一行和习惯详情都是同一颗 HabitRulePick，里面是 RepeatMenu / RepeatPicker", () => {
    expect(habits).toContain('<HabitRulePick className="hb-add-rule" value={draftRule} onPick={setDraftRule} />');
    expect(habits).toContain("onPick={(r) => setHabitRepeat(habit.id, r)}");
    expect(habits).toContain("items={habitRepeatMenu(today, value)}");
    expect(habits).toContain("<RepeatPicker value={value} anchor={today}");
    // 原生下拉和那份自带的选项表都没了
    expect(habits).not.toContain("<select");
    expect(habits).not.toContain("RULE_CHOICES");
    // 习惯不能被设成「不重复」
    expect(habits).toContain("onPick={(r) => r && pick(r)}");
  });

  it("RepeatMenu 可以换一份菜单项，不给还是 repeatMenu(anchor, value)", () => {
    expect(menu).toContain("items?: RepeatMenuItem[];");
    expect(menu).toContain("given ?? repeatMenu(anchor, value)");
  });

  it("手机那张纸：胶囊读 habitRepeatMenu，每隔几天手填、自定义用同一个面板，存的时候按同一个判等", () => {
    expect(sheet).toContain("habitRepeatMenu(today, rule)");
    expect(sheet).toContain("everyNDays(everyText)");
    expect(sheet).toContain("<RepeatPicker value={rule} anchor={today}");
    expect(sheet).toContain("!sameRepeat(rule, habit.repeat)");
    // 界面上不写死任何一项的名字
    const code = sheet.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const label of ["每个工作日", "每隔几天…", "自定义…", "每周一三五"]) expect(code).not.toContain(label);
  });
});
