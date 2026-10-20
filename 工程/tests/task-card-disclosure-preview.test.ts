import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const flags = vi.hoisted(() => ({ plus: true }));
vi.mock("../src/core/plus", async original => ({ ...await original<typeof import("../src/core/plus")>(), plusEnabled: () => flags.plus, usePlus: () => flags.plus }));
import TaskCard from "../src/components/TaskCard";
import { appStore, flushSave, useApp } from "../src/core/store";
import { defaultData, newTask, type TaskImage } from "../src/core/model";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const jpeg = [255, 216, 255, 192, 0, 17, 8, 0, 1, 0, 1, 3, 1, 17, 0, 2, 17, 0, 3, 17, 0, 255, 217];
const picture: TaskImage = { id: "a", name: "配色.jpg", dataUrl: "data:image/jpeg;base64," + btoa(String.fromCharCode(...jpeg)), width: 1, height: 1, bytes: jpeg.length };
let root: Root, host: HTMLDivElement;
function Card() { return createElement(TaskCard, { task: useApp(state => state.data.tasks[0]) }); }
const row = () => host.querySelector<HTMLElement>('[data-subtask-id="child"]')!;
const input = () => row().querySelector<HTMLTextAreaElement>("textarea")!;
const title = () => host.querySelector<HTMLTextAreaElement>(".row1 textarea")!;
const ledger = () => JSON.stringify(appStore.getState().data);
function type(el: HTMLTextAreaElement, value: string) {
  act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); });
}
async function key(el: HTMLElement, value: string, composing = false) {
  await act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, isComposing: composing })); });
}
beforeEach(async () => {
  await flushSave(); localStorage.clear(); flags.plus = true;
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 20, 12));
  const data = defaultData();
  data.tasks = [newTask({ id: "parent", title: "安排工作", notes: "核对一项，再开始下一项", due: "2026-10-25", dueTime: "18:00", priority: 1, subtasks: [
    { id: "child", title: "核对材料\n再写结论", done: false, due: "2026-10-24", priority: 1, images: [picture, { ...picture, id: "b", name: "第二张.jpg" }] },
    { id: "plain", title: "没有图片的步骤", done: false, due: "2026-10-24", priority: 0 },
  ] })];
  appStore.setState({ data, loaded: true, loadError: null, wiped: false, ui: { ...appStore.getState().ui, expandedId: "parent" } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root.render(createElement(Card)));
});
afterEach(async () => { act(() => root.unmount()); document.body.innerHTML = ""; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); await flushSave(); });

describe("任务卡逐步展开与即时元数据预览", () => {
  it("默认折成一行，日期前只显示一张多图摘要；展开收起零数据或撤销写入", () => {
    const before = ledger(), undo = appStore.getState().undoDepth;
    expect(input().getAttribute("wrap")).toBe("off");
    expect(input().dataset.expanded).toBe("false");
    expect(row().querySelectorAll("[data-image-summary]")).toHaveLength(1);
    expect(row().querySelector(".image-summary-count")?.textContent).toBe("2");
    expect(row().querySelector("[data-task-images]")).toBeNull();
    expect(row().querySelector("[data-image-summary]")!.compareDocumentPosition(row().querySelector(".sub-property-date")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    act(() => row().querySelector<HTMLButtonElement>(".sub-disclosure")!.click());
    expect(input().getAttribute("wrap")).toBe("soft");
    expect(row().querySelectorAll("[data-task-images] .image-open")).toHaveLength(2);
    expect(row().querySelector("[data-task-images]")!.closest(".sub-images-motion")).not.toBeNull();
    expect(document.querySelector(".task-images-compact-gallery")).toBeNull();
    act(() => row().querySelector<HTMLButtonElement>(".sub-disclosure")!.click());
    expect(input().dataset.expanded).toBe("false");
    expect(ledger()).toBe(before); expect(appStore.getState().undoDepth).toBe(undo);
  });

  it("点缩略图展开本步，原图预览关闭不会收母卡或写数据", async () => {
    const before = ledger();
    act(() => row().querySelector<HTMLButtonElement>("[data-image-summary]")!.click());
    expect(row().classList.contains("sub-expanded")).toBe(true);
    act(() => row().querySelector<HTMLButtonElement>(".image-open")!.click());
    expect(document.querySelector(".image-lightbox img")?.getAttribute("src")).toBe(picture.dataUrl);
    await key(document.body, "Escape");
    expect(document.querySelector(".image-lightbox")).toBeNull();
    expect(appStore.getState().ui.expandedId).toBe("parent"); expect(ledger()).toBe(before);
  });

  it("母属性排在备注之后、步骤之前；输入即可预览，输入法确认不保存，Enter才保存", async () => {
    const notes = host.querySelector(".tc-notes-wrap")!, props = host.querySelector(".tc-properties")!, subs = host.querySelector(".subs")!;
    expect(notes.compareDocumentPosition(props) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(props.compareDocumentPosition(subs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const before = ledger(); type(title(), "安排工作 !!! ~ 明天");
    expect(host.querySelector(".row1 .flag.p3")).not.toBeNull();
    expect(props.textContent).toContain("明天 18:00"); expect(ledger()).toBe(before);
    await key(title(), "Enter", true); expect(ledger()).toBe(before);
    await key(title(), "Enter");
    expect(appStore.getState().data.tasks[0]).toMatchObject({ title: "安排工作", due: "2026-10-21", dueTime: "18:00", priority: 3 });
  });

  it("子属性即时预览、Esc取消；引用内标记保持普通正文", async () => {
    const before = ledger(); type(input(), "核对材料 !!! ~ 明天");
    expect(row().querySelector(".sub-property-priority")?.textContent).toContain("高");
    expect(row().querySelector(".sub-property-date")?.textContent).toContain("明天"); expect(ledger()).toBe(before);
    await key(input(), "Escape");
    expect(ledger()).toBe(before); expect(input().value).toBe("核对材料\n再写结论");
    type(input(), '说明 "!!! ~ 明天 @人 /清单"');
    expect(row().querySelector(".sub-property-priority")?.textContent).toContain("低");
    expect(row().querySelector(".sub-property-date")?.textContent).not.toContain("明天");
    await key(input(), "Enter");
    expect(appStore.getState().data.tasks[0].subtasks[0]).toMatchObject({ title: '说明 "!!! ~ 明天 @人 /清单"', priority: 1, due: "2026-10-24" });
  });

  it("普通用户仍用同一行控件并隐藏所有图片数据和入口", () => {
    const before = ledger(); act(() => { flags.plus = false; root.render(createElement(Card)); });
    expect(host.querySelector("[data-image-summary],[data-image-picker],[data-task-images]")).toBeNull();
    expect(row().querySelector(".sub-disclosure")).not.toBeNull(); expect(row().querySelector(".sub-property-date")).not.toBeNull();
    expect(ledger()).toBe(before);
  });
});
