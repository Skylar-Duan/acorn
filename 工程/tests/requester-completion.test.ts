import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TaskCard from "../src/components/TaskCard";
import QuickAddBar from "../src/components/QuickAddBar";
import CategoryCreationHost from "../src/components/CategoryCreationDialog";
import ContextMenu from "../src/components/ContextMenu";
import { finishCategoryDraft, prepareTaskCategories, useCategoryCreation } from "../src/core/categoryCreation";
import { allWho, appStore, flushSave, openCtxMenu, useApp } from "../src/core/store";
import { defaultData, newTask } from "../src/core/model";
import { pickSyntaxCandidates, syntaxToken } from "../src/core/syntaxCompletion";
import { parseQuickAdd } from "../src/core/parse";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;
const parent = () => appStore.getState().data.tasks.find((task) => task.id === "parent")!;
const ledger = () => JSON.stringify(appStore.getState().data);
function Card() { return createElement(TaskCard, { task: useApp((state) => state.data.tasks.find((task) => task.id === "parent")!) }); }
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
async function choose(name?: string) {
  await act(async () => { const draft = useCategoryCreation.getState().pending!.draft; finishCategoryDraft({ ...draft, ...(name ? { name } : {}) }); });
}
beforeEach(async () => {
  await flushSave(); localStorage.clear();
  vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 21, 12));
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const data = defaultData();
  data.settings.whoAppearance = { Alice: { color: "moss", icon: "team" }, "李哥": { color: "clay", icon: "team" } };
  data.tasks = [newTask({ id: "parent", title: "原任务", who: ["原需求方"], subtasks: [
    { id: "child", title: "原步骤", done: false, due: null, priority: null },
  ] })];
  appStore.setState({ data, loaded: true, loadError: null, wiped: false, ui: { ...appStore.getState().ui, expandedId: "parent" } });
  useCategoryCreation.setState({ pending: null });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root.render(createElement(Fragment, null, createElement(Card), createElement(QuickAddBar, { withPickers: true }), createElement(CategoryCreationHost))));
});
afterEach(async () => {
  act(() => { root.unmount(); finishCategoryDraft(null); }); document.body.innerHTML = "";
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); await flushSave();
});

describe("需求方候选与确认", () => {
  it("匹配英文大小写、中文前缀、多标记；引号内与时间后的正文不补全", () => {
    expect(pickSyntaxCandidates(["Alice", "Calico", "李哥", "alice"], "ALI")).toEqual(["Alice", "Calico"]);
    expect(pickSyntaxCandidates(["Alice", "李哥"], "李")).toEqual(["李哥"]);
    expect(syntaxToken("工作 @Alice @李", 12)?.prefix).toBe("李");
    expect(syntaxToken('说明 "@AL', 7)).toBeNull();
    expect(syntaxToken("@李哥~3点", 7)).toBeNull();
    expect(syntaxToken("中文正文#标签", 7)).toBeNull();
    expect(syntaxToken("中文正文/清单", 7)?.trigger).toBe("/");
    expect(syntaxToken('说明"贴连@AL', 8)).toBeNull();
    // 仅补全边界放开@；邮件文字继续沿用已有解析口径，不更改正文识别规则。
    expect(parseQuickAdd("联系demo@example.com", { now: new Date(2026, 9, 21), listNames: [] })).toMatchObject({ title: "联系demo@example.com", who: [] });
    expect(syntaxToken("联系demo@example.com", 18)).toBeNull();
  });

  it.each(["新增母任务", "新增子任务", "编辑母任务", "编辑子任务"])("%s：中文正文紧贴@也立即出现候选，先选择再保存", async (path) => {
    const el = path === "新增母任务" ? host.querySelector<HTMLInputElement>(".quick-add .si-input")!
      : path === "新增子任务" ? host.querySelector<HTMLTextAreaElement>(".new-sub-row .si-input")!
      : path === "编辑母任务" ? host.querySelector<HTMLTextAreaElement>(".row1 textarea")!
      : host.querySelector<HTMLTextAreaElement>('[data-subtask-id="child"] textarea')!;
    const before = ledger(); type(el, "中文标题@");
    expect(document.querySelector(".si-drop")!.textContent).toContain("Alice");
    type(el, "中文标题@aL"); await key(el, "Enter", { isComposing: true });
    expect(el.value).toBe("中文标题@aL"); expect(ledger()).toBe(before);
    await key(el, "Enter"); expect(el.value).toBe("中文标题@Alice "); expect(ledger()).toBe(before);
    await key(el, "Enter");
    const saved = path === "新增母任务" ? appStore.getState().data.tasks.find((task) => task.title === "中文标题")
      : path === "新增子任务" ? parent().subtasks.find((sub) => sub.title === "中文标题")
      : path === "编辑母任务" ? parent() : parent().subtasks[0];
    expect(saved).toMatchObject({ title: "中文标题", who: ["Alice"] });
    expect(useCategoryCreation.getState().pending).toBeNull();
  });

  it.each(["新增子任务", "编辑母任务"])("%s鼠标选候选时阻断卡外事件，只补全；Enter才保存且卡仍展开", async (path) => {
    const el = path === "新增子任务" ? host.querySelector<HTMLTextAreaElement>(".new-sub-row .si-input")!
      : host.querySelector<HTMLTextAreaElement>(".row1 textarea")!;
    const before = ledger(); type(el, "补充结论 @aL");
    const candidate = [...document.querySelectorAll<HTMLButtonElement>(".si-drop button")].find((button) => button.textContent?.includes("Alice"))!;
    await act(async () => { candidate.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })); });
    expect(el.value).toBe("补充结论 @Alice "); expect(ledger()).toBe(before);
    expect(appStore.getState().ui.expandedId).toBe("parent"); expect(host.querySelector(".task-card")).not.toBeNull();
    await key(el, "Enter");
    expect(path === "新增子任务" ? parent().subtasks.find((sub) => sub.title === "补充结论")?.who : parent().who).toEqual(["Alice"]);
    expect(appStore.getState().ui.expandedId).toBe("parent"); expect(host.querySelector(".task-card")).not.toBeNull();
  });

  it.each(["parent", "child"])("编辑%s标题：裸@立刻出现，输入不改需求方，Enter先选择再提交", async (kind) => {
    const el = kind === "parent" ? host.querySelector<HTMLTextAreaElement>(".row1 textarea")! : host.querySelector<HTMLTextAreaElement>('[data-subtask-id="child"] textarea')!;
    const before = ledger();
    type(el, "修改 @"); expect(document.querySelector(".si-drop")!.textContent).toContain("Alice");
    type(el, "修改 @aL");
    expect(ledger()).toBe(before);
    expect(host.querySelector(".tc-properties")!.textContent).toContain("原需求方");
    expect(host.querySelector(".sub-categories")).toBeNull();
    await key(el, "Enter", { isComposing: true }); expect(el.value).toBe("修改 @aL"); expect(ledger()).toBe(before);
    await key(el, "Enter"); expect(el.value).toBe("修改 @Alice "); expect(ledger()).toBe(before);
    await key(el, "Enter");
    expect(kind === "parent" ? parent().who : parent().subtasks[0].who).toEqual(["Alice"]);
    expect(useCategoryCreation.getState().pending).toBeNull();
  });

  it.each(["parent", "child"])("新增%s任务：中文逐字候选，多个人选后统一保存", async (kind) => {
    const el = kind === "parent" ? host.querySelector<HTMLInputElement>(".quick-add .si-input")! : host.querySelector<HTMLTextAreaElement>(".new-sub-row .si-input")!;
    const before = ledger();
    type(el, "新事情 @"); expect(document.querySelector(".si-drop")!.textContent).toContain("Alice");
    type(el, "新事情 @alice @李");
    expect(document.querySelector(".si-drop")!.textContent).toContain("李哥");
    await key(el, "Enter", { isComposing: true }); expect(ledger()).toBe(before);
    await key(el, "Enter"); expect(el.value).toBe("新事情 @alice @李哥 "); expect(ledger()).toBe(before);
    await key(el, "Enter");
    const created = kind === "parent" ? appStore.getState().data.tasks.find((task) => task.title === "新事情") : parent().subtasks.find((sub) => sub.title === "新事情");
    expect(created?.who).toEqual(["Alice", "李哥"]);
    expect(allWho(appStore.getState().data).some((entry) => entry.who === "alice" || entry.who === "李")).toBe(false);
  });

  it("母子未知名字输入、预览、选新建都不写；取消创建保持原账本", async () => {
    const el = host.querySelector<HTMLTextAreaElement>(".row1 textarea")!;
    const before = ledger(); type(el, "修改 @新人");
    expect(document.querySelector(".si-drop")!.textContent).toContain("新建需求方「新人」");
    expect(ledger()).toBe(before);
    await key(el, "Enter"); expect(ledger()).toBe(before); expect(useCategoryCreation.getState().pending).toBeNull();
    await key(el, "Enter"); expect(useCategoryCreation.getState().pending?.draft.name).toBe("新人"); expect(ledger()).toBe(before);
    await key(document.body, "Escape"); expect(ledger()).toBe(before);
    type(el, "修改 @新人 "); await key(el, "Enter"); await choose();
    expect(parent().who).toEqual(["新人"]);
    expect(allWho(appStore.getState().data).some((entry) => entry.who === "新人")).toBe(true);
  });

  it("独立需求方框：@或空白不建人，半截失焦只弹确认，取消零写入；大小写选择复用原名", async () => {
    act(() => [...host.querySelectorAll<HTMLButtonElement>(".tc-properties > button")].find((button) => button.textContent?.includes("原需求方"))!.click());
    const el = document.querySelector<HTMLInputElement>(".task-property-popover input.inline")!;
    const before = ledger(); type(el, "@  "); await key(el, "Enter"); expect(ledger()).toBe(before); expect(useCategoryCreation.getState().pending).toBeNull();
    type(el, "李");
    await act(async () => { el.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
    expect(ledger()).toBe(before); expect(useCategoryCreation.getState().pending?.draft.name).toBe("李");
    await key(document.body, "Escape"); expect(ledger()).toBe(before);
    type(el, "@ALI"); await key(el, "Enter");
    expect(parent().who).toEqual(["原需求方", "Alice"]);
    expect(useCategoryCreation.getState().pending).toBeNull();
  });

  it.each(["parent", "child"])("%s标题半截人名失焦只请求确认，取消不会留下半个人名", async (kind) => {
    const el = kind === "parent" ? host.querySelector<HTMLTextAreaElement>(".row1 textarea")! : host.querySelector<HTMLTextAreaElement>('[data-subtask-id="child"] textarea')!;
    const before = ledger(); type(el, "修改 @新");
    await act(async () => { el.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
    expect(useCategoryCreation.getState().pending?.draft.name).toBe("新"); expect(ledger()).toBe(before);
    await key(document.body, "Escape");
    expect(ledger()).toBe(before); expect(allWho(appStore.getState().data).some((entry) => entry.who === "新")).toBe(false);
  });

  it("快记的独立需求方框筛选现有人名，新建确认取消时不留下选中或人物", async () => {
    const button = [...host.querySelectorAll<HTMLButtonElement>(".qa-picks .qa-pick")].find((element) => element.textContent?.includes("需求方"))!;
    act(() => button.click());
    const el = document.querySelector<HTMLInputElement>('[data-qa-popover] input[placeholder="新需求方，回车确定"]')!;
    const before = ledger(); type(el, "aLI"); await key(el, "Enter");
    expect(el.value).toBe(""); expect(button.textContent).toContain("Alice"); expect(ledger()).toBe(before);
    type(el, "未确认的人"); await key(el, "Enter");
    expect(useCategoryCreation.getState().pending?.draft.name).toBe("未确认的人"); expect(ledger()).toBe(before);
    await key(document.body, "Escape"); expect(ledger()).toBe(before); expect(button.textContent).toContain("Alice");
    expect(allWho(appStore.getState().data).some((entry) => entry.who === "未确认的人")).toBe(false);
  });

  it("确认入口也按大小写回用，输入重复大小写名字不会产生第二个人", async () => {
    const before = ledger();
    expect(await prepareTaskCategories(null, ["ALICE", "alice", "李哥"])).toEqual({ listId: null, who: ["Alice", "李哥"] });
    expect(ledger()).toBe(before); expect(useCategoryCreation.getState().pending).toBeNull();
  });

  it("右键需求方支持逐个选择和空格多选，大小写回用；新名字选后提交仍先确认", async () => {
    act(() => { root.render(createElement(Fragment, null, createElement(ContextMenu), createElement(CategoryCreationHost))); openCtxMenu(20, 20, ["parent"]); });
    const openWho = () => act(() => [...document.querySelectorAll<HTMLButtonElement>(".ctx-item")].find((element) => element.textContent === "需求方…")!.click());
    openWho(); let el = document.querySelector<HTMLInputElement>(".ctx-input")!;
    const before = ledger(); type(el, "@ali");
    expect(document.querySelector(".si-drop")!.textContent).toContain("Alice");
    await key(el, "Enter"); expect(el.value).toBe("@Alice "); expect(ledger()).toBe(before);
    type(el, "@Alice 李"); await key(el, "Enter"); expect(el.value).toBe("@Alice 李哥 ");
    await key(el, "Enter"); expect(parent().who).toEqual(["Alice", "李哥"]);

    act(() => openCtxMenu(30, 30, ["parent"])); openWho(); el = document.querySelector<HTMLInputElement>(".ctx-input")!;
    const selected = ledger(); type(el, "alice 新人"); await key(el, "Enter");
    expect(ledger()).toBe(selected); expect(useCategoryCreation.getState().pending).toBeNull();
    await key(el, "Enter"); expect(useCategoryCreation.getState().pending?.draft.name).toBe("新人"); expect(ledger()).toBe(selected);
    await key(document.body, "Escape"); expect(ledger()).toBe(selected);
  });
});
