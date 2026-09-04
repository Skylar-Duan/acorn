// store.ts 动作层测试。jsdom 环境无 __TAURI_INTERNALS__，persist 自动走 localStorage。
// 固定日期参照 recur.test.ts：2026-08-17 是周一。
// 涉及"今天"的断言一律用 todayYMD() 现算；tasksForToday 用显式 today 参数保持确定性。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appStore,
  addTask,
  updateTask,
  completeTask,
  uncompleteTask,
  deleteTasks,
  restoreTask,
  purgeTrash,
  postponeTasks,
  addList,
  deleteList,
  addSubtask,
  toggleSubtask,
  updateSubtask,
  removeSubtask,
  logFocus,
  undo,
  flushSave,
  aliveSubtasks,
  aliveTasks,
  allWho,
  allTags,
  tasksForToday,
} from "../src/core/store";
import { defaultData } from "../src/core/model";
import type { Task } from "../src/core/model";
import { addDays, cmpYMD, dayOfWeek, todayYMD } from "../src/core/dates";

const LS_KEY = "acorn-data";

function getTask(id: string): Task {
  const t = appStore.getState().data.tasks.find((x) => x.id === id);
  if (!t) throw new Error(`task ${id} not found in store`);
  return t;
}

beforeEach(async () => {
  vi.useRealTimers();
  // 模块级 undoStack 没有导出的清空接口，只能循环 undo 弹空
  while (appStore.getState().undoDepth > 0) undo();
  // 清掉挂起的防抖计时器，避免上个测试的落盘落到本测试
  await flushSave();
  localStorage.clear();
  appStore.setState({
    data: defaultData(),
    loaded: true,
    loadError: null,
    ui: {
      view: "today", listId: null, who: null, tag: null,
      expandedId: null, selectedIds: [], searchOpen: false, paletteOpen: false, toast: null,
      ctxMenu: null, foldAll: false, foldExcept: [], changelogOpen: false, quickAddOpen: false,
    },
    focus: { taskId: null, running: false, endsAt: null, totalMinutes: 0 },
    undoDepth: 0,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------- addTask ----------

describe("addTask", () => {
  it("默认值：随手记、无标签、无优先级、未完成、无提醒", () => {
    const id = addTask({ title: "买酱油" });
    const t = getTask(id);
    expect(t.title).toBe("买酱油");
    expect(t.listId).toBeNull();
    expect(t.tags).toEqual([]);
    expect(t.who).toEqual([]);
    expect(t.priority).toBe(0);
    expect(t.due).toBeNull();
    expect(t.dueTime).toBeNull();
    expect(t.reminder).toBeNull();
    expect(t.repeat).toBeNull();
    expect(t.subtasks).toEqual([]);
    expect(t.done).toBe(false);
    expect(t.doneAt).toBeNull();
    expect(t.postponeCount).toBe(0);
    expect(t.focusMinutes).toBe(0);
    expect(t.deletedAt).toBeNull();
  });

  it("带 due+dueTime 自动生成同时刻提醒", () => {
    const id = addTask({ title: "开会", due: "2026-08-20", dueTime: "14:30" });
    expect(getTask(id).reminder).toBe("2026-08-20T14:30");
  });

  it("只有 due 没有 dueTime 不打扰（无提醒）", () => {
    const id = addTask({ title: "交报告", due: "2026-08-20" });
    expect(getTask(id).reminder).toBeNull();
  });
});

// ---------- completeTask / uncompleteTask ----------

describe("completeTask", () => {
  it("普通任务：done + doneAt 落上 ISO 时刻", () => {
    const id = addTask({ title: "普通事" });
    completeTask(id);
    const t = getTask(id);
    expect(t.done).toBe(true);
    expect(t.doneAt).toBeTruthy();
    expect(t.doneAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("循环任务：本体推进到下一落点、子任务重置、顺延归零、提醒跟走，另留已完成副本", () => {
    // 落点是「今天之后的下一个周一」——严重逾期的循环任务要补追赶，锚点取 max(旧 due, 今天)。
    // 这里**不能写死日期**：写死的话，真到了那天（比如今天正好是周一）断言就自己失效了。
    const id = addTask({
      title: "周会",
      due: "2026-08-17",
      dueTime: "09:00",
      repeat: { kind: "weekly", days: [1] },
    });
    addSubtask(id, "写议程");
    const subId = getTask(id).subtasks[0].id;
    toggleSubtask(id, subId); // 子任务先勾上
    updateTask(id, { postponeCount: 2 }); // 制造顺延计数

    completeTask(id);
    const tasks = appStore.getState().data.tasks;
    expect(tasks).toHaveLength(2);

    const advanced = getTask(id);
    expect(advanced.done).toBe(false);
    expect(advanced.due).not.toBeNull();
    expect(dayOfWeek(advanced.due!)).toBe(1); // 是个周一
    expect(cmpYMD(advanced.due!, todayYMD())).toBeGreaterThan(0); // 且必在今天之后
    expect(advanced.reminder).toBe(`${advanced.due}T09:00`); // 提醒跟着新落点走
    expect(advanced.repeat).toEqual({ kind: "weekly", days: [1] });
    expect(advanced.subtasks).toHaveLength(1);
    expect(advanced.subtasks[0].done).toBe(false);
    expect(advanced.postponeCount).toBe(0);

    const copy = tasks.find((t) => t.id !== id)!;
    expect(copy.title).toBe("周会");
    expect(copy.done).toBe(true);
    expect(copy.doneAt).toBeTruthy();
    expect(copy.repeat).toBeNull();
    expect(copy.due).toBe("2026-08-17");
    expect(copy.subtasks[0].done).toBe(true); // 副本保留完成时的子任务状态
  });

  it("对已完成任务再调用是无操作", () => {
    const id = addTask({ title: "只完成一次" });
    completeTask(id);
    const doneAt = getTask(id).doneAt;
    completeTask(id);
    expect(getTask(id).doneAt).toBe(doneAt);
    expect(appStore.getState().data.tasks).toHaveLength(1);
  });

  it("uncompleteTask 还原为未完成且清空 doneAt", () => {
    const id = addTask({ title: "反悔" });
    completeTask(id);
    uncompleteTask(id);
    const t = getTask(id);
    expect(t.done).toBe(false);
    expect(t.doneAt).toBeNull();
  });
});

// ---------- updateTask ----------

describe("updateTask", () => {
  it("把 due 改晚 postponeCount +1，可累计", () => {
    const id = addTask({ title: "t", due: "2026-08-20" });
    updateTask(id, { due: "2026-08-22" });
    expect(getTask(id).postponeCount).toBe(1);
    updateTask(id, { due: "2026-08-30" });
    expect(getTask(id).postponeCount).toBe(2);
  });

  it("改早或从无到有不加顺延计数", () => {
    const id = addTask({ title: "提前", due: "2026-08-20" });
    updateTask(id, { due: "2026-08-18" });
    expect(getTask(id).postponeCount).toBe(0);

    const id2 = addTask({ title: "从无到有" });
    updateTask(id2, { due: "2026-09-01" });
    expect(getTask(id2).postponeCount).toBe(0);
  });

  it("改 due 时已有提醒跟着挪到新日期同一时刻", () => {
    const id = addTask({ title: "会议", due: "2026-08-20", dueTime: "14:30" });
    updateTask(id, { due: "2026-08-25" });
    expect(getTask(id).reminder).toBe("2026-08-25T14:30");
  });

  it("due 置空时提醒清掉", () => {
    const id = addTask({ title: "取消安排", due: "2026-08-20", dueTime: "14:30" });
    updateTask(id, { due: null });
    const t = getTask(id);
    expect(t.due).toBeNull();
    expect(t.reminder).toBeNull();
  });

  it("给有 due 的任务补 dueTime 会生成提醒", () => {
    const id = addTask({ title: "补时间", due: "2026-08-20" });
    expect(getTask(id).reminder).toBeNull();
    updateTask(id, { dueTime: "08:00" });
    expect(getTask(id).reminder).toBe("2026-08-20T08:00");
  });
});

// ---------- postponeTasks ----------

describe("postponeTasks", () => {
  it("无 due 与已逾期的都从今天起算推到明天", () => {
    const today = todayYMD();
    const noDue = addTask({ title: "没安排" });
    const overdue = addTask({ title: "逾期", due: addDays(today, -3) });
    postponeTasks([noDue, overdue]);
    expect(getTask(noDue).due).toBe(addDays(today, 1));
    expect(getTask(overdue).due).toBe(addDays(today, 1));
    expect(getTask(noDue).postponeCount).toBe(1);
    expect(getTask(overdue).postponeCount).toBe(1);
  });

  it("未来的任务在原 due 基础上 +1", () => {
    const today = todayYMD();
    const future = addTask({ title: "未来", due: addDays(today, 5) });
    postponeTasks([future]);
    expect(getTask(future).due).toBe(addDays(today, 6));
    expect(getTask(future).postponeCount).toBe(1);
  });

  it("提醒跟到新日期同一时刻，未列入的任务不动", () => {
    const today = todayYMD();
    const due = addDays(today, 3);
    const id = addTask({ title: "带提醒", due, dueTime: "10:00" });
    const bystander = addTask({ title: "旁观", due });
    postponeTasks([id]);
    expect(getTask(id).reminder).toBe(`${addDays(due, 1)}T10:00`);
    expect(getTask(bystander).due).toBe(due);
    expect(getTask(bystander).postponeCount).toBe(0);
  });
});

// ---------- 回收站 ----------

describe("回收站", () => {
  it("deleteTasks 打上 deletedAt，aliveTasks 不再返回", () => {
    const id = addTask({ title: "要删" });
    const keep = addTask({ title: "留着" });
    deleteTasks([id]);
    expect(getTask(id).deletedAt).toBeTruthy();
    const alive = aliveTasks(appStore.getState().data);
    expect(alive.map((t) => t.id)).toEqual([keep]);
  });

  it("restoreTask 复原", () => {
    const id = addTask({ title: "捞回来" });
    deleteTasks([id]);
    restoreTask(id);
    expect(getTask(id).deletedAt).toBeNull();
    expect(aliveTasks(appStore.getState().data)).toHaveLength(1);
  });

  it("purgeTrash 物理清除，未删除的保留", () => {
    const gone = addTask({ title: "彻底没" });
    const keep = addTask({ title: "还在" });
    deleteTasks([gone]);
    purgeTrash();
    const tasks = appStore.getState().data.tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe(keep);
  });
});

// ---------- undo ----------

describe("undo", () => {
  it("完成→撤销回到未完成", () => {
    const id = addTask({ title: "撤销完成" });
    completeTask(id);
    undo();
    const t = getTask(id);
    expect(t.done).toBe(false);
    expect(t.doneAt).toBeNull();
  });

  it("删除→撤销回来", () => {
    const id = addTask({ title: "撤销删除" });
    deleteTasks([id]);
    undo();
    expect(getTask(id).deletedAt).toBeNull();
  });

  it("连续多步撤销按栈序回退，栈空后是无操作", () => {
    const a = addTask({ title: "A" });
    addTask({ title: "B" });
    expect(appStore.getState().data.tasks).toHaveLength(2);
    expect(appStore.getState().undoDepth).toBe(2);
    undo(); // 撤掉 B
    expect(appStore.getState().data.tasks.map((t) => t.id)).toEqual([a]);
    undo(); // 撤掉 A
    expect(appStore.getState().data.tasks).toHaveLength(0);
    expect(appStore.getState().undoDepth).toBe(0);
    undo(); // 栈已空
    expect(appStore.getState().data.tasks).toHaveLength(0);
  });
});

// ---------- 清单 ----------

describe("deleteList", () => {
  it("清单删除后其下任务回随手记（listId=null），别的清单不受影响", () => {
    const listId = addList("临时项目", "sea");
    const inList = addTask({ title: "项目里的事", listId });
    const otherList = appStore.getState().data.lists[0].id;
    const elsewhere = addTask({ title: "别处的事", listId: otherList });
    deleteList(listId);
    const d = appStore.getState().data;
    expect(d.lists.some((l) => l.id === listId)).toBe(false);
    expect(getTask(inList).listId).toBeNull();
    expect(getTask(elsewhere).listId).toBe(otherList);
  });
});

// ---------- 子任务 ----------

describe("子任务", () => {
  it("addSubtask 追加未完成子任务", () => {
    const id = addTask({ title: "大事" });
    addSubtask(id, "第一步");
    addSubtask(id, "第二步");
    const subs = getTask(id).subtasks;
    expect(subs).toHaveLength(2);
    expect(subs[0]).toMatchObject({ title: "第一步", done: false });
    expect(subs[1]).toMatchObject({ title: "第二步", done: false });
    expect(subs[0].id).not.toBe(subs[1].id);
  });

  it("toggleSubtask 来回翻转", () => {
    const id = addTask({ title: "大事" });
    addSubtask(id, "一步");
    const subId = getTask(id).subtasks[0].id;
    toggleSubtask(id, subId);
    expect(getTask(id).subtasks[0].done).toBe(true);
    toggleSubtask(id, subId);
    expect(getTask(id).subtasks[0].done).toBe(false);
  });

  it("addSubtask 建出来的自带 doneAt: null（不是 undefined，undefined 会被 JSON 吞掉）", () => {
    const id = addTask({ title: "大事" });
    addSubtask(id, "一步");
    const s = getTask(id).subtasks[0];
    expect(s.doneAt).toBeNull();
    expect("doneAt" in s).toBe(true);
  });

  // 勾一条子任务有三条路：任务卡走 toggleSubtask，列表行和右键菜单直调 updateSubtask({done})。
  // 两条路必须产出同一种数据，否则「在卡上勾有完成日、在行上勾没有」
  it("toggleSubtask 勾上盖完成时刻、取消清掉", () => {
    const id = addTask({ title: "大事" });
    addSubtask(id, "一步");
    const subId = getTask(id).subtasks[0].id;
    const before = new Date().toISOString();
    toggleSubtask(id, subId);
    const at = getTask(id).subtasks[0].doneAt;
    expect(at).toBeTruthy();
    expect(at! >= before).toBe(true);
    toggleSubtask(id, subId);
    expect(getTask(id).subtasks[0].doneAt).toBeNull();
  });

  it("updateSubtask({done}) 走的是同一套：列表行和右键菜单勾出来的一样有完成时刻", () => {
    const id = addTask({ title: "大事" });
    addSubtask(id, "一步");
    const subId = getTask(id).subtasks[0].id;
    updateSubtask(id, subId, { done: true });
    expect(getTask(id).subtasks[0].doneAt).toBeTruthy();
    updateSubtask(id, subId, { done: false });
    expect(getTask(id).subtasks[0].doneAt).toBeNull();
  });

  it("不碰 done 的补丁（改标题/日期）不动完成时刻", () => {
    const id = addTask({ title: "大事" });
    addSubtask(id, "一步");
    const subId = getTask(id).subtasks[0].id;
    updateSubtask(id, subId, { done: true });
    const at = getTask(id).subtasks[0].doneAt;
    updateSubtask(id, subId, { title: "改个名", due: todayYMD() });
    expect(getTask(id).subtasks[0].doneAt).toBe(at);
  });

  it("显式带了 doneAt 的以调用方为准（导入回填用）", () => {
    const id = addTask({ title: "大事" });
    addSubtask(id, "一步");
    const subId = getTask(id).subtasks[0].id;
    updateSubtask(id, subId, { done: true, doneAt: "2026-08-20T02:00:00.000Z" });
    expect(getTask(id).subtasks[0].doneAt).toBe("2026-08-20T02:00:00.000Z");
  });

  // v7 起删 = 进回收站：那条还在数组里，只是带上了 deletedAt（细则见 tests/subtask-trash.test.ts）
  it("removeSubtask 只删指定那条——删掉的进回收站，活着的那条一个字不动", () => {
    const id = addTask({ title: "大事" });
    addSubtask(id, "留");
    addSubtask(id, "删");
    const del = getTask(id).subtasks[1].id;
    removeSubtask(id, del);
    const subs = getTask(id).subtasks;
    expect(subs).toHaveLength(2);
    expect(subs[0].title).toBe("留");
    expect(subs[0].deletedAt ?? null).toBeNull();
    expect(subs[1].deletedAt).toBeTruthy();
    expect(aliveSubtasks(getTask(id)).map((s) => s.title)).toEqual(["留"]);
  });
});

// ---------- 专注 ----------

describe("logFocus", () => {
  it("sessions 增加、任务 focusMinutes 累加、不进撤销栈", () => {
    const id = addTask({ title: "深活" });
    const depth = appStore.getState().undoDepth;
    logFocus(id, 25);
    logFocus(id, 5);
    const d = appStore.getState().data;
    expect(d.sessions).toHaveLength(2);
    expect(d.sessions[0]).toMatchObject({ taskId: id, minutes: 25, date: todayYMD() });
    expect(getTask(id).focusMinutes).toBe(30);
    expect(appStore.getState().undoDepth).toBe(depth); // skipUndo：栈深不变
  });

  it("undo 不会回退 logFocus（栈空时 session 原样留着）", () => {
    logFocus(null, 10);
    expect(appStore.getState().undoDepth).toBe(0);
    undo();
    expect(appStore.getState().data.sessions).toHaveLength(1);
    expect(appStore.getState().data.sessions[0].taskId).toBeNull();
  });

  it("minutes<=0 完全不记录", () => {
    logFocus(null, 0);
    logFocus(null, -5);
    expect(appStore.getState().data.sessions).toHaveLength(0);
  });
});

// ---------- 派生查询 ----------

describe("派生查询", () => {
  it("allWho：只计未完成、排除已删除、按 open 降序；已完成的保留条目但计 0", () => {
    addTask({ title: "1", who: ["李哥"] });
    addTask({ title: "2", who: ["李哥"] });
    const done = addTask({ title: "3", who: ["李哥"] });
    completeTask(done);
    addTask({ title: "4", who: ["王姐"] });
    const del = addTask({ title: "5", who: ["赵总"] });
    deleteTasks([del]);
    addTask({ title: "6" }); // 无 who 不进列表
    expect(allWho(appStore.getState().data)).toEqual([
      { who: "李哥", open: 2 },
      { who: "王姐", open: 1 },
    ]);
  });

  it("allTags：整个已完成任务跳过、多标签逐个计、按 open 降序", () => {
    addTask({ title: "1", tags: ["深活", "写作"] });
    addTask({ title: "2", tags: ["写作"] });
    const done = addTask({ title: "3", tags: ["深活"] });
    completeTask(done);
    const del = addTask({ title: "4", tags: ["写作"] });
    deleteTasks([del]);
    expect(allTags(appStore.getState().data)).toEqual([
      { tag: "写作", open: 2 },
      { tag: "深活", open: 1 },
    ]);
  });

  it("tasksForToday：逾期/今天/今天完成三组，删除的排除，今天组按优先级降序", () => {
    const TODAY = "2026-08-17";
    const over = addTask({ title: "逾期", due: "2026-08-10" });
    const low = addTask({ title: "今天低", due: TODAY, priority: 1 });
    const high = addTask({ title: "今天高", due: TODAY, priority: 3 });
    addTask({ title: "未来", due: "2026-08-30" });
    const del = addTask({ title: "删掉的", due: TODAY });
    deleteTasks([del]);
    // 今天完成的：显式塞 doneAt，避免依赖真实时钟（completeTask 的 doneAt 是 UTC ISO）
    const doneToday = addTask({ title: "干完了" });
    updateTask(doneToday, { done: true, doneAt: "2026-08-17T10:00:00.000Z" });
    // 昨天完成的逾期任务：三组都不该出现
    const doneOld = addTask({ title: "老早完成", due: "2026-08-10" });
    updateTask(doneOld, { done: true, doneAt: "2026-08-16T10:00:00.000Z" });

    const r = tasksForToday(appStore.getState().data, TODAY);
    expect(r.overdue.map((x) => x.task.id)).toEqual([over]);
    expect(r.todays.map((x) => x.task.id)).toEqual([high, low]); // 同日无时间 → 优先级 3 在前
    expect(r.doneToday.map((t) => t.id)).toEqual([doneToday]);
  });
});

// ---------- 落盘 ----------

describe("落盘", () => {
  it("flushSave 立即把待存数据写进 localStorage", async () => {
    const id = addTask({ title: "立即写" });
    await flushSave();
    const raw = localStorage.getItem(LS_KEY);
    expect(raw).not.toBeNull();
    const saved = JSON.parse(raw!);
    expect(saved.tasks.some((t: Task) => t.id === id)).toBe(true);
  });

  it("防抖 400ms：到点前不写，到点后写入", () => {
    vi.useFakeTimers();
    addTask({ title: "防抖" });
    expect(localStorage.getItem(LS_KEY)).toBeNull();
    vi.advanceTimersByTime(399);
    expect(localStorage.getItem(LS_KEY)).toBeNull();
    vi.advanceTimersByTime(1);
    const raw = localStorage.getItem(LS_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!).tasks).toHaveLength(1);
  });
});
