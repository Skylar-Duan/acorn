import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TaskCard from "../src/components/TaskCard";
import { TaskSheetHost } from "../src/mobile/TaskSheet";
import { closeAllSheets, openSheet } from "../src/mobile/sheetStore";
import { appStore, flushSave, undo, updateSubtask, updateTask, useApp } from "../src/core/store";
import { defaultData, newTask, type Subtask, type Task } from "../src/core/model";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
const getTask = () => appStore.getState().data.tasks[0];
const sub = (id: string, patch: Partial<Subtask> = {}): Subtask => ({ id, title: id, done: false, ...patch });
function CardHarness() { return createElement(TaskCard, { task: useApp((s) => s.data.tasks[0]) }); }
function renderTask(task: Task, mobile: boolean) {
  act(() => {
    appStore.setState({ data: { ...defaultData(), tasks: [task] } });
    if (mobile) openSheet({ kind: "task", taskId: task.id });
    root.render(createElement(mobile ? TaskSheetHost : CardHarness));
  });
}
function titles(mobile: boolean) {
  return [...document.querySelectorAll<HTMLTextAreaElement | HTMLButtonElement>(mobile ? ".msh-subwrap:not(.done) .msh-subtitle" : ".task-card .sub-row[data-subtask-id]:not(.done) textarea")].map((el) => el instanceof HTMLTextAreaElement ? el.value : el.textContent);
}
beforeEach(async () => {
  await flushSave(); while (appStore.getState().undoDepth) undo(); await flushSave();
  localStorage.clear(); closeAllSheets();
  appStore.setState({ data: defaultData(), loaded: true, loadError: null, wiped: false, undoDepth: 0, ui: { ...appStore.getState().ui, expandedId: null, ctxMenu: null } });
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-20T12:00:00+08:00"));
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => {
  act(() => root.unmount()); closeAllSheets(); document.body.innerHTML = "";
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); await flushSave();
});

describe.each([false, true])("真实子任务排序，mobile=%s", (mobile) => {
  it("界面先按时间，再按重要性，修改日期/重要性即时重排且不改原数组", () => {
    const task = newTask({ id: "parent", title: "排序演示", due: "2026-10-20", dueTime: "10:00", priority: 2, subtasks: [
      sub("同刻低", { priority: 1 }), sub("明天高", { due: "2026-10-21", priority: 3 }),
      sub("同刻高", { priority: 3 }), sub("上午无", { dueTime: "09:00", priority: 0 }),
    ] });
    const before = JSON.stringify(task); renderTask(task, mobile);
    expect(titles(mobile)).toEqual(["上午无", "同刻高", "同刻低", "明天高"]);
    act(() => updateSubtask(task.id, "同刻低", { dueTime: "08:00" }));
    expect(titles(mobile)).toEqual(["同刻低", "上午无", "同刻高", "明天高"]);
    act(() => updateSubtask(task.id, "明天高", { due: "2026-10-20", dueTime: "08:00", priority: 3 }));
    expect(titles(mobile)).toEqual(["明天高", "同刻低", "上午无", "同刻高"]);
    expect(getTask().subtasks.map((s) => s.id)).toEqual(["同刻低", "明天高", "同刻高", "上午无"]);
    expect(JSON.stringify(task)).toBe(before);
  });

  it("母重要性变化会使继承子项即时重排，显式0仍在低位", () => {
    const task = newTask({ id: "parent", title: "继承重要性", due: "2026-10-20", dueTime: "10:00", priority: 1, subtasks: [
      sub("自己中", { priority: 2 }), sub("继承母"), sub("自己无", { priority: 0 }),
    ] });
    renderTask(task, mobile);
    expect(titles(mobile)).toEqual(["自己中", "继承母", "自己无"]);
    act(() => updateTask(task.id, { priority: 3 }));
    expect(titles(mobile)).toEqual(["继承母", "自己中", "自己无"]);
    expect(getTask().subtasks[1].priority).toBeUndefined();
  });

  it("已完成步骤仍按doneAt倒序，未被待办优先级规则影响", () => {
    const task = newTask({ id: "parent", title: "完成顺序", subtasks: [
      sub("旧高", { done: true, doneAt: "2026-10-19T10:00:00Z", priority: 3 }),
      sub("新无", { done: true, doneAt: "2026-10-20T10:00:00Z", priority: 0 }),
    ] });
    renderTask(task, mobile);
    const nodes = [...document.querySelectorAll<HTMLTextAreaElement | HTMLButtonElement>(mobile ? ".msh-subwrap.done .msh-subtitle" : ".task-card .sub-row.done textarea")];
    expect(nodes.map((el) => el instanceof HTMLTextAreaElement ? el.value : el.textContent)).toEqual(["新无", "旧高"]);
  });
});
