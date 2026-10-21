import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TaskCard from "../src/components/TaskCard";
import { defaultData, newTask } from "../src/core/model";
import { appStore, flushSave, undo, updateTask, useApp } from "../src/core/store";
import { taskDue, taskTime } from "../src/core/taskDue";
import { DATE_COMMIT_MS } from "../src/core/dateinput";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
const task = () => appStore.getState().data.tasks[0];
const trigger = () => host.querySelector<HTMLButtonElement>(".tc-properties > button")!;
const menu = () => document.querySelector<HTMLElement>('[data-task-popover="parent"]')!;
const field = () => menu().querySelector<HTMLInputElement>('input[type="date"]')!;
function Card() { return createElement(TaskCard, { task: useApp(s => s.data.tasks[0]) }); }
function click(element: HTMLElement) {
  act(() => {
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    element.focus(); element.click();
  });
}
function type(element: HTMLInputElement, value: string) {
  act(() => {
    element.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
function settle() { act(() => vi.advanceTimersByTime(DATE_COMMIT_MS + 150)); }
beforeEach(async () => {
  await flushSave(); while (appStore.getState().undoDepth) undo(); await flushSave(); localStorage.clear();
  vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 22, 12));
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const data = defaultData();
  data.tasks = [Object.assign(newTask({ id: "parent", title: "安排母任务", due: "2026-10-25", dueTime: "18:00", subtasks: [
    { id: "child", title: "先检查材料", due: "2026-10-23", dueTime: "09:00", done: false },
    { id: "inherit", title: "继承母日期", done: false },
  ] }), { futureField: { keep: true } })];
  appStore.setState({ data, loaded: true, loadError: null, wiped: false, undoDepth: 0, ui: { ...appStore.getState().ui, expandedId: "parent" } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root.render(createElement(Card)));
});
afterEach(async () => {
  act(() => root.unmount()); document.body.innerHTML = "";
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); await flushSave();
});

describe("母日期真实编辑：手排日期与最近子安排分别可见", () => {
  it("日期框取母日期；改为比子任务更晚仍显示新母日期，最近子排序不变", () => {
    const children = JSON.stringify(task().subtasks);
    click(trigger()); expect(field().value).toBe("2026-10-25");
    type(field(), "2026-10-29"); settle();
    expect(task().due).toBe("2026-10-29");
    expect(trigger().textContent).toContain("10月29日 18:00");
    expect(host.querySelector(".tc-properties")?.textContent).toContain("最近子任务：明天 09:00");
    expect(taskDue(task())).toBe("2026-10-23"); expect(taskTime(task())).toBe("09:00");
    expect(JSON.stringify(task().subtasks)).toBe(children);
    expect(task()).toHaveProperty("futureField.keep", true);
    click(trigger()); settle(); click(trigger()); expect(field().value).toBe("2026-10-29");
    expect(task().postponeCount).toBe(1);
  });

  it("键盘日期未到去抖时间就点卡内别处，仍保存母日期和钟点", () => {
    click(trigger()); type(field(), "2026-10-28");
    expect(task().due).toBe("2026-10-25");
    click(host.querySelector<HTMLTextAreaElement>(".notes")!); settle();
    expect(task()).toMatchObject({ due: "2026-10-28", dueTime: "18:00", postponeCount: 1 });
    expect(trigger().textContent).toContain("10月28日 18:00");
  });

  it("改日期后立即改时间，两个输入保存为同一条母安排", () => {
    click(trigger()); type(field(), "2026-10-28");
    const time = menu().querySelector<HTMLInputElement>('input[type="time"]')!;
    type(time, "16:30"); click(trigger()); settle();
    expect(task()).toMatchObject({ due: "2026-10-28", dueTime: "16:30", postponeCount: 1 });
    expect(trigger().textContent).toContain("10月28日 16:30");
  });

  it("改完立即清母日期，待提交草稿不会把它写回来，子任务仍独立安排", () => {
    click(trigger()); type(field(), "2026-10-29");
    click([...menu().querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "清除日期")!); settle();
    expect(task()).toMatchObject({ due: null, dueTime: null, postponeCount: 0 });
    expect(task().subtasks[0]).toMatchObject({ due: "2026-10-23", dueTime: "09:00" });
    expect(taskDue(task())).toBe("2026-10-23");
    expect(trigger().textContent).toContain("安排日期");
    expect(host.querySelector(".tc-properties")?.textContent).toContain("最近子任务：明天 09:00");
    click(trigger()); expect(field().value).toBe("");
  });

  it("键盘草稿后选快捷日期，快捷日期获胜并持续显示母日期", () => {
    click(trigger()); type(field(), "2026-10-29");
    click([...menu().querySelectorAll<HTMLButtonElement>("button")].find(b => b.textContent === "今天")!); settle();
    expect(task()).toMatchObject({ due: "2026-10-22", dueTime: "18:00", postponeCount: 0 });
    expect(trigger().textContent).toContain("今天 18:00");
    expect(host.querySelector(".tc-properties")?.textContent).not.toContain("最近子任务：");
  });

  it("母子同一天但子更早时，母钟点仍可见，子安排单独标明", () => {
    act(() => updateTask("parent", { due: "2026-10-23", dueTime: "18:00" }));
    expect(trigger().textContent).toContain("明天 18:00");
    expect(host.querySelector(".tc-next-schedule")?.textContent).toContain("最近子任务：明天 09:00");
    expect(taskTime(task())).toBe("09:00");
  });
});
