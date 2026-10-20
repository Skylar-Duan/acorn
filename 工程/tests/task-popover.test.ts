import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TaskCard from "../src/components/TaskCard";
import QuickAddBar from "../src/components/QuickAddBar";
import { taskPopoverPosition } from "../src/components/TaskPropertyPopover";
import { defaultData, newTask } from "../src/core/model";
import { appStore, flushSave, useApp } from "../src/core/store";
import { addDays, todayYMD } from "../src/core/dates";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
const anchor = (left: number, top: number) => ({ left, right: left + 80, top, bottom: top + 30 });

describe("任务属性浮层视口避让", () => {
  it("四个边角都保留菜单在视口内，下面不足向上", () => {
    for (const point of [anchor(8, 8), anchor(780, 8), anchor(8, 540), anchor(780, 540)]) {
      const pos = taskPopoverPosition(point, 280, 260, 880, 600);
      expect(pos.left).toBeGreaterThanOrEqual(8);
      expect(pos.left + 280).toBeLessThanOrEqual(872);
      expect(pos.top).toBeGreaterThanOrEqual(8);
      expect(pos.top + 260).toBeLessThanOrEqual(592);
      if (point.top > 500) expect(pos.top + 260).toBeLessThan(point.top);
    }
  });
  it("比视口高的菜单限制可滚高度，保留顶部和底部空间", () => {
    expect(taskPopoverPosition(anchor(340, 180), 300, 900, 880, 600)).toMatchObject({ top: 8, maxHeight: 584 });
  });
});

function Harness() { return createElement(TaskCard, { task: useApp((s) => s.data.tasks[0]) }); }
function click(element: HTMLElement) { act(() => { element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); element.click(); }); }
function type(element: HTMLInputElement, value: string) {
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); });
}
beforeEach(async () => {
  await flushSave();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const data = defaultData();
  data.tasks = [newTask({ id: "popover-demo", title: "安排工作", due: "2026-10-20", who: ["协作人"], subtasks: [] })];
  appStore.setState({ data, loaded: true, wiped: false, loadError: null, ui: { ...appStore.getState().ui, expandedId: "popover-demo" } });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { act(() => root.unmount()); document.body.innerHTML = ""; vi.restoreAllMocks(); await flushSave(); });

describe("真实组件的属性浮层", () => {
  it("菜单挂到卡外仍能选日期，不误收任务卡，撤销语义仍交给store", () => {
    act(() => root.render(createElement(Harness)));
    const trigger = document.querySelector<HTMLButtonElement>(".tc-properties > button")!;
    trigger.focus(); click(trigger);
    const menu = document.querySelector<HTMLElement>('[data-task-popover="popover-demo"]')!;
    expect(host.contains(menu)).toBe(false);
    expect(document.activeElement).toBe(menu.querySelector("button.item"));
    const preset = [...menu.querySelectorAll<HTMLButtonElement>("button.item")].find((button) => button.textContent?.trim() === "明天")!;
    click(preset);
    expect(appStore.getState().ui.expandedId).toBe("popover-demo");
    expect(appStore.getState().data.tasks[0].due).toBe(addDays(todayYMD(), 1));
    expect(document.querySelector(".task-card")).not.toBeNull();
  });

  it("录入时点portal里的日期框不会抢先提交草稿，回车保存带上选择", async () => {
    act(() => root.render(createElement(QuickAddBar, { withPickers: true })));
    const input = document.querySelector<HTMLInputElement>(".si-input")!;
    type(input, "未保存的草稿");
    click(document.querySelector<HTMLButtonElement>(".qa-pick")!);
    const menu = document.querySelector<HTMLElement>("[data-qa-popover]")!;
    const date = menu.querySelector<HTMLInputElement>('input[type="date"]')!;
    act(() => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: date })));
    expect(appStore.getState().data.tasks).toHaveLength(1);
    click(menu.querySelector<HTMLButtonElement>("button.item")!);
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(appStore.getState().data.tasks).toHaveLength(2);
    expect(appStore.getState().data.tasks.find((t) => t.title === "未保存的草稿")?.due).toBeTruthy();
  });
});
