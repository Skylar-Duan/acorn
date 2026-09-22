// 习惯页不许只剩「今天要做的」（用户 2026-09-21）：
// 「我添加的重复计划每月“同步一次”在里面看不到，我要在里面就跟计划界面一样全部放上，
//  而不是只显示今天的，右侧显示下一次的时间」。
// 这里钉三件事：哪些计划算「重复的计划」、按什么排；习惯的「下一次」是哪天、怎么说；
// 页面上三组都在，重复的计划那几行就是计划页那一行（勾完成推到下一次）。
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { appStore, completeTask, updateSubtask } from "../src/core/store";
import { defaultData, newTask } from "../src/core/model";
import type { Subtask, Task } from "../src/core/model";
import { describeNextDay, nextHabitDay, sortHabitsByNext } from "../src/core/habits";
import { repeatingRows } from "../src/core/repeating";
import { todayYMD, addDays } from "../src/core/dates";

// 2026-08-24 是周一
const MON = "2026-08-24";

function habit(partial: Partial<Task> & { title: string }): Task {
  return newTask({ kind: "habit", repeat: { kind: "daily", every: 1 }, createdAt: "2026-08-01T00:00:00.000Z", ...partial });
}

function sub(partial: Partial<Subtask> & { title: string }): Subtask {
  return { id: `s-${partial.title}`, done: false, ...partial };
}

const data = (tasks: Task[]) => ({ tasks });
const names = (rows: ReturnType<typeof repeatingRows>) =>
  rows.map((r) => (r.sub ? `${r.task.title} › ${r.sub.title}` : r.task.title));

beforeEach(() => {
  localStorage.removeItem("acorn-data");
  appStore.setState({ data: defaultData(), loaded: true, loadError: null });
});

describe("重复的计划：哪些算", () => {
  it("带循环、没做完、没放弃、没删的计划全算，不管下一次是不是今天", () => {
    const rows = repeatingRows(data([
      newTask({ title: "同步一次", repeat: { kind: "monthly", day: 1 }, due: "2026-10-01" }),
      newTask({ title: "周报", repeat: { kind: "weekly", days: [5] }, due: MON }),
      newTask({ title: "只做一次", due: MON }),
      newTask({ title: "做完的循环", repeat: { kind: "daily", every: 1 }, due: MON, done: true, doneAt: "2026-08-24T01:00:00.000Z" }),
      newTask({ title: "放弃的循环", repeat: { kind: "daily", every: 1 }, due: MON, droppedAt: "2026-08-24T01:00:00.000Z" }),
      newTask({ title: "删掉的循环", repeat: { kind: "daily", every: 1 }, due: MON, deletedAt: "2026-08-24T01:00:00.000Z" }),
      // 习惯在本页自己那两组里，不重复进「重复的计划」
      habit({ title: "喝水" }),
    ]));
    expect(names(rows)).toEqual(["周报", "同步一次"]);
  });

  it("带自己循环的子任务单独一行「母 › 子」，母任务不带循环也算；没循环 / 做完 / 放弃 / 删掉的那几步不算", () => {
    const rows = repeatingRows(data([
      newTask({
        title: "家务",
        due: "2026-09-30",
        subtasks: [
          sub({ title: "大扫除", repeat: { kind: "weekly", days: [6] }, due: "2026-08-29" }),
          sub({ title: "买拖把" }),
          sub({ title: "洗窗帘", repeat: { kind: "monthly", day: 1 }, due: "2026-09-01", done: true }),
          sub({ title: "擦玻璃", repeat: { kind: "monthly", day: 1 }, due: "2026-09-01", droppedAt: "2026-08-24T01:00:00.000Z" }),
          sub({ title: "晒被子", repeat: { kind: "monthly", day: 1 }, due: "2026-09-01", deletedAt: "2026-08-24T01:00:00.000Z" }),
        ],
      }),
    ]));
    expect(names(rows)).toEqual(["家务 › 大扫除"]);
    expect(rows[0].sub?.id).toBe("s-大扫除");
  });

  it("整件事带循环、又有子任务的：只占母任务那一行（它自己带循环的那一步另起一行）", () => {
    const rows = repeatingRows(data([
      newTask({
        title: "月底对账",
        repeat: { kind: "monthly", day: 31 },
        due: "2026-08-31",
        subtasks: [sub({ title: "导出流水" }), sub({ title: "每周核一次", repeat: { kind: "weekly", days: [1] }, due: "2026-08-24" })],
      }),
    ]));
    expect(names(rows)).toEqual(["月底对账 › 每周核一次", "月底对账"]);
    expect(rows[1].sub).toBeNull();
  });

  it("母任务做完 / 放弃了，它底下带循环的那一步也不出现", () => {
    const rows = repeatingRows(data([
      newTask({ title: "旧项目", done: true, doneAt: "2026-08-20T01:00:00.000Z", subtasks: [sub({ title: "周会", repeat: { kind: "weekly", days: [1] }, due: MON })] }),
      newTask({ title: "搁置的", droppedAt: "2026-08-20T01:00:00.000Z", subtasks: [sub({ title: "周会", repeat: { kind: "weekly", days: [1] }, due: MON })] }),
    ]));
    expect(rows).toEqual([]);
  });
});

describe("重复的计划：按下一次排", () => {
  it("日子早的在上，同一天写了钟点的在前，没排日子的沉底", () => {
    const rows = repeatingRows(data([
      newTask({ title: "没日子", repeat: { kind: "daily", every: 1 } }),
      newTask({ title: "下个月", repeat: { kind: "monthly", day: 1 }, due: "2026-09-01" }),
      newTask({ title: "明天没钟点", repeat: { kind: "daily", every: 1 }, due: "2026-08-25" }),
      newTask({ title: "明天九点", repeat: { kind: "daily", every: 1 }, due: "2026-08-25", dueTime: "09:00" }),
      newTask({ title: "过期的", repeat: { kind: "weekly", days: [1] }, due: "2026-08-17" }),
      newTask({ title: "子任务继承母任务日子", due: "2026-08-26", subtasks: [sub({ title: "跟着", repeat: { kind: "daily", every: 1 } })] }),
    ]));
    expect(names(rows)).toEqual(["过期的", "明天九点", "明天没钟点", "子任务继承母任务日子 › 跟着", "下个月", "没日子"]);
  });
});

describe("习惯的下一次", () => {
  it("今天该做还没打 → 今天；今天打过了 → 往后第一个该做的日子", () => {
    const h = habit({ title: "健身", repeat: { kind: "weekly", days: [1, 3, 5] } });
    expect(nextHabitDay(h, MON)).toBe(MON);
    const done = habit({ title: "健身", repeat: { kind: "weekly", days: [1, 3, 5] }, checkIns: [MON] });
    expect(nextHabitDay(done, MON)).toBe("2026-08-26");
  });

  it("今天轮不到 → 往后第一个该做的日子（每月 1 号的到下个月）", () => {
    expect(nextHabitDay(habit({ title: "周末跑", repeat: { kind: "weekly", days: [6] } }), MON)).toBe("2026-08-29");
    expect(nextHabitDay(habit({ title: "月结", repeat: { kind: "monthly", day: 1 } }), MON)).toBe("2026-09-01");
    // 工作日的习惯周六打开：下一次是周一
    expect(nextHabitDay(habit({ title: "背单词", repeat: { kind: "workday" } }), "2026-08-29")).toBe("2026-08-31");
  });

  it("每周几一个都没勾的坏数据：找不到就返回 null，界面上不写", () => {
    expect(nextHabitDay(habit({ title: "坏", repeat: { kind: "weekly", days: [] } }), MON)).toBeNull();
  });

  it("怎么说：今天 / 明天 / 后天 / 一周内说星期几 / 再远说日子，跨年带年份", () => {
    expect(describeNextDay(MON, MON)).toBe("今天");
    expect(describeNextDay("2026-08-25", MON)).toBe("明天");
    expect(describeNextDay("2026-08-26", MON)).toBe("后天");
    expect(describeNextDay("2026-08-27", MON)).toBe("周四");
    expect(describeNextDay("2026-08-30", MON)).toBe("周日");
    expect(describeNextDay("2026-08-31", MON)).toBe("8月31日");
    expect(describeNextDay("2026-10-01", MON)).toBe("10月1日");
    expect(describeNextDay("2027-01-01", "2026-12-28")).toBe("周五"); // 一周内跨年照样说星期几
    expect(describeNextDay("2027-01-10", "2026-12-28")).toBe("2027年1月10日");
  });

  it("今天不用做的那一组按下一次先后排，明天就轮到的在上", () => {
    const monthly = habit({ title: "月结", repeat: { kind: "monthly", day: 1 } });
    const sat = habit({ title: "周末跑", repeat: { kind: "weekly", days: [6] } });
    const tue = habit({ title: "周二读书", repeat: { kind: "weekly", days: [2] } });
    expect(sortHabitsByNext([monthly, sat, tue], MON).map((h) => h.title)).toEqual(["周二读书", "周末跑", "月结"]);
  });
});

describe("重复的计划那一行勾完成：走循环原有的推到下一次，行还在，日期换成下一次", () => {
  it("整件事：勾完成后日期推到下一个落点，照样列在重复的计划里", () => {
    const today = todayYMD();
    const t = newTask({ title: "同步一次", repeat: { kind: "daily", every: 7 }, due: today });
    appStore.setState({ data: { ...defaultData(), tasks: [t] } });
    completeTask(t.id);
    const rows = repeatingRows(appStore.getState().data);
    expect(names(rows)).toEqual(["同步一次"]);
    expect(rows[0].task.due).toBe(addDays(today, 7));
  });

  it("带循环的那一步：勾完成推到下一次，不标完成", () => {
    const today = todayYMD();
    const t = newTask({ title: "家务", subtasks: [sub({ title: "倒垃圾", repeat: { kind: "daily", every: 2 }, due: today })] });
    appStore.setState({ data: { ...defaultData(), tasks: [t] } });
    updateSubtask(t.id, "s-倒垃圾", { done: true });
    const rows = repeatingRows(appStore.getState().data);
    expect(names(rows)).toEqual(["家务 › 倒垃圾"]);
    expect(rows[0].sub?.due).toBe(addDays(today, 2));
    expect(rows[0].sub?.done).toBe(false);
  });
});

describe("页面：三组都在，不只剩今天", () => {
  const src = readFileSync("src/views/Habits.tsx", "utf8").replace(/\r\n/g, "\n");
  const desk = src.slice(src.indexOf('<div className="view-body hb-body">'));
  const mobile = src.slice(src.indexOf('<div className="view-body mhb-body">'), src.indexOf('<div className="view-body hb-body">'));

  it("两端都有「重复的计划」那一组，用的是计划页那套行（RowList），不另写一种行", () => {
    for (const [name, part] of [["桌面", desk], ["手机", mobile]] as const) {
      expect(part, name).toContain('<div className="group-head">重复的计划</div>');
      expect(part, name).toContain("<RowList rows={planRows} fold={NO_FOLD}");
    }
    expect(src).toContain("const planRows = useMemo(() => repeatingRows(data), [data]);");
    // 桌面点开就是计划页那张内嵌任务卡：落点按全局 expandedId 算
    expect(desk).toContain("anchor={planAnchor}");
  });

  it("组的先后：今天要做的 → 重复的计划 → 今天不用做", () => {
    for (const part of [desk, mobile]) {
      const a = part.indexOf("今天要做的");
      const b = part.indexOf("重复的计划</div>");
      const c = part.indexOf("今天不用做</div>");
      expect(a).toBeGreaterThan(-1);
      expect(b).toBeGreaterThan(a);
      expect(c).toBeGreaterThan(b);
    }
  });

  it("习惯行右边写下一次（两端都有），空状态只在习惯和循环计划都没有时出现", () => {
    expect(src).toContain('{next && <span className="hb-next">{next}</span>}');
    expect(src).toContain('{next && <span className="mhb-next">{next}</span>}');
    expect(desk).toContain("{nothing && (");
    expect(mobile).toContain("{nothing && (");
  });
});
