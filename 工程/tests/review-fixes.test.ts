// 2026-08-28 那轮对抗式评审挑出来的毛病，逐条钉住，别再长回去。
// 每个 describe 的标题就是当初那条发现。
import { beforeEach, describe, expect, it } from "vitest";
import { defaultData, newTask } from "../src/core/model";
import type { Priority } from "../src/core/model";
import { addDays, todayYMD } from "../src/core/dates";
import { planGroups } from "../src/core/plan";
import { planFold, rowKey, visibleRows } from "../src/components/RowList";
import type { DateRow, UIState } from "../src/core/store";
import {
  addList, allWho, appStore, completeTasks, moveList, moveWho, undo,
} from "../src/core/store";

const today = todayYMD();

function reset() {
  localStorage.clear();
  appStore.setState({
    data: { ...defaultData(), lists: [], tasks: [] },
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
}
beforeEach(reset);

const ui = (patch: Partial<UIState> = {}): UIState => ({
  ...appStore.getState().ui, ...patch,
});

describe("「按重要性」必须有兜底档，越界的重要性不许整条蒸发", () => {
  function row(title: string, priority: unknown): DateRow {
    return { task: { ...newTask({ title, due: today }), priority: priority as Priority }, sub: null };
  }

  it("priority 是 5 / null / 字符串这类脏数据，一律归「普通」，不会消失", () => {
    const rows = [row("脏5", 5), row("脏null", null), row("脏字符串", "3"), row("正常高", 3)];
    const gs = planGroups(rows, "priority", today);
    const shown = gs.flatMap((g) => g.rows);
    expect(shown).toHaveLength(4);
    expect(gs.find((g) => g.label === "高")!.rows.map((r) => r.task.title)).toEqual(["正常高"]);
    expect(gs.find((g) => g.label === "普通")!.rows.map((r) => r.task.title).sort()).toEqual(
      ["脏5", "脏null", "脏字符串"],
    );
  });

  it("正常的四档还是各归各位", () => {
    const rows = [row("a", 3), row("b", 2), row("c", 1), row("d", 0)];
    const gs = planGroups(rows, "priority", today);
    expect(gs.map((g) => g.rows.map((r) => r.task.title).join())).toEqual(["a", "b", "c", "d"]);
  });
});

describe("「收起子任务」得整页只留一行，不是每段留一行", () => {
  // 一件事的四条子任务分别落在 一周内 / 一个月内 / 半年内 —— 子任务各带日期本来就是常态
  const t = newTask({
    title: "装修",
    due: today,
    subtasks: [
      { id: "s1", title: "量尺寸", done: false, due: addDays(today, 1), dueTime: null, priority: null },
      { id: "s2", title: "选瓷砖", done: false, due: addDays(today, 2), dueTime: null, priority: null },
      { id: "s3", title: "找工人", done: false, due: addDays(today, 20), dueTime: null, priority: null },
      { id: "s4", title: "验收", done: false, due: addDays(today, 100), dueTime: null, priority: null },
    ],
  });
  const rows: DateRow[] = t.subtasks.map((s) => ({ task: t, sub: s }));

  it("收起后整个视图只剩一行，+N 数的是全部四条里剩下的三条", () => {
    const fold = planFold(rows, ui({ foldAll: true }));
    const groups = planGroups(rows, "time", today);
    const left = groups.flatMap((g) => visibleRows(g.rows, fold));
    expect(left.map((r) => r.sub!.title)).toEqual(["量尺寸"]);
    expect(fold.more.get(rowKey(left[0]))).toBe(3);
  });

  it("摊开时四行都在，小三角只挂在头一行", () => {
    const fold = planFold(rows, ui({ foldAll: false }));
    const groups = planGroups(rows, "time", today);
    const left = groups.flatMap((g) => visibleRows(g.rows, fold));
    expect(left).toHaveLength(4);
    expect([...fold.head]).toEqual([rowKey(rows[0])]);
    expect(fold.more.size).toBe(0);
  });

  it("只有一条子任务的事没有「链」，不给小三角", () => {
    const one = newTask({
      title: "买牛奶",
      subtasks: [{ id: "x", title: "去超市", done: false, due: null, dueTime: null, priority: null }],
    });
    const fold = planFold([{ task: one, sub: one.subtasks[0] }], ui({ foldAll: true }));
    expect(fold.head.size).toBe(0);
    expect(fold.hidden.size).toBe(0);
  });
});

describe("侧栏拖着换顺序：落到目标**上面**，跟那条落点线一致", () => {
  it("往下拖：把第一张拖到第三张上面 → 顺序是 二 一 三", () => {
    const a = addList("一", "clay");
    addList("二", "moss");
    const c = addList("三", "sea");
    moveList(a, c);
    const names = [...appStore.getState().data.lists].sort((x, y) => x.order - y.order).map((l) => l.name);
    expect(names).toEqual(["二", "一", "三"]);
  });

  it("往上拖：把第三张拖到第一张上面 → 顺序是 三 一 二", () => {
    const a = addList("一", "clay");
    addList("二", "moss");
    const c = addList("三", "sea");
    moveList(c, a);
    const names = [...appStore.getState().data.lists].sort((x, y) => x.order - y.order).map((l) => l.name);
    expect(names).toEqual(["三", "一", "二"]);
  });

  it("拖清单换顺序进撤销栈：Ctrl+Z 撤的就是这一下，不是上一件不相干的事", () => {
    const a = addList("一", "clay");
    addList("二", "moss");
    const c = addList("三", "sea");
    const before = [...appStore.getState().data.lists].sort((x, y) => x.order - y.order).map((l) => l.name);
    moveList(c, a);
    undo();
    const after = [...appStore.getState().data.lists].sort((x, y) => x.order - y.order).map((l) => l.name);
    expect(after).toEqual(before);
  });

  it("需求方同一套方向", () => {
    appStore.setState({
      data: {
        ...appStore.getState().data,
        tasks: [
          newTask({ title: "a", who: ["甲"] }),
          newTask({ title: "b", who: ["甲"] }),
          newTask({ title: "c", who: ["乙"] }),
          newTask({ title: "d", who: ["丙"] }),
        ],
      },
    });
    // 初始按未完成数：甲(2) 乙(1) 丙(1) → 乙丙同数按名字
    const start = allWho(appStore.getState().data).map((w) => w.who);
    moveWho(start[2], start[0]); // 把第三个拖到第一个上面
    expect(allWho(appStore.getState().data).map((w) => w.who)).toEqual([start[2], start[0], start[1]]);
  });
});

describe("多选一次完成：撤销要能一把全撤回来", () => {
  it("三件一起完成，Ctrl+Z 一次全回来（不是只回来最后一件）", () => {
    const ts = ["甲", "乙", "丙"].map((n) => newTask({ title: n, due: today }));
    appStore.setState({ data: { ...appStore.getState().data, tasks: ts } });
    completeTasks(ts.map((t) => t.id));
    expect(appStore.getState().data.tasks.filter((t) => t.done)).toHaveLength(3);
    undo();
    expect(appStore.getState().data.tasks.filter((t) => t.done)).toHaveLength(0);
  });

  it("提示写明白是几件，并且标着可撤销", () => {
    const ts = ["甲", "乙"].map((n) => newTask({ title: n }));
    appStore.setState({ data: { ...appStore.getState().data, tasks: ts } });
    completeTasks(ts.map((t) => t.id));
    const toast = appStore.getState().ui.toast;
    expect(toast?.msg).toContain("2 件");
    expect(toast?.undoable).toBe(true);
  });

  it("只选一件时走单件那条路，行为不变", () => {
    const t = newTask({ title: "独苗" });
    appStore.setState({ data: { ...appStore.getState().data, tasks: [t] } });
    completeTasks([t.id]);
    expect(appStore.getState().data.tasks[0].done).toBe(true);
    undo();
    expect(appStore.getState().data.tasks[0].done).toBe(false);
  });

  it("习惯混在多选里不会被误标成「做完了」（习惯没有完成这回事）", () => {
    const h = newTask({ title: "喝水", kind: "habit" });
    const t = newTask({ title: "交表" });
    appStore.setState({ data: { ...appStore.getState().data, tasks: [h, t] } });
    completeTasks([h.id, t.id]);
    const now = appStore.getState().data.tasks;
    expect(now.find((x) => x.id === h.id)!.done).toBe(false);
    expect(now.find((x) => x.id === t.id)!.done).toBe(true);
  });
});
