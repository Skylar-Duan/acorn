// 撤销栈的合并（v1.9.0 · A5）：连着打字只落一张快照，**停手** 800ms 才另起一张。
// 动的是 store.ts 的 mutate——全应用唯一的写入口，所以这一份单测把三条底线都钉住：
//   ① 逐键落库一个字都不能少（合并的只是撤销快照）
//   ② 云同步靠的「最后改动时刻」照旧每次都盖（stampChanged 没被绕过去）
//   ③ 两条不同任务、同一任务的不同字段，永远不并成一张
// 时间用假时钟推：mutate 里判的是 Date.now()，vitest 的假时钟会把它一起顶上去。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addSubtask, addTask, appStore, completeTask, flushSave, undo, updateSubtask, updateTask,
} from "../src/core/store";
import { defaultData } from "../src/core/model";
import type { Task } from "../src/core/model";

function depth(): number {
  return appStore.getState().undoDepth;
}

function getTask(id: string): Task {
  const t = appStore.getState().data.tasks.find((x) => x.id === id);
  if (!t) throw new Error(`task ${id} not found`);
  return t;
}

/** 敲一个字：在原标题后面接一个字符，然后把表推 ms 毫秒 */
function type(id: string, ch: string, ms: number) {
  updateTask(id, { title: getTask(id).title + ch });
  vi.advanceTimersByTime(ms);
}

beforeEach(async () => {
  vi.useRealTimers();
  while (depth() > 0) undo();
  await flushSave();
  localStorage.clear();
  appStore.setState({
    data: defaultData(),
    loaded: true,
    loadError: null,
    dataFromNewer: null,
    rescue: null,
    wiped: false,
    ui: {
      view: "today", listId: null, who: null, tag: null,
      expandedId: null, selectedIds: [], searchOpen: false, paletteOpen: false, toast: null,
      ctxMenu: null, foldAll: false, foldExcept: [], changelogOpen: false,
    },
    focus: { taskId: null, running: false, endsAt: null, totalMinutes: 0 },
    undoDepth: 0,
  });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("撤销栈合并：连续输入", () => {
  it("同一个标题连着敲五个字，撤销栈只多一张", () => {
    const id = addTask({ title: "报" });
    expect(depth()).toBe(1);
    for (const ch of "告初稿写完") type(id, ch, 100);
    expect(getTask(id).title).toBe("报告初稿写完");
    expect(depth()).toBe(2); // 建任务一张 + 这一串输入一张
  });

  it("每敲一个字都重置计时：500ms 一个字敲六个，跨度 2.5 秒仍然只有一张", () => {
    const id = addTask({ title: "季" });
    for (const ch of "度复盘会材") type(id, ch, 500);
    expect(depth()).toBe(2);
  });

  it("停手超过 800ms 再打，另起一张", () => {
    const id = addTask({ title: "周" });
    type(id, "报", 100);
    expect(depth()).toBe(2);
    vi.advanceTimersByTime(900); // 停手
    type(id, "初", 100);
    expect(depth()).toBe(3);
  });

  it("正好卡在 800ms 上算「停手了」（窗口是开区间）", () => {
    const id = addTask({ title: "甲" });
    type(id, "乙", 800);
    type(id, "丙", 100);
    expect(depth()).toBe(3);
  });

  it("日期弹层里连着改日期只落一张：due 和 dueTime 一起写才算「同一次在改日期」", () => {
    const id = addTask({ title: "有日期的" });
    const before = depth();
    // 原生 date 控件用键盘改，每改一段发一次 change，走的都是 commitDraft 那一个出口
    updateTask(id, { due: "2026-09-10", dueTime: null });
    vi.advanceTimersByTime(50);
    updateTask(id, { due: "2026-09-11", dueTime: null });
    vi.advanceTimersByTime(50);
    updateTask(id, { due: "2026-09-12", dueTime: "09:00" });
    expect(depth()).toBe(before + 1);
    undo();
    expect(getTask(id).due).toBeNull();
  });

  it("撤一下退回的是「刚才那件事」，不是「刚才那个字」", () => {
    const id = addTask({ title: "原名" });
    for (const ch of "改成新的") type(id, ch, 100);
    expect(getTask(id).title).toBe("原名改成新的");
    undo();
    expect(getTask(id).title).toBe("原名");
  });
});

describe("撤销栈合并：不该并的一律不并", () => {
  it("两件事各改各的标题，两张快照", () => {
    const a = addTask({ title: "A" });
    const b = addTask({ title: "B" });
    const before = depth();
    updateTask(a, { title: "A1" });
    vi.advanceTimersByTime(50);
    updateTask(b, { title: "B1" });
    expect(depth()).toBe(before + 2);
  });

  it("同一件事的标题和备注不并", () => {
    const id = addTask({ title: "T" });
    const before = depth();
    updateTask(id, { title: "T1" });
    vi.advanceTimersByTime(50);
    updateTask(id, { notes: "备注" });
    expect(depth()).toBe(before + 2);
  });

  it("两条子任务各改各的标题，两张快照", () => {
    const id = addTask({ title: "母任务" });
    addSubtask(id, "一");
    addSubtask(id, "二");
    const subs = getTask(id).subtasks;
    const before = depth();
    updateSubtask(id, subs[0].id, { title: "一改" });
    vi.advanceTimersByTime(50);
    updateSubtask(id, subs[1].id, { title: "二改" });
    expect(depth()).toBe(before + 2);
  });

  it("中间夹一次别的操作就断链：回头再打字要另起一张", () => {
    const id = addTask({ title: "X" });
    const other = addTask({ title: "顺手完成的那件" });
    const before = depth();
    updateTask(id, { title: "X1" });
    vi.advanceTimersByTime(50);
    completeTask(other);
    vi.advanceTimersByTime(50);
    updateTask(id, { title: "X2" });
    expect(depth()).toBe(before + 3);
  });

  it("不是纯文本字段的连续改动照旧一次一张（点日期不该被合并掉）", () => {
    const id = addTask({ title: "有日期的" });
    const before = depth();
    updateTask(id, { due: "2026-09-02" });
    vi.advanceTimersByTime(50);
    updateTask(id, { due: "2026-09-03" });
    expect(depth()).toBe(before + 2);
  });

  it("一次改好几个字段（整句改）不并进正在打字的那张", () => {
    const id = addTask({ title: "一句话" });
    const before = depth();
    updateTask(id, { title: "一句话改完" });
    vi.advanceTimersByTime(50);
    updateTask(id, { title: "整句改", priority: 3 });
    expect(depth()).toBe(before + 2);
  });

  it("撤销之后接着打字，不会并进已经不在栈顶的那张", () => {
    const id = addTask({ title: "起" });
    type(id, "点", 100);
    expect(depth()).toBe(2);
    undo();
    expect(depth()).toBe(1);
    updateTask(id, { title: "起步" });
    expect(depth()).toBe(2);
    undo();
    expect(getTask(id).title).toBe("起");
  });
});

describe("合并不许动的三条底线", () => {
  it("逐键落库照旧：每敲一个字，库里立刻就是新的那一串", () => {
    const id = addTask({ title: "" });
    const seen: string[] = [];
    for (const ch of "一个字都不能丢") {
      updateTask(id, { title: getTask(id).title + ch });
      seen.push(getTask(id).title);
      vi.advanceTimersByTime(60);
    }
    expect(seen[0]).toBe("一");
    expect(seen[seen.length - 1]).toBe("一个字都不能丢");
  });

  it("合并期间照旧盖「最后改动时刻」——云同步靠它判这条动没动过", () => {
    const id = addTask({ title: "同" });
    const t0 = getTask(id).updatedAt;
    vi.advanceTimersByTime(100);
    updateTask(id, { title: "同步" });
    const t1 = getTask(id).updatedAt;
    vi.advanceTimersByTime(100);
    updateTask(id, { title: "同步戳" }); // 这一下并进上一张快照
    const t2 = getTask(id).updatedAt;
    expect(t1 > t0).toBe(true);
    expect(t2 > t1).toBe(true); // 并了快照，戳照样往前走
  });

  it("上限是 10 张：压满之后最老的那张被挤掉", () => {
    const id = addTask({ title: "最老的那次改动" });
    for (let i = 0; i < 15; i++) {
      addTask({ title: `第 ${i} 条` });
      vi.advanceTimersByTime(50);
    }
    expect(depth()).toBe(10);
    // 撤到底也回不到「只有一件事」的那一刻——超出上限的历史确实被丢掉了
    while (depth() > 0) undo();
    expect(appStore.getState().data.tasks.length).toBeGreaterThan(1);
    expect(getTask(id).title).toBe("最老的那次改动");
  });
});
