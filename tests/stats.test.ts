import { describe, it, expect } from "vitest";
import {
  localDateOfISO,
  completionByDay,
  addedByDay,
  byList,
  byWho,
  focusByDay,
  weeklyReview,
  exportWeekMarkdown,
} from "../src/core/stats";
import { newTask, type Task, type List, type FocusSession } from "../src/core/model";
import { pad2 } from "../src/core/dates";

// ---- 测试工具：不依赖真实"现在"，所有时刻都从指定的本地年月日构造 ----

/** 本地 (y,m,d,h,mi) → ISO（Z 结尾），换回本地即原日期，跨时区机器上结果一致 */
function isoLocal(y: number, mo: number, d: number, h = 12, mi = 0): string {
  return new Date(y, mo - 1, d, h, mi).toISOString();
}

/** 当前机器在指定时刻的时区偏移串，如 '+08:00' */
function offsetStr(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const a = Math.abs(off);
  return `${sign}${pad2(Math.floor(a / 60))}:${pad2(a % 60)}`;
}

function task(p: Partial<Task> & { title: string }): Task {
  return newTask({ createdAt: isoLocal(2026, 8, 1), ...p });
}

const LISTS: List[] = [
  { id: "L2", name: "生活", color: "moss", order: 1 },
  { id: "L1", name: "工作", color: "clay", order: 0 },
];

// 2026-08-10 是周一，2026-08-16 是周日
const WS = "2026-08-10";
const WE = "2026-08-16";

describe("localDateOfISO", () => {
  it("Z 结尾的 UTC 写法归到本地日期", () => {
    expect(localDateOfISO(isoLocal(2026, 8, 10, 23, 30))).toBe("2026-08-10");
    expect(localDateOfISO(isoLocal(2026, 8, 10, 0, 15))).toBe("2026-08-10");
  });

  it("带显式时区偏移的写法归到本地日期", () => {
    const d = new Date(2026, 7, 10, 23, 30);
    const iso = `2026-08-10T23:30:00${offsetStr(d)}`;
    expect(localDateOfISO(iso)).toBe("2026-08-10");
  });
});

describe("completionByDay", () => {
  const tasks: Task[] = [
    task({ title: "a", done: true, doneAt: isoLocal(2026, 8, 10, 9) }),
    task({ title: "b", done: true, doneAt: isoLocal(2026, 8, 10, 20) }),
    task({ title: "c", done: true, doneAt: isoLocal(2026, 8, 16, 23, 59) }),
    task({ title: "范围外", done: true, doneAt: isoLocal(2026, 8, 17, 0, 1) }),
    task({ title: "未完成", done: false }),
    task({ title: "已删除", done: true, doneAt: isoLocal(2026, 8, 12), deletedAt: isoLocal(2026, 8, 13) }),
  ];

  it("每天都有条目且 0 也保留，端点含入", () => {
    const r = completionByDay(tasks, WS, WE);
    expect(r).toHaveLength(7);
    expect(r[0]).toEqual({ date: "2026-08-10", count: 2 });
    expect(r[6]).toEqual({ date: "2026-08-16", count: 1 });
    expect(r[1]).toEqual({ date: "2026-08-11", count: 0 });
  });

  it("不统计未完成、已删除、区间外的任务", () => {
    const total = completionByDay(tasks, WS, WE).reduce((s, x) => s + x.count, 0);
    expect(total).toBe(3);
  });

  it("跨月区间逐日展开且日期正确", () => {
    const t = [task({ title: "x", done: true, doneAt: isoLocal(2026, 9, 1, 10) })];
    const r = completionByDay(t, "2026-08-28", "2026-09-03");
    expect(r).toHaveLength(7);
    expect(r.map((x) => x.date)).toEqual([
      "2026-08-28", "2026-08-29", "2026-08-30", "2026-08-31",
      "2026-09-01", "2026-09-02", "2026-09-03",
    ]);
    expect(r[4].count).toBe(1);
  });

  it("空任务列表输出全零骨架", () => {
    const r = completionByDay([], WS, WE);
    expect(r).toHaveLength(7);
    expect(r.every((x) => x.count === 0)).toBe(true);
  });

  it("done 为 true 但 doneAt 为 null 时安全跳过", () => {
    const r = completionByDay([task({ title: "脏数据", done: true, doneAt: null })], WS, WE);
    expect(r.every((x) => x.count === 0)).toBe(true);
  });
});

describe("addedByDay", () => {
  it("按 createdAt 归日，回收站的也算新增", () => {
    const tasks = [
      task({ title: "a", createdAt: isoLocal(2026, 8, 10, 8) }),
      task({ title: "b（已删）", createdAt: isoLocal(2026, 8, 10, 9), deletedAt: isoLocal(2026, 8, 11) }),
      task({ title: "c", createdAt: isoLocal(2026, 8, 16, 22) }),
    ];
    const r = addedByDay(tasks, WS, WE);
    expect(r[0]).toEqual({ date: "2026-08-10", count: 2 });
    expect(r[6]).toEqual({ date: "2026-08-16", count: 1 });
  });

  it("区间外的创建不计入，空数据出全零骨架", () => {
    const r = addedByDay([task({ title: "早", createdAt: isoLocal(2026, 8, 1) })], WS, WE);
    expect(r).toHaveLength(7);
    expect(r.every((x) => x.count === 0)).toBe(true);
  });
});

describe("byList", () => {
  const tasks: Task[] = [
    task({ title: "w1", listId: "L1", done: true, doneAt: isoLocal(2026, 8, 11) }),
    task({ title: "w2", listId: "L1", done: true, doneAt: isoLocal(2026, 8, 1) }), // 区间外完成
    task({ title: "w3", listId: "L1", done: false }),
    task({ title: "inbox1", listId: null, done: false }),
    task({ title: "inbox2（已删）", listId: null, done: false, deletedAt: isoLocal(2026, 8, 12) }),
  ];

  it("随手记第一行 id=null，清单按 order 升序，全零清单也出现", () => {
    const r = byList(tasks, LISTS, WS, WE);
    expect(r.map((x) => x.name)).toEqual(["随手记", "工作", "生活"]);
    expect(r[0].id).toBeNull();
    expect(r[2]).toEqual({ id: "L2", name: "生活", done: 0, open: 0 });
  });

  it("done 只看 doneAt 落区间；open 不看区间；已删除两边都不算", () => {
    const r = byList(tasks, LISTS, WS, WE);
    const work = r.find((x) => x.id === "L1")!;
    expect(work.done).toBe(1); // w2 区间外不算
    expect(work.open).toBe(1);
    const inbox = r.find((x) => x.id === null)!;
    expect(inbox).toEqual({ id: null, name: "随手记", done: 0, open: 1 });
  });

  it("空任务时每个清单加随手记都在且全零", () => {
    const r = byList([], LISTS, WS, WE);
    expect(r).toHaveLength(3);
    expect(r.every((x) => x.done === 0 && x.open === 0)).toBe(true);
  });
});

describe("byWho", () => {
  const tasks: Task[] = [
    task({ title: "a", who: ["李哥"], done: true, doneAt: isoLocal(2026, 8, 11) }),
    task({ title: "b", who: ["李哥"], done: true, doneAt: isoLocal(2026, 8, 12) }),
    task({ title: "c", who: ["李哥"], done: false }),
    task({ title: "d", who: ["王姐"], done: true, doneAt: isoLocal(2026, 8, 13) }),
    task({ title: "e", who: ["王姐"], done: true, doneAt: isoLocal(2026, 8, 1) }), // 区间外
    task({ title: "无需求方", done: true, doneAt: isoLocal(2026, 8, 11) }),
    task({ title: "只在回收站", who: ["赵总"], done: false, deletedAt: isoLocal(2026, 8, 12) }),
  ];

  it("只含出现过需求方的任务，按 done 降序", () => {
    const r = byWho(tasks, WS, WE);
    expect(r.map((x) => x.who)).toEqual(["李哥", "王姐"]);
    expect(r[0]).toEqual({ who: "李哥", done: 2, open: 1 });
    expect(r[1]).toEqual({ who: "王姐", done: 1, open: 0 });
  });

  it("需求方只出现在已删除任务上时不出现；空数据返回空数组", () => {
    expect(byWho(tasks, WS, WE).find((x) => x.who === "赵总")).toBeUndefined();
    expect(byWho([], WS, WE)).toEqual([]);
  });
});

describe("focusByDay", () => {
  const sessions: FocusSession[] = [
    { taskId: null, date: "2026-08-10", minutes: 25, startedAt: isoLocal(2026, 8, 10, 9) },
    { taskId: "t1", date: "2026-08-10", minutes: 50, startedAt: isoLocal(2026, 8, 10, 14) },
    { taskId: "t1", date: "2026-08-16", minutes: 25, startedAt: isoLocal(2026, 8, 16, 21) },
    { taskId: null, date: "2026-08-17", minutes: 25, startedAt: isoLocal(2026, 8, 17, 9) },
  ];

  it("同日多段累加，端点含入，区间外不算", () => {
    const r = focusByDay(sessions, WS, WE);
    expect(r).toHaveLength(7);
    expect(r[0]).toEqual({ date: "2026-08-10", minutes: 75 });
    expect(r[6]).toEqual({ date: "2026-08-16", minutes: 25 });
    expect(r[3].minutes).toBe(0);
  });

  it("空 sessions 输出全零骨架", () => {
    const r = focusByDay([], WS, WE);
    expect(r).toHaveLength(7);
    expect(r.every((x) => x.minutes === 0)).toBe(true);
  });
});

describe("weeklyReview", () => {
  const tasks: Task[] = [
    task({ title: "完成A", listId: "L1", who: ["李哥"], done: true, doneAt: isoLocal(2026, 8, 11, 10) }),
    task({ title: "完成B", listId: "L1", done: true, doneAt: isoLocal(2026, 8, 12, 15) }),
    task({ title: "完成C", listId: null, done: true, doneAt: isoLocal(2026, 8, 16, 23) }),
    task({ title: "上周完成", listId: "L1", done: true, doneAt: isoLocal(2026, 8, 9, 10) }),
    task({ title: "删了的完成", done: true, doneAt: isoLocal(2026, 8, 12), deletedAt: isoLocal(2026, 8, 13) }),
    task({ title: "逾期未清", due: "2026-08-05", done: false }),
    task({ title: "周日到期未清", due: "2026-08-16", done: false }),
    task({ title: "下周才到期", due: "2026-08-17", done: false }),
    task({ title: "顺延大王", due: "2026-08-14", done: false, postponeCount: 3 }),
    task({ title: "顺延过但完成了", done: true, doneAt: isoLocal(2026, 8, 13), postponeCount: 2, listId: "L2" }),
  ];
  const sessions: FocusSession[] = [
    { taskId: null, date: "2026-08-10", minutes: 50, startedAt: isoLocal(2026, 8, 10, 9) },
    { taskId: null, date: "2026-08-16", minutes: 40, startedAt: isoLocal(2026, 8, 16, 9) },
    { taskId: null, date: "2026-08-17", minutes: 999, startedAt: isoLocal(2026, 8, 17, 9) },
  ];
  const r = weeklyReview(tasks, sessions, LISTS, WS);

  it("周界正确，传周中任意一天也归一化到周一", () => {
    expect(r.weekStart).toBe(WS);
    expect(r.weekEnd).toBe(WE);
    const r2 = weeklyReview(tasks, sessions, LISTS, "2026-08-13");
    expect(r2.weekStart).toBe(WS);
    expect(r2.weekEnd).toBe(WE);
  });

  it("completed 只含本周完成且未删除的", () => {
    const titles = r.completed.map((t) => t.title);
    expect(titles).toHaveLength(4);
    expect(titles).toContain("完成A");
    expect(titles).toContain("完成C");
    expect(titles).not.toContain("上周完成");
    expect(titles).not.toContain("删了的完成");
  });

  it("stillOpen 含逾期与本周到期，不含下周的", () => {
    const titles = r.stillOpen.map((t) => t.title);
    expect(titles).toEqual(["逾期未清", "顺延大王", "周日到期未清"]); // 按 due 升序
  });

  it("postponed 只含未完成且顺延过的", () => {
    expect(r.postponed.map((t) => t.title)).toEqual(["顺延大王"]);
  });

  it("focusMinutes 只累计本周", () => {
    expect(r.focusMinutes).toBe(90);
  });

  it("perList 只统计本周完成、全零不出现、done 降序；perWho 同理", () => {
    // 同为 1 条时按名字排：生活 < 随手记
    expect(r.perList).toEqual([
      { name: "工作", done: 2 },
      { name: "生活", done: 1 },
      { name: "随手记", done: 1 },
    ]);
    expect(r.perWho).toEqual([{ who: "李哥", done: 1 }]);
  });

  it("completed 排列与 perList 分组顺序一致（供导出切片还原）", () => {
    let i = 0;
    const nameOf = (id: string | null) =>
      id === null ? "随手记" : (LISTS.find((l) => l.id === id)?.name ?? "随手记");
    for (const g of r.perList) {
      for (const t of r.completed.slice(i, i + g.done)) {
        expect(nameOf(t.listId)).toBe(g.name);
      }
      i += g.done;
    }
    expect(i).toBe(r.completed.length);
  });

  it("空数据出空回顾", () => {
    const e = weeklyReview([], [], [], WS);
    expect(e.completed).toEqual([]);
    expect(e.stillOpen).toEqual([]);
    expect(e.postponed).toEqual([]);
    expect(e.focusMinutes).toBe(0);
    expect(e.perList).toEqual([]);
    expect(e.perWho).toEqual([]);
  });

  it("周日深夜完成的（ISO 带时区）仍归本周", () => {
    const t = [task({ title: "压哨", done: true, doneAt: isoLocal(2026, 8, 16, 23, 59) })];
    expect(weeklyReview(t, [], LISTS, WS).completed.map((x) => x.title)).toEqual(["压哨"]);
  });
});

describe("exportWeekMarkdown", () => {
  const tasks: Task[] = [
    task({ title: "写周报", listId: "L1", who: ["李哥"], done: true, doneAt: isoLocal(2026, 8, 11, 10) }),
    task({ title: "修 bug", listId: "L1", done: true, doneAt: isoLocal(2026, 8, 12, 15) }),
    task({ title: "买猫粮", listId: "L2", done: true, doneAt: isoLocal(2026, 8, 13, 20) }),
    task({ title: "报销单", due: "2026-08-12", done: false }),
    task({ title: "健身计划", due: "2026-08-15", done: false, postponeCount: 4 }),
  ];
  const sessions: FocusSession[] = [
    { taskId: null, date: "2026-08-11", minutes: 100, startedAt: isoLocal(2026, 8, 11, 9) },
    { taskId: null, date: "2026-08-13", minutes: 25, startedAt: isoLocal(2026, 8, 13, 9) },
  ];
  const md = exportWeekMarkdown(weeklyReview(tasks, sessions, LISTS, WS));

  it("标题含几月几日区间", () => {
    expect(md).toContain("8月10日");
    expect(md).toContain("8月16日");
  });

  it("完成一节：件数、按清单分组、条目落在对的组里", () => {
    expect(md).toContain("✅ 本周完成 3 件");
    expect(md).toContain("### 工作（2 件）");
    expect(md).toContain("### 生活（1 件）");
    expect(md).toContain("- 写周报");
    expect(md).toContain("- 修 bug");
    const life = md.slice(md.indexOf("### 生活"));
    expect(life).toContain("- 买猫粮");
    expect(life).not.toContain("- 写周报");
  });

  it("未清一节含逾期天数", () => {
    expect(md).toContain("⏳ 未清 2 件");
    expect(md).toContain("- 报销单（逾期 4 天）");
    expect(md).toContain("- 健身计划（逾期 1 天）");
  });

  it("反复顺延一节含次数", () => {
    expect(md).toContain("🔁 反复顺延");
    expect(md).toContain("健身计划（顺延 4 次");
  });

  it("专注合计按小时分钟展示", () => {
    expect(md).toContain("🍅 专注合计 2 小时 5 分钟");
  });

  it("需求方一节有数据才出现", () => {
    expect(md).toContain("按需求方");
    expect(md).toContain("- 李哥：1 件");
    const noWho = exportWeekMarkdown(
      weeklyReview([task({ title: "x", done: true, doneAt: isoLocal(2026, 8, 11) })], [], LISTS, WS),
    );
    expect(noWho).not.toContain("按需求方");
  });

  it("整分钟数为整小时/不足一小时时的展示", () => {
    const h2 = exportWeekMarkdown(
      weeklyReview([], [{ taskId: null, date: "2026-08-11", minutes: 120, startedAt: isoLocal(2026, 8, 11, 9) }], [], WS),
    );
    expect(h2).toContain("🍅 专注合计 2 小时");
    const m30 = exportWeekMarkdown(
      weeklyReview([], [{ taskId: null, date: "2026-08-11", minutes: 30, startedAt: isoLocal(2026, 8, 11, 9) }], [], WS),
    );
    expect(m30).toContain("🍅 专注合计 30 分钟");
  });

  it("空周优雅兜底", () => {
    const md0 = exportWeekMarkdown(weeklyReview([], [], [], WS));
    expect(md0).toContain("8月10日");
    expect(md0).toContain("本周没有记录");
    expect(md0).not.toContain("✅");
  });

  it("周到期但未逾期的未清条目不显示逾期天数", () => {
    const mdDue = exportWeekMarkdown(
      weeklyReview([task({ title: "周日交", due: "2026-08-16", done: false })], [], [], WS),
    );
    expect(mdDue).toContain("- 周日交（本周到期）");
  });
});
