// 习惯的口径。连续天数是这个功能的灵魂数字，算错了整个功能就没意义，
// 所以这里把「什么时候该+1、什么时候该断、什么时候不该归零」全钉死。
import { beforeEach, describe, expect, it } from "vitest";
import {
  addHabit,
  aliveHabits,
  aliveTasks,
  addTask,
  appStore,
  completeTask,
  habitsOpenToday,
  openRows,
  setHabitRepeat,
  setTaskKind,
  toggleHabitCheck,
} from "../src/core/store";
import { defaultData, migrate, newTask, normalizeCheckIns } from "../src/core/model";
import type { RepeatRule, Task } from "../src/core/model";
import {
  bestStreak,
  describeHabitRule,
  doneOn,
  isDueOn,
  monthMarks,
  recentRate,
  sortHabitsForDay,
  streak,
  toggleCheck,
  weekMarks,
} from "../src/core/habits";

const LS_KEY = "acorn-data";
// 2026-08-24 是周一，下面所有「今天」都用它，不看真实日期
const MON = "2026-08-24";

function habit(partial: Partial<Task> & { title: string }): Task {
  return newTask({ kind: "habit", repeat: { kind: "daily", every: 1 }, createdAt: "2026-08-01T00:00:00.000Z", ...partial });
}

function getTask(id: string): Task {
  const t = appStore.getState().data.tasks.find((x) => x.id === id);
  if (!t) throw new Error("not found");
  return t;
}

beforeEach(() => {
  localStorage.removeItem(LS_KEY);
  appStore.setState({ data: defaultData(), loaded: true, loadError: null });
});

describe("今天该不该做", () => {
  it("每天：天天都该做", () => {
    const h = habit({ title: "喝水" });
    expect(isDueOn(h, MON)).toBe(true);
    expect(isDueOn(h, "2026-08-25")).toBe(true);
  });

  it("每个工作日：周末不该做", () => {
    const h = habit({ title: "背单词", repeat: { kind: "workday" } });
    expect(isDueOn(h, "2026-08-24")).toBe(true); // 周一
    expect(isDueOn(h, "2026-08-28")).toBe(true); // 周五
    expect(isDueOn(h, "2026-08-29")).toBe(false); // 周六
    expect(isDueOn(h, "2026-08-30")).toBe(false); // 周日
  });

  it("每周一三五", () => {
    const h = habit({ title: "健身", repeat: { kind: "weekly", days: [1, 3, 5] } });
    expect(isDueOn(h, "2026-08-24")).toBe(true); // 一
    expect(isDueOn(h, "2026-08-25")).toBe(false); // 二
    expect(isDueOn(h, "2026-08-26")).toBe(true); // 三
  });

  it("每月 28 号；2 月没有 31 号时落到月末", () => {
    const h28 = habit({ title: "交房租", repeat: { kind: "monthly", day: 28 } });
    expect(isDueOn(h28, "2026-08-28")).toBe(true);
    expect(isDueOn(h28, "2026-08-27")).toBe(false);
    const h31 = habit({ title: "月结", repeat: { kind: "monthly", day: 31 } });
    expect(isDueOn(h31, "2026-02-28")).toBe(true); // 2026 平年，31 号落到 28
    expect(isDueOn(h31, "2026-03-31")).toBe(true);
    expect(isDueOn(h31, "2026-03-30")).toBe(false);
  });

  it("每 3 天：从创建那天起算，创建之前的日子不算", () => {
    const h = habit({ title: "浇花", repeat: { kind: "daily", every: 3 }, createdAt: "2026-08-24T00:00:00.000Z" });
    expect(isDueOn(h, "2026-08-24")).toBe(true);
    expect(isDueOn(h, "2026-08-25")).toBe(false);
    expect(isDueOn(h, "2026-08-27")).toBe(true);
    expect(isDueOn(h, "2026-08-23")).toBe(false); // 创建之前
  });
});

describe("连续天数", () => {
  it("每天的习惯，连着打三天就是 3", () => {
    const h = habit({ title: "喝水", checkIns: ["2026-08-22", "2026-08-23", MON] });
    expect(streak(h, MON)).toBe(3);
  });

  it("今天还没打卡，不归零——数到昨天为止", () => {
    const h = habit({ title: "喝水", checkIns: ["2026-08-22", "2026-08-23"] });
    expect(streak(h, MON)).toBe(2);
  });

  it("中间断了一天就重新数", () => {
    const h = habit({ title: "喝水", checkIns: ["2026-08-20", "2026-08-22", "2026-08-23"] });
    expect(streak(h, MON)).toBe(2);
  });

  it("一次都没打过是 0", () => {
    expect(streak(habit({ title: "新习惯" }), MON)).toBe(0);
  });

  it("每周一的习惯：连着三周就是 3（不是 3 天）", () => {
    const h = habit({
      title: "周会",
      repeat: { kind: "weekly", days: [1] },
      checkIns: ["2026-08-10", "2026-08-17", MON],
    });
    expect(streak(h, MON)).toBe(3);
  });

  it("工作日习惯：周末没打卡不算断", () => {
    const h = habit({
      title: "背单词",
      repeat: { kind: "workday" },
      // 8-20 四、8-21 五、（22/23 周末跳过）、8-24 一
      checkIns: ["2026-08-20", "2026-08-21", MON],
    });
    expect(streak(h, MON)).toBe(3);
  });

  it("历史最长连续记得住，哪怕现在断了", () => {
    const h = habit({
      title: "喝水",
      checkIns: ["2026-08-10", "2026-08-11", "2026-08-12", "2026-08-13", "2026-08-20"],
    });
    expect(bestStreak(h)).toBe(4);
    expect(streak(h, MON)).toBe(0); // 今天该做没做，昨天也没做
  });
});

describe("一周七格", () => {
  it("每天的习惯：做过的 done、过去没做的 missed、今天未做 todo、以后 future", () => {
    const h = habit({ title: "喝水", checkIns: ["2026-08-24"] });
    // MON 是周一，weekStart 从周一算
    const marks = weekMarks(h, "2026-08-26"); // 当作周三
    const byDay = Object.fromEntries(marks.map((m) => [m.ymd, m.mark]));
    expect(byDay["2026-08-24"]).toBe("done");
    expect(byDay["2026-08-25"]).toBe("missed");
    expect(byDay["2026-08-26"]).toBe("todo");
    expect(byDay["2026-08-27"]).toBe("future");
  });

  it("不该做的那天标成 off，不算漏", () => {
    const h = habit({ title: "健身", repeat: { kind: "weekly", days: [1] } });
    const marks = weekMarks(h, "2026-08-26");
    const byDay = Object.fromEntries(marks.map((m) => [m.ymd, m.mark]));
    expect(byDay["2026-08-25"]).toBe("off");
    expect(byDay["2026-08-24"]).toBe("missed"); // 周一该做没做
  });

  it("永远是 7 格", () => {
    expect(weekMarks(habit({ title: "x" }), MON)).toHaveLength(7);
  });
});

describe("完成率", () => {
  it("最近 7 天做了 3 次该做的 6 次（今天没做不计入分母）", () => {
    const h = habit({
      title: "喝水",
      checkIns: ["2026-08-19", "2026-08-21", "2026-08-23"],
    });
    const r = recentRate(h, 7, MON);
    expect(r).toEqual({ done: 3, due: 6 }); // 8-18..8-23 共 6 天，今天不算
  });

  it("一天都不该做时返回 null，不硬算出个 0%", () => {
    const h = habit({ title: "月结", repeat: { kind: "monthly", day: 15 } });
    expect(recentRate(h, 3, MON)).toBeNull();
  });
});

describe("打卡开关", () => {
  it("同一天点两次 = 撤销", () => {
    expect(toggleCheck([], MON)).toEqual([MON]);
    expect(toggleCheck([MON], MON)).toEqual([]);
  });

  it("永远保持升序", () => {
    expect(toggleCheck(["2026-08-25"], "2026-08-20")).toEqual(["2026-08-20", "2026-08-25"]);
  });

  it("脏数据洗干净：非法日期、重复、乱序", () => {
    expect(normalizeCheckIns(["2026-08-02", "不是日期", "2026-08-01", "2026-08-01", 5])).toEqual([
      "2026-08-01",
      "2026-08-02",
    ]);
    expect(normalizeCheckIns(null)).toEqual([]);
  });
});

describe("store 里的习惯", () => {
  it("新建习惯默认每天，且不排期（习惯不逾期）", () => {
    const id = addHabit({ title: "喝水" });
    const h = getTask(id);
    expect(h.kind).toBe("habit");
    expect(h.repeat).toEqual({ kind: "daily", every: 1 });
    expect(h.due).toBeNull();
    expect(h.reminder).toBeNull();
    expect(h.checkIns).toEqual([]);
  });

  it("习惯不会出现在今天/计划/全部这些普通事的视图里", () => {
    addTask({ title: "普通事", due: MON });
    addHabit({ title: "喝水" });
    const d = appStore.getState().data;
    expect(aliveTasks(d).map((t) => t.title)).toEqual(["普通事"]);
    expect(aliveHabits(d).map((t) => t.title)).toEqual(["喝水"]);
    expect(openRows(d).map((r) => r.task.title)).toEqual(["普通事"]);
  });

  it("勾一个习惯 = 打今天的卡，不是「完成」", () => {
    const id = addHabit({ title: "喝水" });
    completeTask(id);
    const h = getTask(id);
    expect(h.done).toBe(false);
    expect(h.doneAt).toBeNull();
    expect(h.checkIns).toHaveLength(1);
    // 再勾一次撤销
    completeTask(id);
    expect(getTask(id).checkIns).toEqual([]);
  });

  it("侧栏那个数字 = 今天该做还没做的个数", () => {
    const a = addHabit({ title: "喝水" });
    addHabit({ title: "背单词" });
    addHabit({ title: "健身", repeat: { kind: "weekly", days: [0] } }); // 周日，今天多半不该做
    const today = "2026-08-24"; // 周一
    expect(habitsOpenToday(appStore.getState().data, today)).toBe(2);
    toggleHabitCheck(a, today);
    expect(habitsOpenToday(appStore.getState().data, today)).toBe(1);
  });

  it("改周期：传 null 退回每天，不会变成「没有周期的习惯」", () => {
    const id = addHabit({ title: "喝水", repeat: { kind: "workday" } });
    setHabitRepeat(id, null);
    expect(getTask(id).repeat).toEqual({ kind: "daily", every: 1 });
  });

  it("普通事转习惯：清掉排期，补上周期；转回来清掉打卡记录", () => {
    const id = addTask({ title: "跑步", due: MON, dueTime: "07:00" });
    setTaskKind(id, "habit");
    let t = getTask(id);
    expect(t.kind).toBe("habit");
    expect(t.due).toBeNull();
    expect(t.dueTime).toBeNull();
    expect(t.repeat).toEqual({ kind: "daily", every: 1 });

    toggleHabitCheck(id, MON);
    expect(getTask(id).checkIns).toEqual([MON]);
    setTaskKind(id, "task");
    t = getTask(id);
    expect(t.kind).toBe("task");
    expect(t.checkIns).toEqual([]);
  });
});

describe("排序与文案", () => {
  it("今天该打没打的排最前，打过的沉下去，今天不用做的垫底", () => {
    const todo = habit({ title: "待打卡" });
    const done = habit({ title: "已打卡", checkIns: [MON] });
    const off = habit({ title: "今天不用", repeat: { kind: "weekly", days: [0] } });
    const sorted = sortHabitsForDay([off, done, todo], MON);
    expect(sorted.map((h) => h.title)).toEqual(["待打卡", "已打卡", "今天不用"]);
  });

  it("周期说人话", () => {
    const say = (r: RepeatRule) => describeHabitRule(habit({ title: "x", repeat: r }));
    expect(say({ kind: "daily", every: 1 })).toBe("每天");
    expect(say({ kind: "daily", every: 3 })).toBe("每 3 天");
    expect(say({ kind: "workday" })).toBe("每个工作日");
    expect(say({ kind: "weekly", days: [1, 3, 5] })).toBe("每周一、三、五");
    expect(say({ kind: "monthly", day: 8 })).toBe("每月 8 号");
  });

  it("月历格子：天数对得上，状态分得清", () => {
    const h = habit({ title: "喝水", checkIns: ["2026-08-01", "2026-08-24"] });
    const marks = monthMarks(h, "2026-08-15", MON);
    expect(marks).toHaveLength(31);
    expect(marks[0]).toEqual({ ymd: "2026-08-01", mark: "done" });
    expect(marks[1].mark).toBe("missed");
    expect(marks[23]).toEqual({ ymd: "2026-08-24", mark: "done" });
    expect(marks[24].mark).toBe("future");
  });
});

describe("老数据升上来", () => {
  it("v4 的任务一律是普通事，不会被误判成习惯", () => {
    const d = migrate({
      version: 4,
      tasks: [{ id: "t1", title: "旧任务", repeat: { kind: "daily", every: 1 }, subtasks: [] }],
    });
    expect(d.tasks[0].kind).toBe("task");
    expect(d.tasks[0].checkIns).toEqual([]);
  });

  it("已经是习惯的（v5 自己导出的）原样保留", () => {
    const d = migrate({
      version: 5,
      tasks: [{ id: "h1", title: "喝水", kind: "habit", checkIns: ["2026-08-01"], subtasks: [] }],
    });
    expect(d.tasks[0].kind).toBe("habit");
    expect(d.tasks[0].checkIns).toEqual(["2026-08-01"]);
  });
});

describe("doneOn 小工具", () => {
  it("就是查数组", () => {
    const h = habit({ title: "x", checkIns: [MON] });
    expect(doneOn(h, MON)).toBe(true);
    expect(doneOn(h, "2026-08-23")).toBe(false);
  });
});
