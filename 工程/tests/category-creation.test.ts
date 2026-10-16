import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultData, migrate, newTask, DATA_VERSION } from "../src/core/model";
import { allWho, appStore, deleteList, setListColor, updateSettings } from "../src/core/store";
import {
  createCategory, finishCategoryDraft, isTaskCategoryDialogOpen, prepareSubtaskCategories,
  prepareTaskCategories, taskCategoriesNeedConfirmation, useCategoryCreation,
} from "../src/core/categoryCreation";
import { CATEGORY_ICONS } from "../src/core/categoryIcons";
import CategoryCreationHost from "../src/components/CategoryCreationDialog";
import QuickAddBar from "../src/components/QuickAddBar";
import Sidebar from "../src/components/Sidebar";
import { syncStore } from "../src/core/syncCtl";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  const data = defaultData();
  data.tasks = [newTask({ title: "合成任务", who: ["已有需求方"] })];
  appStore.setState({ data, loaded: true, loadError: null, wiped: false });
  syncStore.setState({ session: null });
  useCategoryCreation.setState({ pending: null });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  if (isTaskCategoryDialogOpen()) finishCategoryDraft(null);
  document.body.innerHTML = "";
  vi.clearAllTimers(); vi.useRealTimers();
});

async function choose(patch: Partial<NonNullable<ReturnType<typeof useCategoryCreation.getState>["pending"]>["draft"]> = {}) {
  await act(async () => { finishCategoryDraft({ ...useCategoryCreation.getState().pending!.draft, ...patch }); });
}
function input(el: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("创建分类是一笔确认事务", () => {
  it("多个新清单先确认、后来取消人物时，没有任何分类或任务被写入", async () => {
    const before = appStore.getState().data;
    const result = prepareSubtaskCategories(["新清单甲", "新清单乙"], ["新需求方"]);
    await choose({ icon: "book" });
    expect(appStore.getState().data).toBe(before);
    await choose({ icon: "leaf" });
    expect(appStore.getState().data).toBe(before);
    await act(async () => finishCategoryDraft(null));
    expect(await result).toBeNull();
    expect(appStore.getState().data).toBe(before);
  });

  it("全部确认以后才一起创建，使用所选名称/颜色/两套图标", async () => {
    const before = appStore.getState().data;
    const result = prepareTaskCategories("新读书清单", ["新老师"]);
    await choose({ name: "我的书架", color: "sea", icon: "book" });
    expect(appStore.getState().data).toBe(before);
    await choose({ name: "林老师", color: "plum", icon: "graduate" });
    const prepared = await result;
    expect(prepared?.who).toEqual(["林老师"]);
    expect(appStore.getState().data.lists.find((l) => l.id === prepared?.listId)).toMatchObject({ name: "我的书架", color: "sea", icon: "book" });
    expect(appStore.getState().data.settings.whoAppearance?.["林老师"]).toEqual({ color: "plum", icon: "graduate" });
    expect(allWho(appStore.getState().data)).toContainEqual({ who: "林老师", open: 0 });
    expect(appStore.getState().data.tasks).toBe(before.tasks);
  });

  it("已有名字不弹窗；同名清单优先保留当前所在的那张", async () => {
    const data = appStore.getState().data;
    data.lists.push({ ...data.lists[0], id: "duplicate" });
    appStore.setState({ data: { ...data } });
    const before = appStore.getState().data;
    expect(taskCategoriesNeedConfirmation(data.lists[0].name, ["已有需求方"], "duplicate")).toBe(false);
    expect(await prepareTaskCategories(data.lists[0].name, ["已有需求方"], "duplicate")).toEqual({ listId: "duplicate", who: ["已有需求方"] });
    expect(isTaskCategoryDialogOpen()).toBe(false);
    expect(appStore.getState().data).toBe(before);
  });

  it("侧栏可先建一个尚无任务的人；名字像对象键也能正常保存", async () => {
    const result = createCategory("who", "__proto__");
    await choose({ color: "sand", icon: "team" });
    expect(await result).toBe("__proto__");
    const appearance = JSON.parse(JSON.stringify(appStore.getState().data.settings.whoAppearance));
    expect(Object.prototype.hasOwnProperty.call(appearance, "__proto__")).toBe(true);
    expect(allWho(appStore.getState().data)).toContainEqual({ who: "__proto__", open: 0 });
  });

  it("确认期间账本不可用时不落库", async () => {
    const result = createCategory("list", "不能写入");
    appStore.setState({ wiped: true });
    const before = appStore.getState().data;
    await choose();
    expect(await result).toBeNull();
    expect(appStore.getState().data).toBe(before);
  });

  it("确认期间切账号，后来又回到原账号，也不把旧操作写进账本", async () => {
    const session = { email: "demo@example.test", token: "synthetic-token", rev: 0, syncedAt: null };
    syncStore.setState({ session });
    const result = prepareTaskCategories("跨账号草稿", ["另一个人"]);
    await choose();
    syncStore.setState({ session: null });
    syncStore.setState({ session: { ...session, email: "other@example.test" } });
    syncStore.setState({ session });
    const before = appStore.getState().data;
    await choose();
    expect(await result).toBeNull();
    expect(appStore.getState().data).toBe(before);
  });

  it("目标任务已删除时，在首笔创建前停止，已确认的分类草稿都不留下", async () => {
    let exists = true;
    const result = prepareSubtaskCategories(["新归类"], ["新名字"], () => exists);
    await choose();
    exists = false;
    const before = appStore.getState().data;
    await choose();
    expect(await result).toBeNull();
    expect(appStore.getState().data).toBe(before);
  });

  it("子需求方计数跟子归类视图一致，同名父子不重计", () => {
    const data = appStore.getState().data;
    data.tasks = [newTask({ title: "演示事项", who: ["父需求方"], subtasks: [
      { id: "a", title: "第一步", done: false, due: null, priority: null, who: ["父需求方", "子需求方"] },
      { id: "b", title: "第二步", done: false, due: null, priority: null, who: ["子需求方"] },
      { id: "c", title: "已做完", done: true, due: null, priority: null, who: ["子需求方"] },
      { id: "d", title: "已删除", done: false, deletedAt: "2026-10-16", due: null, priority: null, who: ["已删除的人"] },
    ] })];
    expect(allWho(data)).toEqual([{ who: "子需求方", open: 2 }, { who: "父需求方", open: 1 }]);
  });

  it("外观读入后改其它字段再写回，未来字段保留，数据版本不变", () => {
    const base = defaultData();
    const data = migrate({ ...base, futureRoot: { keep: true }, lists: [{ ...base.lists[0], icon: "book", futureList: "keep" }], settings: { ...base.settings, whoAppearance: { "林老师": { color: "moss", icon: "graduate", futureStyle: true } }, futureSetting: "keep" } });
    appStore.setState({ data });
    setListColor(data.lists[0].id, "sea"); updateSettings({ sortMode: "priority" });
    const saved = JSON.parse(JSON.stringify(appStore.getState().data));
    expect(saved.lists[0]).toMatchObject({ icon: "book", color: "sea", futureList: "keep" });
    expect(saved.settings.whoAppearance["林老师"].futureStyle).toBe(true);
    expect(saved.settings.futureSetting).toBe("keep"); expect(saved.futureRoot).toEqual({ keep: true });
    expect(saved.version).toBe(DATA_VERSION); expect(DATA_VERSION).toBe(8);
  });
});

describe("新建弹窗与入口真实交互", () => {
  it("清单/人物两套图标完全分开，选择颜色图标后提交", async () => {
    act(() => root.render(createElement(CategoryCreationHost)));
    let result!: Promise<string | null>;
    await act(async () => { result = createCategory("list"); });
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.querySelectorAll(".category-icon-options button")).toHaveLength(16);
    expect(dialog.querySelector(".category-icon-options")!.textContent).toBe("");
    expect(CATEGORY_ICONS.who).toHaveLength(16);
    for (const icon of CATEGORY_ICONS.who) expect(CATEGORY_ICONS.list.map((i) => i.id as string)).not.toContain(icon.id);
    input(dialog.querySelector("input")!, "合成读书计划");
    act(() => dialog.querySelector<HTMLButtonElement>('[aria-label="海蓝"]')!.click());
    act(() => dialog.querySelector<HTMLButtonElement>('[aria-label="书本"]')!.click());
    await act(async () => { dialog.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    const id = await result;
    expect(appStore.getState().data.lists.find((l) => l.id === id)).toMatchObject({ color: "sea", icon: "book" });
  });

  it("最后一枚颜色选择器支持自选十六进制颜色，预览与保存保持一致", async () => {
    act(() => root.render(createElement(CategoryCreationHost)));
    let result!: Promise<string | null>;
    await act(async () => { result = createCategory("who", "自选色联系人"); });
    const dialog = document.querySelector('[role="dialog"]')!;
    const color = dialog.querySelector<HTMLInputElement>('input[type="color"]')!;
    expect(color.getAttribute("aria-label")).toBe("自选颜色");
    input(color, "#426b87");
    expect(dialog.querySelector<HTMLElement>(".category-create-preview")!.style.color).toBe("rgb(66, 107, 135)");
    expect(dialog.querySelector(".category-custom-color.selected")).not.toBeNull();
    await act(async () => { dialog.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(await result).toBe("自选色联系人");
    expect(appStore.getState().data.settings.whoAppearance?.["自选色联系人"].color).toBe("#426b87");
  });

  it("侧栏加号可创建需求方；Esc只取消这层且零写入", async () => {
    act(() => root.render(createElement(Fragment, null, createElement(Sidebar), createElement(CategoryCreationHost))));
    const before = appStore.getState().data;
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="新建需求方"]')!.click());
    expect(document.querySelector("#category-create-title")!.textContent).toBe("新建需求方");
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(document.querySelector('[data-category-dialog]')).toBeNull();
    expect(appStore.getState().data).toBe(before);
  });

  it("打一句话认出新清单/人名后取消，原句保留且不假显示已保存", async () => {
    act(() => root.render(createElement(Fragment, null, createElement(QuickAddBar), createElement(CategoryCreationHost))));
    const field = host.querySelector<HTMLInputElement>(".quick-add input")!;
    input(field, "合成任务 /新清单 @新需求方");
    const before = appStore.getState().data;
    await act(async () => { field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(document.querySelector("#category-create-title")!.textContent).toBe("新建清单");
    await choose();
    expect(document.querySelector("#category-create-title")!.textContent).toBe("新建需求方");
    await act(async () => finishCategoryDraft(null));
    expect(field.value).toBe("合成任务 /新清单 @新需求方");
    expect(appStore.getState().data).toBe(before);
  });

  it("确认新人时默认清单被删除，记下的任务不会引用已删清单", async () => {
    const listId = appStore.getState().data.lists[0].id;
    act(() => root.render(createElement(Fragment, null, createElement(QuickAddBar, { defaults: { listId } }), createElement(CategoryCreationHost))));
    const field = host.querySelector<HTMLInputElement>(".quick-add input")!;
    input(field, "合成事项 @新朋友");
    await act(async () => { field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    act(() => deleteList(listId));
    await choose();
    const task = appStore.getState().data.tasks.find((t) => t.title === "合成事项")!;
    expect(task.who).toEqual(["新朋友"]);
    expect(task.listId).toBeNull();
  });
});
