import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TaskCard from "../src/components/TaskCard";
import QuickAddBar from "../src/components/QuickAddBar";
import CategoryCreationHost from "../src/components/CategoryCreationDialog";
import { finishCategoryDraft, useCategoryCreation } from "../src/core/categoryCreation";
import { appStore, flushSave, useApp } from "../src/core/store";
import { defaultData, newTask } from "../src/core/model";
import { syntaxToken } from "../src/core/syntaxCompletion";
import { parseQuickAdd } from "../src/core/parse";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
const parent = () => appStore.getState().data.tasks.find((task) => task.id === "parent")!;
const ledger = () => JSON.stringify(appStore.getState().data);
function Card() { return createElement(TaskCard, { task: useApp((state) => state.data.tasks.find((task) => task.id === "parent")!) }); }
const paths = ["新增母任务", "新增子任务", "编辑母任务", "编辑子任务"] as const;
function field(path: typeof paths[number]) {
  return path === "新增母任务" ? host.querySelector<HTMLInputElement>(".quick-add .si-input")!
    : path === "新增子任务" ? host.querySelector<HTMLTextAreaElement>(".new-sub-row .si-input")!
    : path === "编辑母任务" ? host.querySelector<HTMLTextAreaElement>(".row1 textarea")!
    : host.querySelector<HTMLTextAreaElement>('[data-subtask-id="child"] textarea')!;
}
function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  act(() => {
    const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function key(el: HTMLElement, key: string, extra: KeyboardEventInit = {}) {
  await act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra })); });
}
beforeEach(async () => {
  await flushSave(); localStorage.clear(); vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 21, 12));
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const data = defaultData();
  data.lists = [{ id: "work", name: "Work", color: "clay", order: 0, updatedAt: "2026-10-20" },
    { id: "reading", name: "Reading", color: "sea", order: 1, updatedAt: "2026-10-20" }];
  data.tasks = [newTask({ id: "parent", title: "原任务", listId: "reading", subtasks: [
    { id: "child", title: "原步骤", done: false, due: null, priority: null, listIds: ["reading"] },
  ] })];
  Object.assign(data.tasks[0], { futureTask: { keep: true } });
  Object.assign(data.tasks[0].subtasks[0], { futureSub: { keep: true } });
  appStore.setState({ data, loaded: true, loadError: null, wiped: false, ui: { ...appStore.getState().ui, expandedId: "parent" } });
  useCategoryCreation.setState({ pending: null });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root.render(createElement(Fragment, null, createElement(Card), createElement(QuickAddBar), createElement(CategoryCreationHost))));
});
afterEach(async () => {
  act(() => { root.unmount(); finishCategoryDraft(null); }); document.body.innerHTML = "";
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); await flushSave();
});

describe("清单选择补全统一覆盖母子新增编辑", () => {
  it.each(paths)("%s在闭合引用后输入/仍可选择清单，前文的引用斜杠不误判为路径", async (path) => {
    const el = field(path), before = ledger();
    const literal = '"/"“”';
    type(el, `${literal}/wO`);
    expect(document.querySelector(".si-drop")!.textContent).toContain("Work");
    await key(el, "Enter");
    expect(el.value).toBe(`${literal} /Work `);
    expect(ledger()).toBe(before);
    await key(el, "Enter");
    const saved = path === "新增母任务" ? appStore.getState().data.tasks.find((task) => task.title === literal)
      : path === "新增子任务" ? parent().subtasks.find((sub) => sub.title === literal)
      : path === "编辑母任务" ? parent() : parent().subtasks[0];
    expect(saved?.title).toBe(literal);
    if (path.endsWith("子任务")) {
      expect(saved).toMatchObject({ listIds: path === "编辑子任务" ? ["reading", "work"] : ["work"] });
      expect(parent().listId).toBe("reading");
    } else expect(saved).toMatchObject({ listId: "work" });
  });

  it.each(paths)("%s在闭合中文引用后直接提交完整/清单，保留引用原文", async (path) => {
    const el = field(path), literal = '核对“链接 https://example.com/a/b”';
    type(el, `${literal}/Work `);
    await key(el, "Enter");
    const saved = path === "新增母任务" ? appStore.getState().data.tasks.find((task) => task.title === literal)
      : path === "新增子任务" ? parent().subtasks.find((sub) => sub.title === literal)
      : path === "编辑母任务" ? parent() : parent().subtasks[0];
    expect(saved?.title).toBe(literal);
    if (path.endsWith("子任务")) expect(saved).toMatchObject({ listIds: path === "编辑子任务" ? ["reading", "work"] : ["work"] });
    else expect(saved).toMatchObject({ listId: "work" });
  });

  it.each(paths)("%s裸/及大小写前缀可选择；紧贴正文只在明确选择时转换成归类", async (path) => {
    const el = field(path), before = ledger();
    type(el, "整理/"); expect(document.querySelector(".si-drop")!.textContent).toContain("Work");
    type(el, "整理/wO"); expect(document.querySelector(".si-drop")!.textContent).toContain("Work");
    expect(document.querySelector(".si-drop")!.textContent).not.toContain("新建清单「wO」"); // 已有前缀沿用原本清单补全语义，不能把“创建”伪装成选择Work。
    await key(el, "Enter", { isComposing: true }); expect(el.value).toBe("整理/wO"); expect(ledger()).toBe(before);
    const candidate = [...document.querySelectorAll<HTMLButtonElement>(".si-drop button")].find((button) => /^(?:\/)?Work$/.test(button.textContent!.trim()))!;
    await act(async () => { candidate.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); });
    expect(el.value).toBe("整理 /Work "); expect(ledger()).toBe(before); expect(appStore.getState().ui.expandedId).toBe("parent");
    await key(el, "Enter");
    const saved = path === "新增母任务" ? appStore.getState().data.tasks.find((task) => task.title === "整理")
      : path === "新增子任务" ? parent().subtasks.find((sub) => sub.title === "整理")
      : path === "编辑母任务" ? parent() : parent().subtasks[0];
    expect(saved?.title).toBe("整理");
    if (path.endsWith("子任务")) {
      expect(parent().listId).toBe("reading");
      expect(saved).toMatchObject({ listIds: path === "编辑子任务" ? ["reading", "work"] : ["work"] });
    } else expect(saved).toMatchObject({ listId: "work" });
    expect(useCategoryCreation.getState().pending).toBeNull();
    expect(JSON.parse(ledger()).tasks[0].futureTask).toEqual({ keep: true });
    expect(JSON.parse(ledger()).tasks[0].subtasks[0].futureSub).toEqual({ keep: true });
  });

  it.each(paths)("%s新清单先选候选再提交，取消零写入；确认保留颜色图标", async (path) => {
    const el = field(path), before = ledger(); type(el, "整理 /新书单");
    expect(document.querySelector(".si-drop")!.textContent).toContain("新建清单「新书单」");
    await key(el, "Enter"); expect(ledger()).toBe(before); expect(useCategoryCreation.getState().pending).toBeNull();
    await key(el, "Enter"); expect(useCategoryCreation.getState().pending?.draft.kind).toBe("list"); expect(ledger()).toBe(before);
    await key(document.body, "Escape"); expect(ledger()).toBe(before);
    type(el, "整理 /新书单 "); await key(el, "Enter");
    const dialog = document.querySelector('[role="dialog"]')!;
    act(() => dialog.querySelector<HTMLButtonElement>('[aria-label="海蓝"]')!.click());
    act(() => dialog.querySelector<HTMLButtonElement>('[aria-label="书本"]')!.click());
    await act(async () => { dialog.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    const created = appStore.getState().data.lists.find((list) => list.name === "新书单")!;
    expect(created).toMatchObject({ color: "sea", icon: "book" });
    if (path.endsWith("子任务")) {
      expect(parent().listId).toBe("reading");
      expect(parent().subtasks.find((sub) => sub.title === "整理")?.listIds).toContain(created.id);
    } else expect(path === "编辑母任务" ? parent().listId : appStore.getState().data.tasks.find((task) => task.title === "整理")?.listId).toBe(created.id);
  });

  it("URL、路径、数字斜杠与引号保持正文，不弹清单；普通贴连文字未经选择也不自动归类", () => {
    for (const text of ["https://example.com/wo", "www.example.com/wo", "C:\\work/wo", "./wo", "../wo", "/usr/wo", "8/20", "8/", "folder/report.txt", '说明"整理/wo', "说明“整理/wo”"]) {
      expect(syntaxToken(text, text.length), text).toBeNull();
    }
    expect(parseQuickAdd("整理/Work", { now: new Date(2026, 9, 21), listNames: ["Work"] })).toMatchObject({ title: "整理/Work", listName: null });
  });
});
