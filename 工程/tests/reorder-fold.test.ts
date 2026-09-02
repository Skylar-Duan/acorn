// 2026-08-28 需求单里三件「顺手但容易做错」的事：
//   · 第 10 条 子任务链可折叠
//   · 第 16 条 清单和需求方可拖动调换顺序
//   · 第 15 条 勾掉一件事之后它去哪了（得有话说，不能就这么没了）
import { beforeEach, describe, expect, it } from "vitest";
import { defaultData, newTask } from "../src/core/model";
import {
  addList, allWho, appStore, completeTask, isChainFolded, moveList, moveWho,
  setFoldAll, toggleChain,
} from "../src/core/store";

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

describe("子任务链折叠", () => {
  const ui = () => appStore.getState().ui;

  it("默认摊开", () => {
    expect(isChainFolded(ui(), "t1")).toBe(false);
  });

  it("总开关一拉，所有事都收起", () => {
    setFoldAll(true);
    expect(isChainFolded(ui(), "t1")).toBe(true);
    expect(isChainFolded(ui(), "t2")).toBe(true);
  });

  it("单条小三角跟总开关反着来", () => {
    toggleChain("t1");
    expect(isChainFolded(ui(), "t1")).toBe(true);
    expect(isChainFolded(ui(), "t2")).toBe(false);
    // 再点一次回去
    toggleChain("t1");
    expect(isChainFolded(ui(), "t1")).toBe(false);
  });

  it("总开关全收起时，单条例外就是「只摊开这一件」", () => {
    setFoldAll(true);
    toggleChain("t1");
    expect(isChainFolded(ui(), "t1")).toBe(false);
    expect(isChainFolded(ui(), "t2")).toBe(true);
  });

  it("再拉一次总开关会把例外清掉——否则用户点完发现还有几条不听话", () => {
    toggleChain("t1");
    setFoldAll(true);
    expect(ui().foldExcept).toEqual([]);
    expect(isChainFolded(ui(), "t1")).toBe(true);
  });

  it("状态存本机，不写进数据（换台设备用什么样子是那台设备的事）", () => {
    setFoldAll(true);
    expect(localStorage.getItem("acorn-fold")).toContain("foldAll");
    expect(JSON.stringify(appStore.getState().data)).not.toContain("foldAll");
  });
});

describe("清单拖着换位置", () => {
  it("把第三张拖到第一张头上，顺序就变成 3 1 2", () => {
    const a = addList("工作", "clay");
    const b = addList("生活", "moss");
    const c = addList("开发", "sea");
    moveList(c, a);
    const names = [...appStore.getState().data.lists]
      .sort((x, y) => x.order - y.order)
      .map((l) => l.name);
    expect(names).toEqual(["开发", "工作", "生活"]);
    expect(a && b).toBeTruthy();
  });

  it("order 重排成连号，不留空洞", () => {
    const a = addList("一", "clay");
    addList("二", "moss");
    const c = addList("三", "sea");
    moveList(a, c);
    const orders = [...appStore.getState().data.lists].map((l) => l.order).sort((x, y) => x - y);
    expect(orders).toEqual([0, 1, 2]);
  });

  it("拖到自己头上什么都不发生", () => {
    const a = addList("一", "clay");
    const before = appStore.getState().data.lists;
    moveList(a, a);
    expect(appStore.getState().data.lists).toBe(before);
  });
});

describe("需求方拖着换位置", () => {
  function seed() {
    appStore.setState({
      data: {
        ...appStore.getState().data,
        tasks: [
          newTask({ title: "a", who: ["李哥"] }),
          newTask({ title: "b", who: ["李哥"] }),
          newTask({ title: "c", who: ["王姐"] }),
          newTask({ title: "d", who: ["张总"] }),
        ],
      },
    });
  }

  it("没排过时按未完成数降序（老口径不变）", () => {
    seed();
    expect(allWho(appStore.getState().data).map((w) => w.who)).toEqual(["李哥", "张总", "王姐"]);
  });

  it("拖过之后照手排的来", () => {
    seed();
    moveWho("王姐", "李哥");
    expect(allWho(appStore.getState().data).map((w) => w.who)).toEqual(["王姐", "李哥", "张总"]);
  });

  it("排完再冒出来的新人接在后面，不会把手排的顺序顶掉", () => {
    seed();
    moveWho("王姐", "李哥");
    appStore.setState({
      data: {
        ...appStore.getState().data,
        tasks: [...appStore.getState().data.tasks, newTask({ title: "e", who: ["新同事"] })],
      },
    });
    expect(allWho(appStore.getState().data).map((w) => w.who)).toEqual(["王姐", "李哥", "张总", "新同事"]);
  });

  it("顺序存在设置里（每台设备各排各的）", () => {
    seed();
    moveWho("王姐", "李哥");
    expect(appStore.getState().data.settings.whoOrder).toEqual(["王姐", "李哥", "张总"]);
  });
});

describe("勾掉一件事之后", () => {
  it("会说一句「收进已完成了」并且能撤销——不能就这么无声无息地没了", () => {
    const t = newTask({ title: "核对 HTML 编辑器" });
    appStore.setState({ data: { ...appStore.getState().data, tasks: [t] } });
    completeTask(t.id);
    const toast = appStore.getState().ui.toast;
    expect(toast?.msg).toContain("已完成");
    expect(toast?.undoable).toBe(true);
  });

  it("对已经完成的再勾一次不会重复弹提示", () => {
    const t = newTask({ title: "已经做完的", done: true, doneAt: new Date().toISOString() });
    appStore.setState({ data: { ...appStore.getState().data, tasks: [t] } });
    completeTask(t.id);
    expect(appStore.getState().ui.toast).toBeNull();
  });
});
