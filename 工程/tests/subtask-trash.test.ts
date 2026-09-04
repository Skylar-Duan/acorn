// 子任务也进回收站（v7，2026-09-03 PM 真机试 v1.12.0：「回收站是不是不保留子任务，修一下」）。
//
// 以前 removeSubtask 是当场 filter 掉，一删就没了；整件事却走 deletedAt 进回收站待 30 天——
// 两种删法一种能反悔一种不能。这一版让子任务照抄整件事那套：
//   · 删 = 盖 deletedAt，母任务盖 updatedAt，进撤销栈、toast 可撤销
//   · 回收站页单列「母 › 子」一行，能恢复、能彻底删；「清空回收站」连它们一起清
//   · 30 天到期自动清，**母任务的 updatedAt 不动**（清理不是编辑）
//   · 凡是「活着的子任务」语义一律走 aliveSubtasks，拆行 / 计数 / 折叠 / 搜索都不许再看见它
import { beforeEach, describe, expect, it, vi } from "vitest";
import listViewSource from "../src/views/ListView.tsx?raw";
import appSource from "../src/App.tsx?raw";
import taskRowSource from "../src/components/TaskRow.tsx?raw";
import searchOverlaySource from "../src/components/SearchOverlay.tsx?raw";
import type { AppData, Subtask, Task } from "../src/core/model";
import { defaultData, newTask } from "../src/core/model";
import { searchTasks } from "../src/core/search";
import { addDays, todayYMD } from "../src/core/dates";
import {
  addSubtask, addTask, aliveSubtasks, appStore, completeTask, deleteTasks, doneRows, droppedRows,
  dropSubtask, flushSave, foldDoneSubs, hasChain, initStore, openRows, purgeSubtask, purgeTrash,
  removeSubtask, restoreSubtask, rowTaskIds, splitSubtasks, toggleSubtask, trashedSubtaskRows, undo,
} from "../src/core/store";

const today = todayYMD();
const OLD = "2026-02-02T00:00:00.000Z";
const LS_KEY = "acorn-data";

function sub(id: string, title: string, patch: Partial<Subtask> = {}): Subtask {
  return { id, title, done: false, due: null, dueTime: null, priority: null, doneAt: null, droppedAt: null, ...patch };
}

function dataOf(...tasks: Task[]): AppData {
  return { ...defaultData(), tasks };
}

const getTask = (id: string): Task => {
  const t = appStore.getState().data.tasks.find((x) => x.id === id);
  if (!t) throw new Error(`task ${id} not found`);
  return t;
};

/** 把某件事的 updatedAt 拨回很久以前，好断言「这一下到底盖没盖戳」 */
function backdate(id: string) {
  const d = appStore.getState().data;
  appStore.setState({ data: { ...d, tasks: d.tasks.map((t) => (t.id === id ? { ...t, updatedAt: OLD } : t)) } });
}

beforeEach(async () => {
  vi.useRealTimers();
  while (appStore.getState().undoDepth > 0) undo();
  await flushSave();
  localStorage.clear();
  appStore.setState({
    data: defaultData(), loaded: true, loadError: null, dataFromNewer: null, undoDepth: 0,
    ui: { ...appStore.getState().ui, toast: null },
  });
});

/** 一件带两步的事，返回 [任务 id, 第一步 id, 第二步 id] */
function twoSteps(): [string, string, string] {
  const id = addTask({ title: "装修", due: today });
  addSubtask(id, "量尺寸");
  addSubtask(id, "选瓷砖");
  const [a, b] = getTask(id).subtasks;
  return [id, a.id, b.id];
}

// ---------------------------------------------------------------------------

describe("软删：删一步 = 进回收站，不是消失", () => {
  it("只盖 deletedAt，那条还在数组里，别的字段一个不动", () => {
    const [id, a, b] = twoSteps();
    removeSubtask(id, b);
    const subs = getTask(id).subtasks;
    expect(subs).toHaveLength(2);
    expect(subs[1].id).toBe(b);
    expect(subs[1].deletedAt).toBeTruthy();
    expect(subs[1].title).toBe("选瓷砖");
    expect(subs[1].done).toBe(false);
    // 没删的那条连这个键都没有（缺失 = 活着，跟 migrate 不补 null 是同一个口径）
    expect("deletedAt" in subs[0]).toBe(false);
    expect(subs[0].id).toBe(a);
  });

  it("aliveSubtasks 从此看不见它，task.subtasks 里仍然有它", () => {
    const [id, , b] = twoSteps();
    removeSubtask(id, b);
    expect(aliveSubtasks(getTask(id)).map((s) => s.title)).toEqual(["量尺寸"]);
    expect(getTask(id).subtasks.map((s) => s.title)).toEqual(["量尺寸", "选瓷砖"]);
  });

  it("母任务盖 updatedAt：别的设备靠它知道这一步删了", () => {
    const [id, , b] = twoSteps();
    backdate(id);
    removeSubtask(id, b);
    expect(getTask(id).updatedAt > OLD).toBe(true);
  });

  it("进撤销栈、toast 可撤销，跟 deleteTasks 同一套；撤销后那条原样回来", () => {
    const [id, , b] = twoSteps();
    const depth = appStore.getState().undoDepth;
    removeSubtask(id, b);
    expect(appStore.getState().undoDepth).toBe(depth + 1);
    const toast = appStore.getState().ui.toast;
    expect(toast?.msg).toBe("已删除");
    expect(toast?.undoable).toBe(true);
    undo();
    expect(getTask(id).subtasks[1].deletedAt ?? null).toBeNull();
    expect(aliveSubtasks(getTask(id))).toHaveLength(2);
  });

  it("已经在回收站里的再删一次什么都不动：不压栈、戳不换", () => {
    const [id, , b] = twoSteps();
    removeSubtask(id, b);
    const stamp = getTask(id).subtasks[1].deletedAt;
    const depth = appStore.getState().undoDepth;
    removeSubtask(id, b);
    expect(appStore.getState().undoDepth).toBe(depth);
    expect(getTask(id).subtasks[1].deletedAt).toBe(stamp);
  });

  it("对不存在的事 / 步什么都不动", () => {
    const [id] = twoSteps();
    const depth = appStore.getState().undoDepth;
    removeSubtask(id, "nope");
    removeSubtask("nope", "nope");
    expect(appStore.getState().undoDepth).toBe(depth);
  });
});

describe("恢复：放回原处", () => {
  it("只清 deletedAt（写成 null），done / 日期 / 重要性一个不动，母任务盖戳", () => {
    const id = addTask({ title: "装修", due: today });
    addSubtask(id, "量尺寸", { due: addDays(today, 3), priority: 3 });
    const s = getTask(id).subtasks[0].id;
    toggleSubtask(id, s);
    removeSubtask(id, s);
    backdate(id);
    restoreSubtask(id, s);
    const after = getTask(id).subtasks[0];
    expect(after.deletedAt).toBeNull();
    expect(after.done).toBe(true);
    expect(after.due).toBe(addDays(today, 3));
    expect(after.priority).toBe(3);
    expect(getTask(id).updatedAt > OLD).toBe(true);
    expect(aliveSubtasks(getTask(id))).toHaveLength(1);
  });

  it("活着的那条调恢复什么都不动", () => {
    const [id, a] = twoSteps();
    const depth = appStore.getState().undoDepth;
    restoreSubtask(id, a);
    expect(appStore.getState().undoDepth).toBe(depth);
  });
});

describe("彻底删除", () => {
  it("purgeSubtask 真从数组里抹掉，仍进撤销栈能回来", () => {
    const [id, , b] = twoSteps();
    removeSubtask(id, b);
    purgeSubtask(id, b);
    expect(getTask(id).subtasks.map((s) => s.title)).toEqual(["量尺寸"]);
    expect(appStore.getState().ui.toast?.msg).toBe("已彻底删除");
    undo();
    expect(getTask(id).subtasks.map((s) => s.title)).toEqual(["量尺寸", "选瓷砖"]);
    expect(getTask(id).subtasks[1].deletedAt).toBeTruthy();
  });

  it("活着的那条 id 对上也不动（跟 purgeTask 同一条规矩）", () => {
    const [id, a] = twoSteps();
    const depth = appStore.getState().undoDepth;
    purgeSubtask(id, a);
    expect(getTask(id).subtasks).toHaveLength(2);
    expect(appStore.getState().undoDepth).toBe(depth);
  });

  it("清空回收站：单列的子任务一起清，活着的子任务和母任务本体不动，没事的任务对象身份不变", () => {
    const [id, , b] = twoSteps();
    const other = addTask({ title: "交电费" });
    const gone = addTask({ title: "删掉的整件事" });
    deleteTasks([gone]);
    removeSubtask(id, b);
    const otherObj = getTask(other);
    purgeTrash();
    const tasks = appStore.getState().data.tasks;
    expect(tasks.map((t) => t.id).sort()).toEqual([id, other].sort());
    expect(getTask(id).subtasks.map((s) => s.title)).toEqual(["量尺寸"]);
    expect(getTask(other)).toBe(otherObj);
    // 整件事那条照旧立墓碑
    expect(appStore.getState().data.graveyard.map((g) => g.id)).toEqual([gone]);
  });
});

describe("30 天自动清理：只清子任务，不动母任务的 updatedAt", () => {
  it("到期的那步没了，没到期的还在，母任务的戳原封不动", async () => {
    const expired = new Date(Date.now() - 31 * 86400000).toISOString();
    const fresh = new Date(Date.now() - 3 * 86400000).toISOString();
    const t = newTask({
      title: "装修", createdAt: OLD, updatedAt: OLD,
      subtasks: [
        sub("s1", "量尺寸"),
        sub("s2", "过期的那步", { deletedAt: expired }),
        sub("s3", "刚删的那步", { deletedAt: fresh }),
      ],
    });
    localStorage.setItem(LS_KEY, JSON.stringify({ ...dataOf(t), version: 7 }));
    appStore.setState({ loaded: false });
    await initStore();
    const after = getTask(t.id);
    expect(after.subtasks.map((s) => s.id)).toEqual(["s1", "s3"]);
    expect(after.updatedAt).toBe(OLD);
    expect(after.subtasks[1].deletedAt).toBe(fresh);
  });

  it("一条都没到期时任务对象不重建", async () => {
    const fresh = new Date(Date.now() - 3 * 86400000).toISOString();
    const t = newTask({ title: "装修", updatedAt: OLD, subtasks: [sub("s1", "量尺寸"), sub("s2", "刚删", { deletedAt: fresh })] });
    localStorage.setItem(LS_KEY, JSON.stringify({ ...dataOf(t), version: 7 }));
    appStore.setState({ loaded: false });
    await initStore();
    expect(getTask(t.id).subtasks).toHaveLength(2);
    expect(getTask(t.id).updatedAt).toBe(OLD);
  });
});

// ---------------------------------------------------------------------------

describe("aliveSubtasks 在各处生效：回收站里的那步哪儿都不出现", () => {
  const label = (r: { task: { title: string }; sub: Subtask | null }) =>
    r.sub ? `${r.task.title}›${r.sub.title}` : r.task.title;

  it("openRows：删掉的那步不占行；剩下的步全删了母任务行回来收尾", () => {
    const t = newTask({
      title: "装修", due: today,
      subtasks: [sub("s1", "量尺寸"), sub("s2", "选瓷砖", { deletedAt: OLD })],
    });
    expect(openRows(dataOf(t)).map(label)).toEqual(["装修›量尺寸"]);
    const all = newTask({ title: "交税", due: today, subtasks: [sub("s3", "唯一一步", { deletedAt: OLD })] });
    expect(openRows(dataOf(all)).map(label)).toEqual(["交税"]);
  });

  it("rowTaskIds 按件算，删掉一步不改变件数", () => {
    const t = newTask({ title: "装修", due: today, subtasks: [sub("s1", "a"), sub("s2", "b", { deletedAt: OLD })] });
    expect(rowTaskIds(openRows(dataOf(t)))).toEqual([t.id]);
  });

  it("splitSubtasks / foldDoneSubs：两堆都不收回收站里的", () => {
    const subs = [
      sub("s1", "做完的", { done: true }),
      sub("s2", "做完但删了", { done: true, deletedAt: OLD }),
      sub("s3", "还欠着"),
      sub("s4", "欠着但删了", { deletedAt: OLD }),
    ];
    const { open, done } = splitSubtasks(subs);
    expect(open.map((s) => s.id)).toEqual(["s3"]);
    expect(done.map((s) => s.id)).toEqual(["s1"]);
    // 三条做完的里有一条删了 → 只剩两条，不够折叠的阈值
    const many = [
      sub("d1", "1", { done: true }), sub("d2", "2", { done: true }),
      sub("d3", "3", { done: true, deletedAt: OLD }), sub("o", "欠"),
    ];
    expect(foldDoneSubs(many)).toBe(false);
  });

  it("doneRows / droppedRows：删掉的那步不进「已完成」也不进「放弃的」", () => {
    const t = newTask({
      title: "装修",
      subtasks: [
        sub("s1", "做完的", { done: true, doneAt: OLD }),
        sub("s2", "做完但删了", { done: true, doneAt: OLD, deletedAt: OLD }),
        sub("s3", "放弃的", { droppedAt: OLD }),
        sub("s4", "放弃但删了", { droppedAt: OLD, deletedAt: OLD }),
      ],
    });
    expect(doneRows(dataOf(t)).map(label)).toEqual(["装修›做完的"]);
    expect(droppedRows(dataOf(t)).map(label)).toEqual(["装修›放弃的"]);
  });

  it("hasChain：删掉的那步不算进链", () => {
    const [id, , b] = twoSteps();
    expect(hasChain(id)).toBe(true);
    removeSubtask(id, b);
    expect(hasChain(id)).toBe(false);
  });

  it("searchTasks：搜删掉那步的名字搜不到，活着的照样搜得到", () => {
    const t = newTask({ title: "装修", subtasks: [sub("s1", "量尺寸"), sub("s2", "选瓷砖", { deletedAt: OLD })] });
    expect(searchTasks([t], [], "瓷砖")).toEqual([]);
    expect(searchTasks([t], [], "尺寸").map((h) => h.task.id)).toEqual([t.id]);
  });

  it("dropSubtask / toggleSubtask 对回收站里的那步照旧按 id 生效（回收站页没有这两个入口，只是不许炸）", () => {
    const [id, , b] = twoSteps();
    removeSubtask(id, b);
    dropSubtask(id, b, true);
    expect(getTask(id).subtasks[1].droppedAt).toBeTruthy();
    expect(getTask(id).subtasks[1].deletedAt).toBeTruthy();
  });
});

describe("trashedSubtaskRows：回收站页那一列", () => {
  it("只列母任务还活着的；母任务整件事在回收站里时它的子任务不单列", () => {
    const alive = newTask({ title: "装修", subtasks: [sub("s1", "量尺寸"), sub("s2", "选瓷砖", { deletedAt: OLD })] });
    const gone = newTask({ title: "删掉的整件事", deletedAt: OLD, subtasks: [sub("s3", "跟着走", { deletedAt: OLD })] });
    const rows = trashedSubtaskRows(dataOf(alive, gone));
    expect(rows.map((r) => `${r.task.title}›${r.sub!.title}`)).toEqual(["装修›选瓷砖"]);
  });

  it("按删除时间倒着排，最近删的在上面", () => {
    const t = newTask({
      title: "装修",
      subtasks: [
        sub("s1", "早删的", { deletedAt: "2026-08-01T00:00:00.000Z" }),
        sub("s2", "晚删的", { deletedAt: "2026-08-20T00:00:00.000Z" }),
      ],
    });
    expect(trashedSubtaskRows(dataOf(t)).map((r) => r.sub!.title)).toEqual(["晚删的", "早删的"]);
  });

  it("习惯名下删掉的步也列（它跟事共用子任务）", () => {
    const h = newTask({ title: "晨练", kind: "habit", subtasks: [sub("s1", "拉伸", { deletedAt: OLD })] });
    expect(trashedSubtaskRows(dataOf(h))).toHaveLength(1);
  });
});

describe("循环推进：回收站里的那步不进副本、本体上原样不动", () => {
  it("完成一次：已完成副本只带活着的步，本体上删掉的那步 deletedAt 还在、没被当新一轮清洗", () => {
    const id = addTask({ title: "周会", due: today, repeat: { kind: "weekly", days: [1] } });
    addSubtask(id, "写议程");
    addSubtask(id, "订会议室", { due: addDays(today, 1) });
    const gone = getTask(id).subtasks[1].id;
    toggleSubtask(id, gone);
    removeSubtask(id, gone);
    const stamp = getTask(id).subtasks[1].deletedAt;
    completeTask(id);
    const body = getTask(id);
    const copy = appStore.getState().data.tasks.find((t) => t.id !== id)!;
    expect(copy.subtasks.map((s) => s.title)).toEqual(["写议程"]);
    expect(body.subtasks.map((s) => s.title)).toEqual(["写议程", "订会议室"]);
    expect(body.subtasks[1].deletedAt).toBe(stamp);
    // 没被清洗：还带着自己的日期和完成标记（它不属于哪一轮）
    expect(body.subtasks[1].due).toBe(addDays(today, 1));
    expect(body.subtasks[1].done).toBe(true);
    // 活着的那条照旧被清成新一轮
    expect(body.subtasks[0].done).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("回收站页（views/ListView）真的画了子任务那一列", () => {
  it("一行一条「母 › 子 · 还剩 N 天」，带恢复和彻底删除", () => {
    expect(listViewSource).toContain("trashedSubtaskRows(data)");
    expect(listViewSource).toContain('className="task-row trash-sub"');
    expect(listViewSource).toContain("restoreSubtask(r.task.id, r.sub!.id)");
    expect(listViewSource).toContain("purgeSubtask(r.task.id, r.sub!.id)");
    expect(listViewSource).toContain("trashDaysLeft(r.sub!.deletedAt)");
    // 「母 › 子」三段跟 TaskRow 的子任务行同一副标记：窄屏下两段各自省略、「›」永远看得见
    expect(listViewSource).toContain('<span className="chain-parent">{r.task.title || "（未命名）"}</span>');
    expect(listViewSource).toContain('<span className="chain-sep"> › </span>');
    expect(listViewSource).toContain('<span className="chain-self">{r.sub!.title || "（未命名）"}</span>');
  });

  it("空态和「清空回收站」都把子任务算进去", () => {
    expect(listViewSource).toContain("shown.length === 0 && subRows.length === 0");
    expect(listViewSource).toContain("const trashHasStuff = tasks.length > 0 || subRows.length > 0");
    // 两端（桌面顶栏 / 手机 MobileHead）那颗按钮都改用它，不许一边还看着 tasks.length
    expect(listViewSource.match(/kind === "trash" && trashHasStuff/g)?.length).toBe(2);
    expect(listViewSource).not.toContain('kind === "trash" && tasks.length > 0');
  });

  it("回收站里两种行都不进键盘选行：整件事那行和子任务那行一样，都不带 data-task-id", () => {
    // 复核提的：子任务行不在 orderedIds 里，↑↓ 到不了。查下来回收站页整件事那行本来也不走 TaskRow，
    // 是一个不带 data-task-id 的裸 .task-row；App 的 ↑↓ / Delete 只认 `.task-row[data-task-id]`——
    // 回收站这一页从来就没有键盘选行，子任务行跟整件事那行口径一致，不是漏了
    expect(appSource).toContain('document.querySelectorAll<HTMLElement>(".task-row[data-task-id]")');
    const wholeRow = listViewSource.slice(
      listViewSource.indexOf('<div key={t.id} className="task-row">'),
      listViewSource.indexOf("purgeTask(t.id)"),
    );
    const subRow = listViewSource.slice(
      listViewSource.indexOf('className="task-row trash-sub"'),
      listViewSource.indexOf("purgeSubtask(r.task.id, r.sub!.id)"),
    );
    expect(wholeRow.length).toBeGreaterThan(0);
    expect(subRow.length).toBeGreaterThan(0);
    expect(wholeRow).not.toContain("data-task-id");
    expect(subRow).not.toContain("data-task-id");
  });
});

// ---------------------------------------------------------------------------

// 复核挑出的两处「还看着整条 task.subtasks」的地方，**不在本轮可改文件范围里**（另派人补）：
//   · components/TaskRow.tsx 行尾「N/M」进度的分母（第 99 行 counted、第 373 行 title 判据）——
//     两步都做完、第三步删进回收站，今天页显示「2/3」，卡里却只看得见 2 步
//   · components/SearchOverlay.tsx 的 showsToday（第 16 行）——删进回收站但日期是今天的那步
//     会让回车误跳到「今天」页却看不到这件事
// 这一组先 skip 着守门：那两处改成 aliveSubtasks 之后把 .skip 去掉就绿。
describe("TaskRow / SearchOverlay 也走 aliveSubtasks（回收站里的那一步不进分母、不算「今天有这件事」）", () => {
  it("TaskRow 行尾进度「N/M」的分母不算已删的步", () => {
    expect(taskRowSource).toContain("const counted = aliveSubtasks(task).filter((s) => !s.droppedAt)");
    expect(taskRowSource).toContain("counted.length === aliveSubtasks(task).length ? undefined");
    expect(taskRowSource).not.toContain("task.subtasks.filter(");
    expect(taskRowSource).not.toContain("task.subtasks.length");
  });

  it("SearchOverlay 的 showsToday 只看活着的步", () => {
    expect(searchOverlaySource).toContain("const open = aliveSubtasks(t).filter((s) => !s.done)");
    expect(searchOverlaySource).not.toContain("t.subtasks.filter(");
  });
});
