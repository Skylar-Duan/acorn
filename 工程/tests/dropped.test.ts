// 「放弃」：完成之外的第二种收场。这件事不做了，但它没做成。
//
// 三条底线，坏了任何一条这个功能就是负资产：
//   ① **圈圈一点都不动**——放弃只体现在标题旁边那个灰标签上
//   ② 跟 done/doneAt **互斥**：勾完成清放弃，放弃清完成
//   ③ 统计里**单独算一档**，一件都不许并进完成数（不然完成率虚高，那个数字就废了）
//
// 结构性约束（按钮摆在哪、哪个视图把它筛掉了）靠读源码钉住，跟 wipe.test.ts 一个路数。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import taskCardSource from "../src/components/TaskCard.tsx?raw";
import taskRowSource from "../src/components/TaskRow.tsx?raw";
import ctxMenuSource from "../src/components/ContextMenu.tsx?raw";
import sidebarSource from "../src/components/Sidebar.tsx?raw";
import doneViewSource from "../src/views/Done.tsx?raw";
import listViewSource from "../src/views/ListView.tsx?raw";
import calendarSource from "../src/views/Calendar.tsx?raw";
import quadrantSource from "../src/views/Quadrant.tsx?raw";
import remindersSource from "../src/core/reminders.ts?raw";
import { readFileSync } from "node:fs";
import type { AppData, Subtask, Task } from "../src/core/model";
import { defaultData, migrate, newTask } from "../src/core/model";
import { addDays, cmpYMD, dayOfWeek, todayYMD, toYMD, weekStart } from "../src/core/dates";
import { byList, byWho, completionByDay, exportWeekMarkdown, weeklyReview } from "../src/core/stats";
import {
  addSubtask, addTask, allTags, allWho, appStore, completeTask, doneRows, dropSubtask, dropTasks,
  droppedRows, flushSave, openRows, rowDropped, rowDroppedAt, rowDroppedDay, rowTaskIds,
  tasksForToday, toggleSubtask, undo, updateTask,
} from "../src/core/store";

const today = todayYMD();
// 台账（这次收口把「故意没改的」那条撤了，改成写明口径统一）。
// 只能用 node:fs 读：vitest 不处理 .md，`import x from "…md?raw"` 读回来是空串
const modelDoc = readFileSync("docs/数据模型变更.md", "utf8");

function sub(id: string, title: string, patch: Partial<Subtask> = {}): Subtask {
  return { id, title, done: false, due: null, dueTime: null, priority: null, doneAt: null, droppedAt: null, ...patch };
}

function dataOf(...tasks: Task[]): AppData {
  return { ...defaultData(), tasks };
}

const label = (r: { task: { title: string }; sub: Subtask | null }) =>
  r.sub ? `${r.task.title}›${r.sub.title}` : r.task.title;

function getTask(id: string): Task {
  const t = appStore.getState().data.tasks.find((x) => x.id === id);
  if (!t) throw new Error(`task ${id} not found in store`);
  return t;
}

beforeEach(async () => {
  vi.useRealTimers();
  while (appStore.getState().undoDepth > 0) undo();
  await flushSave();
  localStorage.clear();
  appStore.setState({
    data: defaultData(),
    loaded: true,
    loadError: null,
    ui: {
      view: "today", listId: null, who: null, tag: null,
      expandedId: null, selectedIds: [], searchOpen: false, paletteOpen: false, toast: null,
      ctxMenu: null, foldAll: false, foldExcept: [], changelogOpen: false,
    },
    focus: { taskId: null, running: false, endsAt: null, totalMinutes: 0 },
    undoDepth: 0,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// 数据：字段一个都不许漏
// ---------------------------------------------------------------------------

describe("构造与迁移：droppedAt 一律补 null，绝不补「现在」", () => {
  it("新建任务自带 droppedAt: null", () => {
    expect(newTask({ title: "写周报" }).droppedAt).toBeNull();
  });

  it("新加的子任务自带 droppedAt: null（不是 undefined——那会被 JSON.stringify 整个吞掉）", () => {
    const id = addTask({ title: "装修" });
    addSubtask(id, "量尺寸");
    const s = getTask(id).subtasks[0];
    expect("droppedAt" in s).toBe(true);
    expect(s.droppedAt).toBeNull();
  });

  it("老数据升上来：任务和子任务各补一个 null，一件事都没被当成放弃", () => {
    const d = migrate({
      version: 5, lists: [], sessions: [], settings: {},
      tasks: [{
        id: "t1", title: "老任务", kind: "task", checkIns: [], createdAt: "2026-01-02T00:00:00.000Z",
        subtasks: [{ id: "s1", title: "老子任务", done: true }],
      }],
    });
    expect(d.tasks[0].droppedAt).toBeNull();
    expect(d.tasks[0].subtasks[0].droppedAt).toBeNull();
    expect(droppedRows(d)).toEqual([]);
  });

  it("migrate 是幂等的：再过一遍，放弃标记原样留着，不会被抹平", () => {
    const at = "2026-08-20T02:00:00.000Z";
    const once = migrate(dataOf(newTask({ title: "旧提案", droppedAt: at, subtasks: [sub("s1", "调研", { droppedAt: at })] })));
    const twice = migrate(once);
    expect(twice.tasks[0].droppedAt).toBe(at);
    expect(twice.tasks[0].subtasks[0].droppedAt).toBe(at);
  });
});

// ---------------------------------------------------------------------------
// 动作
// ---------------------------------------------------------------------------

describe("放弃一件事", () => {
  it("盖上放弃时刻，done/doneAt 一个字都不动（本来就没勾）", () => {
    const id = addTask({ title: "学法语", due: today });
    dropTasks([id]);
    const t = getTask(id);
    expect(t.droppedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(t.done).toBe(false);
    expect(t.doneAt).toBeNull();
  });

  it("再放弃一次不重复盖戳（幂等），也不白压一层撤销栈", () => {
    const id = addTask({ title: "学法语" });
    dropTasks([id]);
    const first = getTask(id).droppedAt;
    const depth = appStore.getState().undoDepth;
    dropTasks([id]);
    expect(getTask(id).droppedAt).toBe(first);
    expect(appStore.getState().undoDepth).toBe(depth);
  });

  it("取消放弃 → 回到未完成，不是回到已完成", () => {
    const id = addTask({ title: "学法语" });
    dropTasks([id]);
    dropTasks([id], false);
    const t = getTask(id);
    expect(t.droppedAt).toBeNull();
    expect(t.done).toBe(false);
    expect(t.doneAt).toBeNull();
  });

  it("进撤销栈，而且给的是可撤销的提示——「照抄完成时那套」", () => {
    const id = addTask({ title: "学法语" });
    const depth = appStore.getState().undoDepth;
    dropTasks([id]);
    expect(appStore.getState().undoDepth).toBe(depth + 1);
    expect(appStore.getState().ui.toast).toMatchObject({ undoable: true });
    expect(appStore.getState().ui.toast!.msg).toContain("已放弃");
    undo();
    expect(getTask(id).droppedAt).toBeNull();
  });

  it("批量放弃只压一层：toast 说了能撤，就得一下全撤回来", () => {
    const a = addTask({ title: "甲" });
    const b = addTask({ title: "乙" });
    const c = addTask({ title: "丙" });
    const depth = appStore.getState().undoDepth;
    dropTasks([a, b, c]);
    expect(appStore.getState().undoDepth).toBe(depth + 1);
    expect(appStore.getState().ui.toast!.msg).toContain("3 件");
    undo();
    expect([a, b, c].map((id) => getTask(id).droppedAt)).toEqual([null, null, null]);
  });

  it("习惯不给放弃：它不是一件会结束的事，今天不做就是今天没打卡", () => {
    const id = addTask({ title: "喝水" });
    updateTask(id, { kind: "habit" });
    dropTasks([id]);
    expect(getTask(id).droppedAt).toBeNull();
  });
});

describe("互斥：一件事不能既做完了又放弃了", () => {
  it("放弃之后再勾完成 → 放弃标记当场撤掉", () => {
    const id = addTask({ title: "投简历" });
    dropTasks([id]);
    completeTask(id);
    const t = getTask(id);
    expect(t.done).toBe(true);
    expect(t.doneAt).toBeTruthy();
    expect(t.droppedAt).toBeNull();
  });

  it("做完之后再放弃 → 完成状态和完成时刻一起清掉", () => {
    const id = addTask({ title: "投简历" });
    completeTask(id);
    dropTasks([id]);
    const t = getTask(id);
    expect(t.droppedAt).toBeTruthy();
    expect(t.done).toBe(false);
    expect(t.doneAt).toBeNull();
  });

  it("子任务同理，三条路（任务卡 / 列表行 / 右键）共用 applySubPatch 那一层", () => {
    const id = addTask({ title: "装修" });
    addSubtask(id, "量尺寸");
    const subId = getTask(id).subtasks[0].id;

    dropSubtask(id, subId);
    expect(getTask(id).subtasks[0].droppedAt).toBeTruthy();

    toggleSubtask(id, subId); // 勾完成
    expect(getTask(id).subtasks[0].done).toBe(true);
    expect(getTask(id).subtasks[0].droppedAt).toBeNull();

    dropSubtask(id, subId); // 反过来
    expect(getTask(id).subtasks[0].done).toBe(false);
    expect(getTask(id).subtasks[0].doneAt).toBeNull();
    expect(getTask(id).subtasks[0].droppedAt).toBeTruthy();

    dropSubtask(id, subId, false); // 取消放弃：不许顺手把完成状态改回来
    expect(getTask(id).subtasks[0].droppedAt).toBeNull();
    expect(getTask(id).subtasks[0].done).toBe(false);
  });
});

describe("循环任务：放弃 = 这一轮不做了，照样推进到下一轮", () => {
  it("留一条「这一轮放弃了」的副本，本体推到下一个落点，新一轮干干净净", () => {
    const id = addTask({
      title: "周会",
      due: "2026-08-17", // 周一
      dueTime: "09:00",
      repeat: { kind: "weekly", days: [1] },
    });
    addSubtask(id, "写议程");
    const subId = getTask(id).subtasks[0].id;
    dropSubtask(id, subId); // 上一轮里这一步也放弃了
    updateTask(id, { postponeCount: 2 });

    dropTasks([id]);
    const tasks = appStore.getState().data.tasks;
    expect(tasks).toHaveLength(2);

    // 本体：推进到今天之后的下一个周一，放弃标记必须是干净的，否则新一轮一出生就被判死刑
    const advanced = getTask(id);
    expect(advanced.droppedAt).toBeNull();
    expect(advanced.done).toBe(false);
    expect(dayOfWeek(advanced.due!)).toBe(1);
    expect(cmpYMD(advanced.due!, today)).toBeGreaterThan(0);
    expect(advanced.reminder).toBe(`${advanced.due}T09:00`);
    expect(advanced.repeat).toEqual({ kind: "weekly", days: [1] });
    expect(advanced.postponeCount).toBe(0);
    // 子任务的放弃标记也属于上一轮，一并清掉
    expect(advanced.subtasks[0].droppedAt).toBeNull();
    expect(advanced.subtasks[0].done).toBe(false);

    // 副本：那才是历史，原样保留上一轮的样子
    const copy = tasks.find((t) => t.id !== id)!;
    expect(copy.droppedAt).toBeTruthy();
    expect(copy.done).toBe(false); // 放弃不是完成
    expect(copy.doneAt).toBeNull();
    expect(copy.repeat).toBeNull();
    expect(copy.due).toBe("2026-08-17");
    expect(copy.subtasks[0].droppedAt).toBeTruthy();
  });

  it("已完成的循环任务再放弃：新一轮必须是干净的，不许把上一轮的完成状态带进来", () => {
    // 走得通的真实路径：循环任务 → 清掉日期 → 点圆圈完成（走非循环那条路，成了 done+repeat 无 due）
    // → 在「已完成」里重新给它点一个日子 → 右键「放弃」
    const id = addTask({ title: "周会", due: "2026-08-17", repeat: { kind: "weekly", days: [1] } });
    updateTask(id, { due: null });
    completeTask(id);
    updateTask(id, { due: "2026-08-17" });
    expect(getTask(id).done).toBe(true);

    dropTasks([id]);
    const advanced = getTask(id);
    // 本体：这一轮算放弃过了，推进到下一个周一，而且**不再挂着上一轮的完成状态**
    expect(advanced.done).toBe(false);
    expect(advanced.doneAt).toBeNull();
    expect(advanced.droppedAt).toBeNull();
    expect(dayOfWeek(advanced.due!)).toBe(1);
    expect(cmpYMD(advanced.due!, today)).toBeGreaterThan(0);

    // 副本：那才是「这一轮放弃了」的历史，一样不许算成完成
    const copy = appStore.getState().data.tasks.find((t) => t.id !== id)!;
    expect(copy.droppedAt).toBeTruthy();
    expect(copy.done).toBe(false);
    expect(copy.doneAt).toBeNull();

    // 整份数据里一件「已完成」都不该剩下——放弃了就不是做完了
    expect(doneRows(appStore.getState().data)).toEqual([]);
    expect(droppedRows(appStore.getState().data).map(label)).toEqual(["周会"]);
  });

  it("没有日期的循环任务不推进，就地放弃（跟完成那边同口径）", () => {
    const id = addTask({ title: "随时想起就做", repeat: { kind: "daily", every: 1 } });
    updateTask(id, { due: null });
    dropTasks([id]);
    expect(appStore.getState().data.tasks).toHaveLength(1);
    expect(getTask(id).droppedAt).toBeTruthy();
  });

  it("完成那条路推进后同样把新一轮的 droppedAt 清成 null（两处是双胞胎）", () => {
    const id = addTask({ title: "周会", due: "2026-08-17", repeat: { kind: "weekly", days: [1] } });
    dropTasks([id]); // 先放弃一轮，本体推进了一次
    const first = getTask(id).due;
    completeTask(id); // 再完成一轮
    const advanced = getTask(id);
    expect(advanced.droppedAt).toBeNull();
    expect(cmpYMD(advanced.due!, first!)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 去哪：从待办里退出，归宿是「已完成」
// ---------------------------------------------------------------------------

describe("openRows：放弃的不再出现在待办里", () => {
  it("整件事放弃 → 一行都不出", () => {
    const t = newTask({ title: "学法语", due: today, droppedAt: "2026-08-20T02:00:00.000Z" });
    expect(openRows(dataOf(t))).toEqual([]);
  });

  it("只放弃了其中一步 → 那一步不出现在「下一步」里，其余照旧", () => {
    const t = newTask({
      title: "装修", due: today,
      subtasks: [sub("s1", "量尺寸", { droppedAt: "2026-08-20T02:00:00.000Z" }), sub("s2", "选瓷砖")],
    });
    expect(openRows(dataOf(t)).map(label)).toEqual(["装修›选瓷砖"]);
  });

  it("每一步都放弃了 → 母任务行回来收尾（这件事本身还没了结）", () => {
    const at = "2026-08-20T02:00:00.000Z";
    const t = newTask({
      title: "装修", due: today,
      subtasks: [sub("s1", "量尺寸", { droppedAt: at }), sub("s2", "选瓷砖", { droppedAt: at })],
    });
    expect(openRows(dataOf(t)).map(label)).toEqual(["装修"]);
  });

  it("「今天」的逾期区和今日区都不再收留它", () => {
    const t = newTask({ title: "昨天就该交", due: addDays(today, -1), droppedAt: "2026-08-20T02:00:00.000Z" });
    const { overdue, todays, doneToday } = tasksForToday(dataOf(t), today);
    expect(overdue).toEqual([]);
    expect(todays).toEqual([]);
    expect(doneToday).toEqual([]); // 也不许混进「今天完成了几件」
  });
});

describe("droppedRows：放弃的怎么占行（doneRows 的另一面）", () => {
  const at = "2026-08-20T02:00:00.000Z";

  it("放弃的子任务各出一行，母任务自己被放弃时也出一行", () => {
    const t = newTask({
      title: "装修", droppedAt: at,
      subtasks: [sub("s1", "量尺寸", { droppedAt: at }), sub("s2", "选瓷砖"), sub("s3", "订货", { droppedAt: at })],
    });
    expect(droppedRows(dataOf(t)).map(label)).toEqual(["装修›量尺寸", "装修›订货", "装修"]);
  });

  it("回收站里的一律不出（跟 doneRows 同口径，都走 aliveTasks）", () => {
    const t = newTask({ title: "删掉的", droppedAt: at, deletedAt: at });
    expect(droppedRows(dataOf(t))).toEqual([]);
  });

  it("两个标记都带着的脏数据（手改过的 JSON）认完成，同一行不会被画两次", () => {
    const t = newTask({
      title: "怪数据", done: true, doneAt: at, droppedAt: at,
      subtasks: [sub("s1", "也怪", { done: true, doneAt: at, droppedAt: at })],
    });
    expect(droppedRows(dataOf(t))).toEqual([]);
    expect(doneRows(dataOf(t)).map(label)).toEqual(["怪数据›也怪", "怪数据"]);
  });

  it("rowDropped 按行判：子任务行看子任务自己，母任务行看母任务", () => {
    const t = newTask({ title: "装修", subtasks: [sub("s1", "量尺寸", { droppedAt: at }), sub("s2", "选瓷砖")] });
    expect(rowDropped({ task: t, sub: t.subtasks[0] })).toBe(true);
    expect(rowDropped({ task: t, sub: t.subtasks[1] })).toBe(false);
    expect(rowDropped({ task: t, sub: null })).toBe(false);
  });

  it("放弃时刻不存在「猜的」那一档：有标记就必定带着时刻", () => {
    const t = newTask({ title: "装修", subtasks: [sub("s1", "量尺寸", { droppedAt: at })] });
    expect(rowDroppedAt({ task: t, sub: t.subtasks[0] })).toBe(at);
  });

  it("归日转本地时区：凌晨放弃的算今天，不能被 UTC 拖回昨天", () => {
    const [y, m, dd] = today.split("-").map(Number);
    const iso = new Date(y, m - 1, dd, 0, 30).toISOString();
    const t = newTask({ title: "算了", droppedAt: iso });
    expect(rowDroppedDay({ task: t, sub: null })).toBe(today);
    expect(rowDroppedDay({ task: t, sub: null })).toBe(toYMD(new Date(rowDroppedAt({ task: t, sub: null }))));
  });
});

describe("doneRows 一条放弃的都不许收——日历就是靠它画的", () => {
  const at = "2026-08-20T02:00:00.000Z";

  it("放弃的任务和放弃的子任务都进不了 doneRows", () => {
    const t = newTask({
      title: "装修", droppedAt: at,
      subtasks: [sub("s1", "量尺寸", { droppedAt: at }), sub("s2", "选瓷砖", { done: true, doneAt: at })],
    });
    // 真做完的那一步照旧在，放弃的那两条一个都不在
    expect(doneRows(dataOf(t)).map(label)).toEqual(["装修›选瓷砖"]);
  });

  it("按件去重也不受影响：同一件事的两类行归到同一件", () => {
    const t = newTask({
      title: "装修", droppedAt: at,
      subtasks: [sub("s1", "量尺寸", { done: true, doneAt: at })],
    });
    expect(rowTaskIds([...doneRows(dataOf(t)), ...droppedRows(dataOf(t))])).toEqual([t.id]);
  });
});

// ---------------------------------------------------------------------------
// 统计：单独一档，绝不混进完成率
// ---------------------------------------------------------------------------

describe("统计：放弃单独算一档", () => {
  const ws = weekStart(today);

  function droppedToday(title: string): Task {
    const [y, m, dd] = today.split("-").map(Number);
    return newTask({ title, droppedAt: new Date(y, m - 1, dd, 10, 0).toISOString() });
  }
  function doneToday(title: string): Task {
    const [y, m, dd] = today.split("-").map(Number);
    return newTask({ title, done: true, doneAt: new Date(y, m - 1, dd, 10, 0).toISOString() });
  }

  it("完成数一条都不含放弃的——完成率是这份数据里最容易被搞废的数字", () => {
    const tasks = [doneToday("做完了"), droppedToday("算了")];
    const r = weeklyReview(tasks, [], [], today);
    expect(r.completed.map((t) => t.title)).toEqual(["做完了"]);
    expect(r.dropped.map((t) => t.title)).toEqual(["算了"]);
    // 热力图/趋势那条线同样只数完成
    expect(completionByDay(tasks, ws, today).reduce((a, b) => a + b.count, 0)).toBe(1);
  });

  it("「未清」和「反复顺延」都把放弃的剔掉：别催人做不打算做的事", () => {
    const overdue = newTask({ title: "早该交了", due: addDays(today, -3), postponeCount: 4 });
    const gaveUp = newTask({
      title: "算了", due: addDays(today, -3), postponeCount: 5,
      droppedAt: new Date().toISOString(),
    });
    const r = weeklyReview([overdue, gaveUp], [], [], today);
    expect(r.stillOpen.map((t) => t.title)).toEqual(["早该交了"]);
    expect(r.postponed.map((t) => t.title)).toEqual(["早该交了"]);
  });

  it("按清单 / 按需求方：放弃的两栏都不加（既不算完成也不算未完成）", () => {
    const lists = [{ id: "l1", name: "工作", color: "clay", order: 0, updatedAt: "" }];
    const tasks = [
      newTask({ title: "在做", listId: "l1", who: ["李哥"] }),
      newTask({ title: "算了", listId: "l1", who: ["李哥"], droppedAt: new Date().toISOString() }),
    ];
    const row = byList(tasks, lists, ws, today).find((r) => r.id === "l1")!;
    expect(row).toMatchObject({ done: 0, open: 1 });
    expect(byWho(tasks, ws, today)).toEqual([{ who: "李哥", done: 0, open: 1 }]);
  });

  it("周报里放弃自成一节，且一件都没放弃时整节不出现", () => {
    const withDrop = exportWeekMarkdown(weeklyReview([doneToday("做完了"), droppedToday("算了")], [], [], today));
    expect(withDrop).toContain("## 本周放弃 1 件");
    expect(withDrop).toContain("- 算了");
    // 完成那一节里没有它
    expect(withDrop.slice(withDrop.indexOf("## 本周完成"), withDrop.indexOf("## 本周放弃"))).not.toContain("算了");

    const noDrop = exportWeekMarkdown(weeklyReview([doneToday("做完了")], [], [], today));
    expect(noDrop).not.toContain("本周放弃");
  });

  it("整周只有放弃、没有别的动静 → 周报不能报「本周没有记录」", () => {
    const md = exportWeekMarkdown(weeklyReview([droppedToday("算了")], [], [], today));
    expect(md).not.toContain("本周没有记录");
    expect(md).toContain("## 本周放弃 1 件");
  });
});

// ---------------------------------------------------------------------------
// 界面上的落点（结构性约束，读源码钉住）
// ---------------------------------------------------------------------------

describe("圈圈一点都不动，标签摆在别处", () => {
  it("任务卡：圈圈还是只管完成/取消完成，没有第三种状态挤进去", () => {
    const cb = taskCardSource.slice(taskCardSource.indexOf("className={`cb$"));
    expect(cb.slice(0, 200)).toContain("uncompleteTask(task.id) : completeTask(task.id)");
    expect(cb.slice(0, 200)).not.toContain("drop");
  });

  it("任务行：圈圈永远不制造「放弃」，只把已经放弃的那行放回未完成", () => {
    const onCheck = taskRowSource.slice(
      taskRowSource.indexOf("function onCheck"),
      taskRowSource.indexOf("// 多选按「件」不按「行」"),
    );
    // 放弃的那行点圆圈 = 取消放弃（跟「已完成」表头那句提示对齐），任务和子任务各走各的口
    expect(onCheck).toContain("dropTasks([task.id], false)");
    expect(onCheck).toContain("dropSubtask(task.id, sub.id, false)");
    // 反过来：圈圈这条路一件事都不许被标成放弃（那是右键/任务卡上那个键的事）
    expect(onCheck).not.toContain("dropTasks([task.id], true)");
    expect(onCheck).not.toContain("dropSubtask(task.id, sub.id, true)");
    // 也不许在这儿自己算时间戳——盖/清放弃时刻只有 store 那一处
    expect(onCheck).not.toContain("toISOString");
    expect(onCheck).not.toContain("droppedAt:");
  });

  it("放弃在行上表现为「删除线 + 一个灰色小标签」", () => {
    expect(taskRowSource).toContain("dropped-row");
    expect(taskRowSource).toContain('className="drop-tag"');
    expect(taskRowSource).toContain("已放弃");
  });
});

describe("入口：右键菜单、任务卡上的小按钮、子任务", () => {
  it("右键菜单：任务和子任务都有「放弃 / 取消放弃」", () => {
    expect(ctxMenuSource).toContain('{allDropped ? "取消放弃" : "放弃"}');
    expect(ctxMenuSource).toContain('{sub.droppedAt ? "取消放弃" : "放弃这一步"}');
  });

  it("任务卡上那个键跟 🗑 一样，排在 tc-gap 之后——离那排改属性的胶囊留出距离", () => {
    const tail = taskCardSource.slice(taskCardSource.indexOf('<span className="tc-gap" />'));
    const dropAt = tail.indexOf("drop-pill");
    const trashAt = tail.indexOf("danger-pill");
    expect(dropAt).toBeGreaterThan(0);
    expect(trashAt).toBeGreaterThan(dropAt); // 放弃在前、删除在后，都在隔开区之后
    // 反过来说：胶囊那排里绝不能混进放弃键
    const chips = taskCardSource.slice(
      taskCardSource.indexOf('<div className="chips"'),
      taskCardSource.indexOf('<span className="tc-gap" />'),
    );
    expect(chips).not.toContain("drop-pill");
  });

  it("子任务行上有自己的放弃键", () => {
    expect(taskCardSource).toContain('className="sub-drop"');
    expect(taskCardSource).toContain("dropSubtask(task.id, s.id, !s.droppedAt)");
  });
});

// ---------------------------------------------------------------------------
// 口径：放弃跟已完成**一模一样**，不发明第三种行为（v1.9.0 收口时定的）。
// 已完成在随手记 / 清单 / 需求方 / 标签这四个视图里是「整条隐藏 + 不进计数」，
// 放弃就照抄这一条。先前那版让这四处收留放弃、侧栏也照算，而 stats 的 byList/byWho
// 早就把放弃剔出去了——同一个「还欠几件」在侧栏、视图、统计页给三个值。
// ---------------------------------------------------------------------------

describe("放弃跟已完成同一个口径：算法只有一套", () => {
  const at = "2026-08-20T02:00:00.000Z";

  it("侧栏的「还欠着的」：完成的不算，放弃的也不算", () => {
    const tasks = [
      newTask({ title: "在做", listId: "l1" }),
      newTask({ title: "做完了", listId: "l1", done: true, doneAt: at }),
      newTask({ title: "算了", listId: "l1", droppedAt: at }),
    ];
    // 侧栏 open 的算法（Sidebar.tsx）：!done && !droppedAt
    const open = tasks.filter((t) => !t.done && !t.droppedAt);
    expect(open.map((t) => t.title)).toEqual(["在做"]);
    expect(sidebarSource).toContain("!t.done && !t.droppedAt");
  });

  it("allWho / allTags 的未完成数：放弃的跟完成的一样都不进这个数", () => {
    const settings = defaultData().settings;
    const mk = (title: string, patch: Partial<Task>) =>
      newTask({ title, who: ["李哥"], tags: ["紧要"], ...patch });

    const all = dataOf(mk("在做", {}), mk("做完了", { done: true, doneAt: at }), mk("算了", { droppedAt: at }));
    expect(allWho({ tasks: all.tasks, settings })).toEqual([{ who: "李哥", open: 1 }]);
    expect(allTags({ tasks: all.tasks })).toEqual([{ tag: "紧要", open: 1 }]);

    // 三处必须给同一个数：统计页那两栏早就是这个口径
    const lists = [{ id: "l1", name: "工作", color: "clay", order: 0, updatedAt: "" }];
    const withList = all.tasks.map((t) => ({ ...t, listId: "l1" }));
    const ws = weekStart(today);
    expect(byList(withList, lists, ws, today).find((r) => r.id === "l1")!.open).toBe(1);
    // done 那一栏只数**本周内**完成的（这条 doneAt 是 8 月的老账），这里只对未完成那一栏
    expect(byWho(withList, ws, today).map((r) => r.open)).toEqual([1]);
  });

  it("全放弃 / 全做完的标签一样地整个消失，需求方一样地留在列表上但记 0", () => {
    const settings = defaultData().settings;
    const doneOnly = dataOf(newTask({ title: "做完了", who: ["王姐"], tags: ["旧事"], done: true, doneAt: at }));
    const dropOnly = dataOf(newTask({ title: "算了", who: ["王姐"], tags: ["旧事"], droppedAt: at }));
    expect(allTags({ tasks: dropOnly.tasks })).toEqual(allTags({ tasks: doneOnly.tasks }));
    expect(allWho({ tasks: dropOnly.tasks, settings })).toEqual(allWho({ tasks: doneOnly.tasks, settings }));
    expect(allTags({ tasks: dropOnly.tasks })).toEqual([]);
    expect(allWho({ tasks: dropOnly.tasks, settings })).toEqual([{ who: "王姐", open: 0 }]);
  });

  it("随手记 / 清单 / 需求方 / 标签四个视图：放弃的跟完成的一样退出去", () => {
    // 四个 filter 都是「!t.done && !t.droppedAt」开头，一个都不许漏
    const view = listViewSource.slice(
      listViewSource.indexOf('case "inbox":'),
      listViewSource.indexOf('case "trash":'),
    );
    expect(view.split("!t.done && !t.droppedAt").length - 1).toBe(4);
    // 反过来：这四段里不许再有只判 done 的漏网
    expect(view).not.toMatch(/!t\.done(?! && !t\.droppedAt)/);
  });

  it("台账上那条「故意没改的」已经撤了，改成写明口径统一", () => {
    expect(modelDoc).not.toContain("照旧收留已放弃的事");
    expect(modelDoc).toContain("放弃跟已完成**一模一样**");
  });
});

describe("去哪：四个待办视图筛掉它，「已完成」收留它", () => {
  it("四象限和日历的计划条都明写了 !t.droppedAt", () => {
    expect(quadrantSource).toContain("!t.done && !t.droppedAt");
    expect(calendarSource).toContain("!t.done && !t.droppedAt");
  });

  it("「已完成」顶上是三选一，默认「做完的」，选择存 localStorage", () => {
    expect(doneViewSource).toContain('{ id: "done", name: "做完的" }');
    expect(doneViewSource).toContain('{ id: "dropped", name: "放弃的" }');
    expect(doneViewSource).toContain('{ id: "all", name: "全部" }');
    expect(doneViewSource).toContain('acorn-done-filter');
    // 读不出来时的兜底就是默认档
    expect(doneViewSource).toContain('return "done";');
    // 控件跟日历那个筛子同款
    expect(doneViewSource).toContain('className="all-sort"');
    expect(calendarSource).toContain('className="all-sort"');
  });

  it("不新增侧栏项：放弃跟完成住同一个屋子", () => {
    expect(doneViewSource).toContain("droppedRows");
  });

  it("放弃了就不再弹提醒——都说了不做了还弹一下，那是纯打扰", () => {
    expect(remindersSource).toContain("!t.done && !t.droppedAt && !t.deletedAt && t.reminder");
    // 但提醒本身不清空：取消放弃之后它得原样回来
    const sweep = remindersSource.slice(remindersSource.indexOf("function sweep"));
    expect(sweep).not.toContain("droppedAt: null");
  });
});
