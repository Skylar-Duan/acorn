// v1.4.0 两件事的守卫：
// ① 回收站——侧栏能看见它、条目上的「还剩几天」、单条彻底删除；
// ② 子任务输入框认「明天 15点 !高」，但不认清单/标签/需求方（那几样归母任务）。
import { beforeEach, describe, expect, it } from "vitest";
import {
  addSubtask,
  addTask,
  appStore,
  deleteTasks,
  purgeTask,
  purgeTrash,
  restoreTask,
  trashDaysLeft,
} from "../src/core/store";
import { defaultData } from "../src/core/model";
import type { Task } from "../src/core/model";
import { parseSubtaskInput, SUBTASK_SKIP } from "../src/core/parse";
import { addDays, todayYMD } from "../src/core/dates";

const LS_KEY = "acorn-data";

function getTask(id: string): Task {
  const t = appStore.getState().data.tasks.find((x) => x.id === id);
  if (!t) throw new Error(`task ${id} not found`);
  return t;
}

beforeEach(() => {
  localStorage.removeItem(LS_KEY);
  appStore.setState({ data: defaultData(), loaded: true, loadError: null });
});

describe("回收站", () => {
  it("删掉的事进回收站，不是消失：还在数据里，带删除时刻", () => {
    const id = addTask({ title: "误删的事" });
    deleteTasks([id]);
    const t = getTask(id);
    expect(t.deletedAt).not.toBeNull();
    expect(appStore.getState().data.tasks.filter((x) => x.deletedAt)).toHaveLength(1);
  });

  it("恢复：回到原处，其他字段一个不动", () => {
    const id = addTask({ title: "对账", who: ["李哥"], priority: 3, due: "2026-09-01" });
    deleteTasks([id]);
    restoreTask(id);
    const t = getTask(id);
    expect(t.deletedAt).toBeNull();
    expect(t.who).toEqual(["李哥"]);
    expect(t.priority).toBe(3);
    expect(t.due).toBe("2026-09-01");
  });

  it("彻底删除只清这一条，回收站里其他的还在", () => {
    const a = addTask({ title: "a" });
    const b = addTask({ title: "b" });
    deleteTasks([a, b]);
    purgeTask(a);
    const left = appStore.getState().data.tasks;
    expect(left.map((t) => t.id)).toEqual([b]);
  });

  it("彻底删除不会误伤没进回收站的同一条（id 对上但还活着就不动）", () => {
    const alive = addTask({ title: "还活着" });
    purgeTask(alive);
    expect(getTask(alive).title).toBe("还活着");
  });

  it("清空回收站：只清回收站里的，活着的一条不少", () => {
    const alive = addTask({ title: "活的" });
    const del = addTask({ title: "删的" });
    deleteTasks([del]);
    purgeTrash();
    expect(appStore.getState().data.tasks.map((t) => t.id)).toEqual([alive]);
  });

  it("还剩几天：刚删是 30 天，第 29 天剩 1 天，过期算 0 不算负数", () => {
    const now = new Date("2026-08-21T10:00:00Z").getTime();
    const justNow = new Date(now).toISOString();
    expect(trashDaysLeft(justNow, now)).toBe(30);
    expect(trashDaysLeft(new Date(now - 29 * 86400000).toISOString(), now)).toBe(1);
    expect(trashDaysLeft(new Date(now - 40 * 86400000).toISOString(), now)).toBe(0);
  });
});

describe("子任务便捷输入", () => {
  const NOW = new Date("2026-08-17T09:00:00"); // 周一
  const today = todayYMD(NOW);
  const p = (s: string) => parseSubtaskInput(s, NOW);

  it("认日期", () => {
    const r = p("明天 画趋势图");
    expect(r.due).toBe(addDays(today, 1));
    expect(r.title).toBe("画趋势图");
  });

  it("认时间，只给时间就自己补日期", () => {
    const r = p("15点 画趋势图");
    expect(r.dueTime).toBe("15:00");
    expect(r.due).toBe(today);
    expect(r.title).toBe("画趋势图");
  });

  it("认重要性，中文和感叹号都行", () => {
    expect(p("!高 收尾").priority).toBe(3);
    expect(p("收尾!!!").priority).toBe(3);
    expect(p("！低 收尾").priority).toBe(1);
  });

  it("日期+时间+重要性一起写", () => {
    const r = p("明天 15点 !高 画趋势图");
    expect(r.due).toBe(addDays(today, 1));
    expect(r.dueTime).toBe("15:00");
    expect(r.priority).toBe(3);
    expect(r.title).toBe("画趋势图");
  });

  it("不认清单/标签/需求方：原样留在标题里，不会被悄悄吃掉", () => {
    const r = p("发给 @李哥 的 #材料 /工作");
    expect(r.who).toEqual([]);
    expect(r.tags).toEqual([]);
    expect(r.listName).toBeNull();
    expect(r.title).toBe("发给 @李哥 的 #材料 /工作");
  });

  // v8 起循环也认了（详见 tests/subtask-repeat.test.ts）。这三条原来断言的是「不认」
  it("认循环：「每天」= 每天重复，due 落在第一个落点（今天）", () => {
    const r = p("每天 记录体重");
    expect(r.repeat).toEqual({ kind: "daily", every: 1 });
    expect(r.due).toBe(today);
    expect(r.title).toBe("记录体重");
  });

  it("「每周一」这种：认成每周一重复，首个落点是今天（8-17 本身就是周一）", () => {
    const r = p("每周一 交周报");
    expect(r.repeat).toEqual({ kind: "weekly", days: [1] });
    expect(r.due).toBe(today); // 「周一」按全应用既有口径含今天
    expect(r.title).toBe("交周报");
  });

  it("「每月28号」同理，不留光杆「每月」", () => {
    const r = p("每月28号 交房租");
    expect(r.repeat).toEqual({ kind: "monthly", day: 28 });
    expect(r.due).toBe("2026-08-28");
    expect(r.title).toBe("交房租");
  });

  it("SUBTASK_SKIP 就是这三类，改了这里等于改口径", () => {
    expect(SUBTASK_SKIP).toEqual(["tag", "list", "who"]);
  });
});

describe("addSubtask 带日期/重要性落库", () => {
  it("不给 extra = 继承母任务（存 null）", () => {
    const id = addTask({ title: "写周报", due: "2026-09-01", priority: 2 });
    addSubtask(id, "画趋势图");
    const s = getTask(id).subtasks[0];
    expect(s.due).toBeNull();
    expect(s.dueTime).toBeNull();
    expect(s.priority).toBeNull();
  });

  it("给了就落成子任务自己的", () => {
    const id = addTask({ title: "写周报", due: "2026-09-01", priority: 2 });
    addSubtask(id, "画趋势图", { due: "2026-08-30", dueTime: "15:00", priority: 3 });
    const s = getTask(id).subtasks[0];
    expect(s.due).toBe("2026-08-30");
    expect(s.dueTime).toBe("15:00");
    expect(s.priority).toBe(3);
  });

  it("解析结果直接喂进去：一条命令记全一个子任务", () => {
    const id = addTask({ title: "写周报", due: "2026-09-01", priority: 1 });
    const r = parseSubtaskInput("明天 15点 !高 画趋势图", new Date("2026-08-17T09:00:00"));
    addSubtask(id, r.title, { due: r.due, dueTime: r.dueTime, priority: r.priority || null });
    const s = getTask(id).subtasks[0];
    expect(s.title).toBe("画趋势图");
    expect(s.due).toBe("2026-08-18");
    expect(s.dueTime).toBe("15:00");
    expect(s.priority).toBe(3);
  });
});
