import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Plan from "../src/views/Plan";
import Today from "../src/views/Today";
import Sidebar from "../src/components/Sidebar";
import { defaultData, newTask, type Subtask, type Task } from "../src/core/model";
import { appStore, flushSave, openRows, postponeRowsTo, undo, updateTask } from "../src/core/store";
import { mergeParentRows, overdueParentActions, parentRowsForToday, pendingChildRows } from "../src/core/parentRows";
import { parentFoldStore, parentFolded, setAllParentFolded, setParentFolded } from "../src/core/parentFold";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const TODAY = "2026-10-20", PAST = "2026-10-19", FUTURE = "2026-10-23";
const step = (id: string, patch: Partial<Subtask> = {}): Subtask => ({ id, title: id, done: false, ...patch });
let root: Root, host: HTMLDivElement;
const click = (el: Element) => act(() => (el as HTMLElement).click());
const mother = (id = "parent") => host.querySelector<HTMLElement>(`.task-row[data-parent-row="true"][data-task-id="${id}"]`)!;
const visible = () => [...host.querySelectorAll<HTMLElement>(".row-slot:not(.shut) > .task-row")];
const children = () => visible().filter((el) => el.dataset.subId).map((el) => el.dataset.subId);
function put(tasks: Task[]) { appStore.setState({ data: { ...defaultData(), tasks } }); }
function render(tasks: Task[], view: "plan" | "today" = "plan", priority = false) {
  act(() => { put(tasks); if (priority) appStore.setState({ data: { ...appStore.getState().data, settings: { ...appStore.getState().data.settings, sortMode: "priority" } } }); root.render(createElement(view === "plan" ? Plan : Today)); });
}
function input(el: HTMLInputElement, value: string) {
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); });
}
beforeEach(async () => {
  await flushSave(); while (appStore.getState().undoDepth) undo(); await flushSave();
  localStorage.clear(); parentFoldStore.setState({ foldAll: true, foldExcept: [] });
  appStore.setState({ data: defaultData(), loaded: true, wiped: false, loadError: null, undoDepth: 0, ui: { ...appStore.getState().ui, expandedId: null, selectedIds: [], ctxMenu: null, foldAll: false, foldExcept: [] } });
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-20T12:00:00+08:00"));
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { act(() => root.unmount()); document.body.innerHTML = ""; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); await flushSave(); });

describe("桌面母子任务树：真实Plan/Today", () => {
  it.each(["plan", "today"] as const)("%s默认只显示母任务；caret展开所有待办，母行保留，行点击独立打开卡", (view) => {
    const task = newTask({ id: "parent", title: "发布准备", due: TODAY, subtasks: [step("今天", { due: TODAY }), step("未来", { due: FUTURE }), step("完成", { done: true }), step("放弃", { droppedAt: "2026-10-19T12:00:00Z" }), step("删除", { deletedAt: "2026-10-19T12:00:00Z" })] });
    render([task], view); const before = appStore.getState().data;
    expect(visible().map((el) => el.querySelector(".title")!.textContent)).toEqual(["发布准备"]);
    expect(mother().querySelector(".chain-more")!.textContent).toBe("+2");
    click(mother().querySelector("button.chain-caret")!);
    expect(children()).toEqual(["今天", "未来"]);
    expect(visible()).toHaveLength(3); expect(host.querySelector(".task-card")).toBeNull();
    expect(appStore.getState().data).toBe(before);
    click(mother().querySelector(".title")!);
    expect(host.querySelectorAll(".task-card")).toHaveLength(1);
    expect(appStore.getState().ui.expandedId).toBe(task.id);
  });

  it("0/1条子任务边界：没有待办不出caret，只有一条也能展开并显示母子两行", () => {
    render([newTask({ id: "empty", title: "独立任务" }), newTask({ id: "parent", title: "只有一步", subtasks: [step("一步")] })]);
    expect(mother("empty").querySelector("button.chain-caret")).toBeNull();
    click(mother().querySelector("button.chain-caret")!);
    expect(children()).toEqual(["一步"]); expect(visible()).toHaveLength(3);
  });

  it("折叠子行inert且aria隐藏，展开后恢复；点击后定位真实卡内对应步骤", () => {
    render([newTask({ id: "parent", title: "定位", due: TODAY, subtasks: Array.from({ length: 5 }, (_, i) => step(`第${i + 1}步`)) })]);
    const child = host.querySelector<HTMLElement>('.task-row[data-sub-id="第5步"]')!;
    expect(child.parentElement!.hasAttribute("inert")).toBe(true); expect(child.parentElement!.getAttribute("aria-hidden")).toBe("true");
    click(mother().querySelector("button.chain-caret")!);
    expect(child.parentElement!.hasAttribute("inert")).toBe(false); expect(child.parentElement!.hasAttribute("aria-hidden")).toBe(false);
    click(child.querySelector(".title")!);
    expect(host.querySelector('.task-card [data-subtask-id="第5步"]')!.classList.contains("quad-located")).toBe(true);
    expect(localStorage.getItem("acorn-card-subtasks-folded")).toBeNull();
  });

  it("母checkbox完成整件事，Shift跨母连选仍按件去重", () => {
    const task = newTask({ id: "parent", title: "首件", due: TODAY, order: 0, subtasks: [step("一步"), step("两步")] });
    render([task, newTask({ id: "middle", title: "中间件", due: TODAY, order: 1 }), newTask({ id: "last", title: "最后件", due: TODAY, order: 2 })]);
    act(() => mother().dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true })));
    act(() => mother("last").dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true })));
    expect(appStore.getState().ui.selectedIds).toEqual(["parent", "middle", "last"]);
    click(mother().querySelector("button.cb")!); act(() => vi.runOnlyPendingTimers());
    const after = appStore.getState().data.tasks[0]; expect(after.done).toBe(true); expect(after.subtasks).toEqual(task.subtasks);
    expect(host.querySelector('.task-row[data-task-id="parent"]')).toBeNull();
    expect(appStore.getState().data.tasks[1].done).toBe(false);
  });

  it("Plan母手排日期优先，无手排才从最近子日期归组；搜索子标题保留母任务", () => {
    const manual = newTask({ id: "parent", title: "手排日期", due: FUTURE, subtasks: [step("搜索目标", { due: TODAY })] });
    const derived = newTask({ id: "derived", title: "取最近子", due: null, subtasks: [step("明天", { due: FUTURE }), step("今天", { due: TODAY })] });
    render([manual, derived]);
    const labels = () => [...host.querySelectorAll(".group-head,.task-row[data-parent-row]")].map((el) => el.textContent);
    const text = labels().join("|"); expect(text.indexOf("今天")).toBeLessThan(text.indexOf("取最近子"));
    expect(text.indexOf("取最近子")).toBeLessThan(text.indexOf("本周")); expect(text.indexOf("本周")).toBeLessThan(text.indexOf("手排日期"));
    expect(mother().textContent).toContain("10月23");
    input(host.querySelector(".plan-search input")!, "搜索目标");
    expect(visible()).toHaveLength(1); expect(mother().textContent).toContain("手排日期");
    click(mother().querySelector("button.chain-caret")!); expect(children()).toEqual(["搜索目标"]);
  });

  it("按重要性分组时展开的子任务仍时间主、同刻重要性次，改母重要性即时更新继承排序", () => {
    const task = newTask({ id: "parent", title: "排序", due: TODAY, dueTime: "10:00", priority: 1, subtasks: [
      step("十点低", { priority: 1 }), step("十点高", { priority: 3 }), step("九点低", { dueTime: "09:00", priority: 1 }), step("十点继承"),
    ] }); render([task], "plan", true); click(mother().querySelector("button.chain-caret")!);
    expect(children()).toEqual(["九点低", "十点高", "十点低", "十点继承"]);
    act(() => updateTask(task.id, { priority: 3 }));
    expect(children()).toEqual(["九点低", "十点高", "十点继承", "十点低"]);
    expect(appStore.getState().data.tasks[0].subtasks[3].priority).toBeUndefined();
  });

  it("Today跨逾期/今日只出现一个母行；母安排今天且全部子未来也保留", () => {
    render([newTask({ id: "parent", title: "混合日程", due: FUTURE, subtasks: [step("过期", { due: PAST }), step("今天", { due: TODAY }), step("未来", { due: FUTURE })] }), newTask({ id: "manual", title: "今天的母安排", due: TODAY, subtasks: [step("明天做", { due: FUTURE })] })], "today");
    expect(host.querySelectorAll('.task-row[data-parent-row="true"]')).toHaveLength(2);
    expect(host.querySelector(".day-foot")!.textContent).toContain("完成 0 / 2");
    click(mother().querySelector("button.chain-caret")!); expect(children()).toEqual(["过期", "今天", "未来"]);
  });

  it("侧栏今日角标与实际合并母行件数一致，完成后即时刷新", () => {
    act(() => {
      put([newTask({ id: "parent", title: "跨逾期和今日", due: FUTURE, subtasks: [step("过期", { due: PAST }), step("今天", { due: TODAY })] }), newTask({ id: "manual", title: "母排今天子未来", due: TODAY, subtasks: [step("未来", { due: FUTURE })] })]);
      root.render(createElement(Fragment, null, createElement(Sidebar), createElement(Today)));
    });
    const count = () => host.querySelector('[data-sidebar-module="today"] .n')!.textContent;
    expect(count()).toBe("2"); expect(host.querySelectorAll('.task-row[data-parent-row="true"]')).toHaveLength(2);
    act(() => updateTask("parent", { done: true }));
    expect(count()).toBe("1"); expect(host.querySelectorAll('.task-row[data-parent-row="true"]')).toHaveLength(1);
  });

  it("合并母行全部顺延只改实际过期owner，未来子日期保留，继承不固化；一次撤销复原", () => {
    const task = newTask({ id: "parent", title: "顺延", due: PAST, subtasks: [step("继承"), step("自己过期", { due: "2026-10-18" }), step("未来", { due: FUTURE })] });
    render([task], "today"); const before = appStore.getState().data;
    click([...host.querySelectorAll(".group-head button")].find((b) => b.textContent?.includes("全部顺延"))!);
    click([...document.querySelectorAll(".pp-menu button")].find((b) => b.textContent?.startsWith("今天"))!);
    expect(appStore.getState().data.tasks[0].due).toBe(TODAY);
    expect(appStore.getState().data.tasks[0].subtasks.map((s) => s.due)).toEqual([undefined, TODAY, FUTURE]);
    expect(appStore.getState().undoDepth).toBe(1); act(() => undo()); expect(appStore.getState().data).toEqual(before);
  });

  it("展开子行的完成只改子，Ctrl多选/拖动按原有任务身份，母行与子拖动payload分开", () => {
    const task = newTask({ id: "parent", title: "身份", due: TODAY, subtasks: [step("一步"), step("两步")] });
    render([task, newTask({ id: "other", title: "另一件" })]); click(mother().querySelector("button.chain-caret")!);
    const child = host.querySelector<HTMLElement>('.task-row[data-sub-id="一步"]')!;
    act(() => child.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true })));
    act(() => mother("other").dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true })));
    expect(appStore.getState().ui.selectedIds).toEqual(["parent", "other"]);
    function drag(row: HTMLElement) { const values: Record<string, string> = {}; const ev = new Event("dragstart", { bubbles: true }); Object.defineProperty(ev, "dataTransfer", { value: { setData: (k: string, v: string) => values[k] = v } }); act(() => row.dispatchEvent(ev)); return values; }
    expect(drag(child)).toMatchObject({ "text/acorn-sub": "parent:一步", "text/acorn-task": "parent" });
    expect(drag(mother())).toEqual({ "text/acorn-task": "parent,other" });
    click(child.querySelector("button.cb")!); act(() => vi.runOnlyPendingTimers());
    expect(appStore.getState().data.tasks[0].done).toBe(false); expect(appStore.getState().data.tasks[0].subtasks[0].done).toBe(true);
  });

  it("展开卡在日期/搜索变化时保持同一DOM与草稿", () => {
    render([newTask({ id: "parent", title: "检索命中", due: TODAY, subtasks: [step("一步", { due: TODAY })] })]);
    input(host.querySelector(".plan-search input")!, "命中"); click(mother().querySelector(".title")!);
    const card = host.querySelector(".task-card")!;
    act(() => updateTask("parent", { due: "2027-01-01", title: "不再匹配" }));
    expect(host.querySelector(".task-card")).toBe(card); expect(host.querySelectorAll(".task-card")).toHaveLength(1);
  });
});

describe("合并行派生与本机状态边界", () => {
  it("默认收起、单例/总开关幂等，不改旧折叠偏好或账本", () => {
    const before = appStore.getState().data; const old = appStore.getState().ui;
    expect(parentFolded(parentFoldStore.getState(), "a")).toBe(true);
    setParentFolded("a", false); setParentFolded("a", false); expect(parentFoldStore.getState().foldExcept).toEqual(["a"]);
    setAllParentFolded(false); expect(parentFoldStore.getState().foldExcept).toEqual([]); expect(parentFolded(parentFoldStore.getState(), "b")).toBe(false);
    expect(localStorage.getItem("acorn-parent-fold")).toContain("foldAll"); expect(localStorage.getItem("acorn-fold")).toBeNull();
    expect(appStore.getState().data).toBe(before); expect(appStore.getState().ui).toBe(old);
  });
  it("过滤完成/放弃/删除母与子，不改原始子数组，派生日期不会变成手排", () => {
    const parent = newTask({ id: "parent", title: "派生", due: null, subtasks: [step("未来", { due: FUTURE }), step("过期", { due: PAST }), step("完成", { done: true, due: PAST })] });
    const data = { ...defaultData(), tasks: [parent, newTask({ title: "完成母", done: true }), newTask({ title: "放弃母", droppedAt: "2026-10-19T12:00:00Z" }), newTask({ title: "删除母", deletedAt: "2026-10-19T12:00:00Z" })] };
    const before = JSON.stringify(data); const rows = mergeParentRows(openRows(data)); expect(rows).toHaveLength(1);
    expect(pendingChildRows(parent).map((r) => r.sub!.id)).toEqual(["过期", "未来"]);
    expect(parentRowsForToday(data, TODAY).overdue).toEqual(rows);
    expect(overdueParentActions(parent, TODAY).map((r) => r.sub?.id)).toEqual(["过期"]);
    expect(JSON.stringify(data)).toBe(before); expect(parent.due).toBeNull();
  });
});
