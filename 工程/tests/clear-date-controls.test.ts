import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import QuickAddBar from "../src/components/QuickAddBar";
import TaskCard from "../src/components/TaskCard";
import { defaultData, newTask } from "../src/core/model";
import { appStore, flushSave, undo, useApp } from "../src/core/store";
import { DATE_COMMIT_MS } from "../src/core/dateinput";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
function click(element: HTMLElement) { act(() => element.click()); }
function type(element: HTMLInputElement, value: string) {
  act(() => {
    element.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
const clear = () => [...document.querySelectorAll<HTMLButtonElement>(".popmenu button")].find(b => b.textContent?.trim().startsWith("清除日期"))!;
function Card() { return createElement(TaskCard, { task: useApp(s => s.data.tasks[0]) }); }
beforeEach(async () => {
  await flushSave(); while (appStore.getState().undoDepth) undo(); await flushSave(); localStorage.clear();
  vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 21, 15));
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const data = defaultData();
  data.tasks = [newTask({ id: "parent", title: "母任务", due: "2026-10-22", dueTime: "18:00", subtasks: [
    { id: "child", title: "独立子任务", due: "2026-10-23", dueTime: "09:00", done: false },
  ] })];
  appStore.setState({ data, loaded: true, loadError: null, wiped: false, undoDepth: 0, ui: { ...appStore.getState().ui, expandedId: "parent" } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { act(() => root.unmount()); document.body.innerHTML = ""; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); await flushSave(); });

describe("日期编辑里的清除入口", () => {
  it("子任务清除会取消尚未落定的日期并清钟点，随后恢复母日期继承", () => {
    act(() => root.render(createElement(Card)));
    click(host.querySelector<HTMLButtonElement>('[aria-label="子任务日期：独立子任务"]')!);
    type(document.querySelector<HTMLInputElement>('.popmenu input[type="date"]')!, "2026-11-12");
    click(clear()); act(() => vi.advanceTimersByTime(DATE_COMMIT_MS + 500));
    const task = appStore.getState().data.tasks[0];
    expect(task.subtasks[0]).toMatchObject({ due: null, dueTime: null });
    expect(task.due).toBe("2026-10-22"); expect(task.dueTime).toBe("18:00");
    expect(host.querySelector('[aria-label="子任务日期：独立子任务"]')?.textContent).toContain("明天 18:00");
  });
  it("母任务只有最近子日期时，也有明确的清除日期入口且保留子安排", () => {
    appStore.getState().data.tasks[0].due = null; appStore.getState().data.tasks[0].dueTime = null;
    act(() => root.render(createElement(Card)));
    click(host.querySelector<HTMLButtonElement>('.tc-properties > button')!);
    expect(clear()).toBeDefined(); click(clear()); act(() => vi.advanceTimersByTime(500));
    expect(appStore.getState().data.tasks[0].subtasks[0].due).toBe("2026-10-23");
    expect(appStore.getState().data.tasks[0].due).toBeNull();
  });
  for (const typedDate of [false, true]) {
    it(`带默认日期的新增清除后${typedDate ? "打字识别的日期与时间" : "视图默认日期"}都不复活`, async () => {
      act(() => root.render(createElement(QuickAddBar, { withPickers: true, defaults: { due: "2026-11-01" } })));
      const input = host.querySelector<HTMLInputElement>('input')!;
      type(input, typedDate ? "清除测试 ~明天下午3点" : "清除测试");
      click(host.querySelector<HTMLButtonElement>('.qa-pick')!);
      type(document.querySelector<HTMLInputElement>('.popmenu input[type="date"]')!, "2026-11-20");
      click(clear()); act(() => vi.advanceTimersByTime(DATE_COMMIT_MS + 500));
      expect(host.querySelectorAll(".si-chips .chip")).toHaveLength(0);
      await act(async () => { input.focus(); input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
      const added = appStore.getState().data.tasks.find(t => t.id !== "parent");
      expect(added).toBeDefined(); expect(added).toMatchObject({ title: "清除测试", due: null, dueTime: null, reminder: null });
    });
  }
  it("清除后再修改日期标记，预览重新显示并保存新日期", async () => {
    act(() => root.render(createElement(QuickAddBar, { withPickers: true })));
    const input = host.querySelector<HTMLInputElement>("input")!;
    type(input, "改期测试 ~明天下午3点");
    click(host.querySelector<HTMLButtonElement>(".qa-pick")!); click(clear());
    expect(host.querySelectorAll(".si-chips .chip")).toHaveLength(0);
    type(input, "改期测试 ~后天下午4点");
    expect(host.querySelectorAll(".si-chips .chip").length).toBeGreaterThan(0);
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(appStore.getState().data.tasks.find(t => t.id !== "parent")).toMatchObject({ due: "2026-10-23", dueTime: "16:00" });
  });
});
