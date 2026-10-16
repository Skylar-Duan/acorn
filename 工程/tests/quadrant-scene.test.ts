import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Quadrant from "../src/views/Quadrant";
import { defaultData, newTask, type Task } from "../src/core/model";
import { appStore, deleteTasks, flushSave, undo } from "../src/core/store";
import { syncStore } from "../src/core/syncCtl";
import { deadlineX, quadrantPoints } from "../src/core/quadrantLayout";
import { addDays, todayYMD } from "../src/core/dates";
import { rememberTaskSubtasksFolded } from "../src/core/subtaskFold";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
const today = todayYMD();
const task = () => appStore.getState().data.tasks[0];
function seed(value: Partial<Task> = {}) { appStore.setState({ data: { ...defaultData(), tasks: [newTask({ id: "parent", title: "真实任务", due: today, priority: 3, dueTime: "14:00", ...value })] } }); }
function point(subId?: string) { return [...document.querySelectorAll<HTMLButtonElement>(".quad-point")].find((el) => (el.dataset.subtaskId ?? "") === (subId ?? ""))!; }
function pointer(el: HTMLElement, name: string, x: number, y: number) { const event = new Event(name, { bubbles: true, cancelable: true }); for (const [key, value] of Object.entries({ pointerId: 1, button: 0, clientX: x, clientY: y, pointerType: "mouse" })) Object.defineProperty(event, key, { value }); act(() => el.dispatchEvent(event)); }
async function drag(el: HTMLElement, xPct: number, yPct: number, cancel?: string) {
  const origin = quadrantPoints(appStore.getState().data, today).find((p) => p.id === el.dataset.quadPoint)!;
  pointer(el, "pointerdown", origin.xPct * 10, origin.yPct * 6);
  pointer(el, "pointermove", xPct * 10, yPct * 6);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
  if (cancel === "Escape") act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  else if (cancel === "blur") act(() => window.dispatchEvent(new Event("blur")));
  else pointer(el, cancel ?? "pointerup", xPct * 10, yPct * 6);
}
function key(el: HTMLElement, key: string) { act(() => el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }))); }
beforeEach(async () => {
  await flushSave(); while (appStore.getState().undoDepth) undo(); await flushSave(); localStorage.clear(); syncStore.setState({ session: null });
  appStore.setState({ data: defaultData(), loaded: true, loadError: null, wiped: false, undoDepth: 0, ui: { ...appStore.getState().ui, expandedId: null, selectedIds: [] } }); seed();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () { return { x: 0, y: 0, left: 0, top: 0, width: 1000, height: 600, right: 1000, bottom: 600, toJSON() {} }; });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); act(() => root.render(createElement(Quadrant)));
});
afterEach(async () => { act(() => root.unmount()); document.body.innerHTML = ""; vi.restoreAllMocks(); await flushSave(); });

describe("坐标点真实交互", () => {
  it("有待办子任务只画子点，完成/放弃/回收不画，父点无重复", () => {
    act(() => seed({ subtasks: [{ id: "sub", title: "待办步骤", done: false }, { id: "done", title: "完成步骤", done: true }, { id: "drop", title: "放弃步骤", done: false, droppedAt: "2026-10-16T00:00:00Z" }] }));
    expect(document.querySelectorAll(".quad-point")).toHaveLength(1); expect(point("sub").getAttribute("aria-label")).toContain("真实任务 › 待办步骤");
  });
  it("拖动时零写，松手只改母date/prio，一次撤销，钟点归类图片保留", async () => {
    const original = task(); const el = point(); const origin = quadrantPoints(appStore.getState().data, today)[0];
    pointer(el, "pointerdown", origin.xPct * 10, origin.yPct * 6); pointer(el, "pointermove", deadlineX(addDays(today, 7), today) * 10, 85 * 6);
    expect(task()).toBe(original); pointer(el, "pointerup", 0, 0);
    expect(task()).toMatchObject({ due: addDays(today, 7), dueTime: "14:00", priority: 0, listId: original.listId, who: original.who });
    expect(appStore.getState().undoDepth).toBe(1); act(() => undo()); expect(task()).toEqual({ ...original, updatedAt: task().updatedAt });
  });
  it("单轴改子重要性不固化继承日期、不改母字段，日期轴只改本子", async () => {
    act(() => seed({ subtasks: [{ id: "sub", title: "继承的步骤", done: false, who: ["自己人"] }] }));
    const origin = quadrantPoints(appStore.getState().data, today)[0];
    await drag(point("sub"), origin.xPct, 85);
    expect(task().priority).toBe(3); expect(task().subtasks[0]).toMatchObject({ priority: 0, who: ["自己人"] }); expect(task().subtasks[0].due).toBeUndefined();
    const next = quadrantPoints(appStore.getState().data, today)[0]; await drag(point("sub"), deadlineX(addDays(today, 3), today), next.yPct);
    expect(task().due).toBe(today); expect(task().subtasks[0].due).toBe(addDays(today, 3)); expect(task().subtasks[0].priority).toBe(0);
  });
  it.each(["Escape", "pointercancel", "blur"])("%s取消不写数据", async (reason) => {
    const before = appStore.getState().data; await drag(point(), 20, 80, reason); expect(appStore.getState().data).toBe(before); expect(appStore.getState().undoDepth).toBe(0);
  });
  it("拖动后不误开详情，点击不移动不写，键盘可预览和提交", async () => {
    const el = point(); await drag(el, 20, 80); act(() => el.click()); expect(appStore.getState().ui.expandedId).toBeNull();
    act(() => undo()); const before = task(); key(el, " "); key(el, "ArrowDown"); expect(task()).toBe(before); key(el, "Enter"); expect(task().priority).toBe(2); expect(task().due).toBe(today);
  });
  it("子点详情临时展开并定位，Esc先关日期层，不改本机折叠偏好", async () => {
    rememberTaskSubtasksFolded("parent", true);
    act(() => seed({ subtasks: Array.from({ length: 8 }, (_, i) => ({ id: `sub-${i}`, title: `步骤${i}`, done: false })) }));
    const preference = localStorage.getItem("acorn-card-subtasks-folded"); key(point("sub-7"), "Enter");
    expect(document.querySelector('.quad-detail [data-subtask-id="sub-7"]')?.classList.contains("quad-located")).toBe(true);
    expect(document.querySelectorAll("#pending-subs-parent textarea")).toHaveLength(8); expect(localStorage.getItem("acorn-card-subtasks-folded")).toBe(preference);
    act(() => document.querySelector<HTMLButtonElement>('.quad-detail [aria-label="任务日期"]')?.click());
    // 使用真实日期入口，避免依赖图标文案。
    const dateButton = [...document.querySelectorAll<HTMLButtonElement>('.quad-detail .tc-properties .pill')].find((button) => button.querySelector('svg'))!;
    act(() => dateButton.click()); key(dateButton, "Escape"); expect(document.querySelector(".quad-detail")).not.toBeNull();
    key(dateButton, "Escape"); expect(document.querySelector(".quad-detail")).toBeNull();
  });
  it("压住点后目标删除或账号变化取消，不写到新上下文", async () => {
    const el = point(), original = quadrantPoints(appStore.getState().data, today)[0]; pointer(el, "pointerdown", original.xPct * 10, original.yPct * 6); pointer(el, "pointermove", 200, 500);
    act(() => syncStore.setState({ session: { email: "synthetic@example.test", token: "synthetic", rev: 0, syncedAt: null } })); pointer(el, "pointerup", 200, 500);
    expect(task().due).toBe(today); expect(task().priority).toBe(3);
    pointer(el, "pointerdown", original.xPct * 10, original.yPct * 6); pointer(el, "pointermove", 200, 500); act(() => deleteTasks(["parent"])); pointer(el, "pointerup", 200, 500);
    expect(task().due).toBe(today);
  });
  it("尚未达到拖动阈值就取消，也不会把松手click变成打开详情", () => {
    const el = point(); pointer(el, "pointerdown", 10, 10);
    act(() => window.dispatchEvent(new Event("blur"))); pointer(el, "pointerup", 11, 11); act(() => el.click());
    expect(appStore.getState().ui.expandedId).toBeNull(); expect(appStore.getState().undoDepth).toBe(0);
  });
});
