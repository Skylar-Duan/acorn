import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import TaskCard from "../src/components/TaskCard";
import { defaultData, newTask } from "../src/core/model";
import { appStore, flushSave, undo, useApp } from "../src/core/store";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
const value = () => appStore.getState().data.tasks[0];
function Harness({ locateSubId }: { locateSubId?: string }) { return createElement(TaskCard, { task: useApp((state) => state.data.tasks[0]), locateSubId }); }
function input(el: HTMLTextAreaElement, text: string) { act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, text); el.dispatchEvent(new Event("input", { bubbles: true })); }); }
beforeEach(async () => {
  await flushSave(); while (appStore.getState().undoDepth) undo(); await flushSave(); localStorage.clear();
  appStore.setState({ data: { ...defaultData(), tasks: [newTask({ id: "audit-parent", title: "母任务", due: "2027-12-31", priority: 0, subtasks: [{ id: "audit-sub", title: "长步骤第一行\n第二行", done: false, due: "2026-10-21", priority: 1 }] })] }, loaded: true, wiped: false, loadError: null, undoDepth: 0, ui: { ...appStore.getState().ui, expandedId: "audit-parent", ctxMenu: null } });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host); act(() => root.render(createElement(Harness)));
});
afterEach(async () => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); await flushSave(); });
it("手动折叠过的子行再次收到定位也应强制展开全文", () => {
  const disclosure = () => host.querySelector<HTMLButtonElement>(".sub-disclosure")!;
  act(() => disclosure().click()); act(() => disclosure().click());
  expect(disclosure().getAttribute("aria-expanded")).toBe("false");
  act(() => root.render(createElement(Harness, { locateSubId: "audit-sub" })));
  expect(disclosure().getAttribute("aria-expanded")).toBe("true");
});
it("IME组字期间Esc只应取消组字，保留未提交草稿和打开状态", () => {
  const el = host.querySelector<HTMLTextAreaElement>(".row1 textarea")!;
  input(el, "母任务 !!!"); const before = structuredClone(value());
  act(() => el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true })));
  expect(value()).toEqual(before);
  expect(el.value).toBe("母任务 !!!");
  expect(appStore.getState().ui.expandedId).toBe("audit-parent");
});
it("草稿投影和引号引用均不改账本，取消后撤回显示", () => {
  const el = host.querySelector<HTMLTextAreaElement>(".row1 textarea")!; const before = structuredClone(value());
  input(el, '母任务 "~明天 !!! @李哥 /生活 #标签"');
  expect(host.querySelector(".row1 > .flag")?.className).toBe("flag p0"); expect(value()).toEqual(before);
  input(el, "母任务 !!!"); expect(host.querySelector(".row1 > .flag")?.className).toBe("flag p3"); expect(value()).toEqual(before);
  act(() => el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(value()).toEqual(before); expect(el.value).toBe("母任务");
});
