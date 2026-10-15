import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Sidebar from "../src/components/Sidebar";
import SidebarSettings from "../src/components/SidebarSettings";
import { appStore, updateSettings } from "../src/core/store";
import { defaultData, migrate, newTask, DATA_VERSION } from "../src/core/model";
import { syncStore } from "../src/core/syncCtl";
import { todayYMD } from "../src/core/dates";
import {
  moveSidebarModule, setSidebarHidden, setSidebarName, sidebarHidden, sidebarModules, sidebarName,
  SIDEBAR_MODULE_MIME,
} from "../src/core/sidebar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  const data = defaultData();
  data.lists = Array.from({ length: 5 }, (_, i) => ({ id: `list-${i}`, name: `演示清单 ${i}`, color: "moss", order: i, updatedAt: "2026-01-01T00:00:00.000Z" }));
  data.tasks = Array.from({ length: 5 }, (_, i) => newTask({ id: `task-${i}`, title: `合成任务 ${i}`, listId: `list-${i}`, who: [`演示需求方 ${i}`], tags: [`演示标签 ${i}`], due: null }));
  appStore.setState({ data, loaded: true, loadError: null, ui: { ...appStore.getState().ui, view: "plan", listId: null, who: null, tag: null, expandedId: null, ctxMenu: null } });
  syncStore.setState({ session: null, phase: "off", message: "", restored: null });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = "";
  vi.clearAllTimers();
  vi.useRealTimers();
});

function render(component = Sidebar) { act(() => root.render(createElement(component))); }
const moduleIds = () => [...host.querySelectorAll<HTMLElement>("[data-sidebar-module]")].map((e) => e.dataset.sidebarModule);
const moduleElement = (id: string) => host.querySelector<HTMLElement>(`[data-sidebar-module="${id}"]`)!;
function drop(el: Element, payload: Record<string, string>) {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperties(event, { clientX: { value: 20 }, clientY: { value: 20 } });
  Object.defineProperty(event, "dataTransfer", { value: { types: Object.keys(payload), getData: (key: string) => payload[key] ?? "" } });
  act(() => el.dispatchEvent(event));
}
function button(text: string, container: ParentNode = document) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find((e) => e.textContent?.trim() === text)!;
}

describe("模块偏好：兼容旧数据与未来字段", () => {
  it("缺字段时使用原有导航顺序，所有模块展开", () => {
    expect(sidebarModules().map((m) => m.id)).toEqual(["plan", "calendar", "today", "habits", "done", "stats", "trash", "lists", "who", "tags"]);
    expect(sidebarHidden("lists")).toBe(false);
    expect(sidebarName("today")).toBe("今日任务");
  });
  it("已存顺序去重，忽略陌生模块显示，并保留未认识的字段", () => {
    const raw = { order: ["lists", "lists", "future-module", "plan"], hidden: ["future-module"], labels: { "future-module": "以后", lists: "我的清单" }, futureField: { keep: true } };
    expect(sidebarModules(raw).slice(0, 2).map((m) => m.id)).toEqual(["lists", "plan"]);
    const moved = moveSidebarModule(raw, "today", "lists")!;
    expect(moved.order?.filter((id) => id === "lists")).toHaveLength(1);
    expect(moved.order).toContain("future-module");
    expect(moved).toHaveProperty("futureField", { keep: true });
    expect(setSidebarHidden(moved, "lists", true).hidden).toContain("future-module");
  });
  it("向下拖与拖到末尾都对准落点，隐藏不丢顺序，恢复默认名只清别名", () => {
    let prefs = moveSidebarModule(undefined, "plan", "today")!;
    expect(sidebarModules(prefs).slice(0, 3).map((m) => m.id)).toEqual(["calendar", "plan", "today"]);
    prefs = setSidebarHidden(prefs, "plan", true);
    prefs = moveSidebarModule(prefs, "plan", null)!;
    const ordered = sidebarModules(prefs);
    expect(ordered[ordered.length - 1]?.id).toBe("plan");
    expect(sidebarHidden("plan", prefs)).toBe(true);
    prefs = setSidebarName(prefs, "plan", "  我的安排  ");
    expect(sidebarName("plan", prefs)).toBe("我的安排");
    expect(sidebarName("plan", setSidebarName(prefs, "plan", ""))).toBe("计划");
    expect(moveSidebarModule(prefs, "who", "who")).toBeNull();
    expect(moveSidebarModule(prefs, "future-module", "plan")).toBeNull();
  });
  it("读入、调整布局再写回，未来数据保留，DATA_VERSION 不变", () => {
    const data = migrate({ ...defaultData(), futureField: { keep: true }, settings: { ...defaultData().settings, futureSetting: "keep", sidebar: { futureField: "keep", labels: { future: "keep" } } } });
    appStore.setState({ data });
    updateSettings({ sidebar: setSidebarName(data.settings.sidebar, "lists", "我的分类") });
    const saved = JSON.parse(JSON.stringify(appStore.getState().data));
    expect(saved.futureField).toEqual({ keep: true });
    expect(saved.settings.futureSetting).toBe("keep");
    expect(saved.settings.sidebar.futureField).toBe("keep");
    expect(saved.settings.sidebar.labels.future).toBe("keep");
    expect(saved.version).toBe(DATA_VERSION);
    expect(DATA_VERSION).toBe(8);
  });
});

describe("桌面侧栏真实交互", () => {
  it("清单/需求方/标签全部显示，不受老折叠记忆影响", () => {
    for (const key of ["more", "lists", "who", "tags"]) localStorage.setItem(`acorn-side-${key}`, "0");
    render();
    for (const id of ["lists", "who", "tags"]) expect(moduleElement(id).querySelectorAll("li")).toHaveLength(5);
    expect(host.querySelector(".side-more,.side-fold")).toBeNull();
    expect(moduleIds()).toContain("done");
    expect(host.querySelectorAll(".side-module-heading")).toHaveLength(3);
  });
  it("整组拖排只改本机布局，里面的清单顺序和任务一字不变", () => {
    render();
    const before = appStore.getState().data;
    drop(moduleElement("plan"), { [SIDEBAR_MODULE_MIME]: "lists" });
    expect(moduleIds().slice(0, 2)).toEqual(["lists", "plan"]);
    expect(appStore.getState().data.lists).toBe(before.lists);
    expect(appStore.getState().data.tasks).toBe(before.tasks);
    drop(host.querySelector(".side-module-end")!, { [SIDEBAR_MODULE_MIME]: "lists" });
    const ids = moduleIds();
    expect(ids[ids.length - 1]).toBe("lists");
  });
  it("模块拖到任务落点不会改日期或归属，任务拖到清单仍能归类", () => {
    render();
    const tasks = appStore.getState().data.tasks;
    drop(moduleElement("today").querySelector("li")!, { [SIDEBAR_MODULE_MIME]: "calendar" });
    expect(appStore.getState().data.tasks).toBe(tasks);
    drop(moduleElement("lists").querySelectorAll("li")[2], { "text/acorn-task": "task-0" });
    expect(appStore.getState().data.tasks[0].listId).toBe("list-2");
  });
  it("拖任务到今日任务仍改今天；拖给需求方仍追加需求方", () => {
    render();
    drop(moduleElement("today").querySelector("li")!, { "text/acorn-task": "task-0" });
    expect(appStore.getState().data.tasks[0].due).toBe(todayYMD());
    const who = moduleElement("who").querySelectorAll("li")[1];
    const name = who.querySelector(".side-label")!.textContent;
    drop(who, { "text/acorn-task": "task-0" });
    expect(appStore.getState().data.tasks[0].who).toContain(name);
  });
  it("拖到计划仍先选日期，拖子任务到今天只改这一步", () => {
    const data = appStore.getState().data;
    data.tasks[0] = { ...data.tasks[0], subtasks: [{ id: "step-0", title: "演示步骤", done: false, due: null, priority: null }] };
    appStore.setState({ data: { ...data } });
    render();
    drop(moduleElement("plan").querySelector("li")!, { "text/acorn-task": "task-1" });
    expect(appStore.getState().data.tasks[1].due).toBeNull();
    expect(host.querySelector(".side-plan-pop")).not.toBeNull();
    act(() => button("明天", host.querySelector(".side-plan-pop")!).click());
    expect(appStore.getState().data.tasks[1].due).not.toBeNull();
    drop(moduleElement("today").querySelector("li")!, { "text/acorn-task": "task-0", "text/acorn-sub": "task-0:step-0" });
    expect(appStore.getState().data.tasks[0].due).toBeNull();
    expect(appStore.getState().data.tasks[0].subtasks[0].due).toBe(todayYMD());
  });
  it("组内清单拖动仍改变原来的清单顺序，模块位置保持原样", () => {
    render();
    const before = moduleIds();
    drop(moduleElement("lists").querySelector("li")!, { "text/acorn-list-move": "list-4" });
    expect(moduleElement("lists").querySelector(".side-label")!.textContent).toBe("清单");
    expect(moduleElement("lists").querySelector("li .side-label")!.textContent).toBe("演示清单 4");
    expect(moduleIds()).toEqual(before);
    expect(appStore.getState().data.lists.find((l) => l.id === "list-4")!.order).toBe(0);
  });
  it("右键编辑模块别名只改本机称呼，清单与人名保持原样", () => {
    render();
    const before = appStore.getState().data;
    act(() => moduleElement("who").querySelector(".side-module-heading")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 })));
    act(() => button("编辑显示名称").click());
    const input = document.getElementById("sidebar-module-name") as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "协作伙伴");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => document.querySelector(".sidebar-module-menu form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(moduleElement("who").querySelector(".side-label")!.textContent).toBe("协作伙伴");
    expect(appStore.getState().data.tasks).toBe(before.tasks);
    expect(appStore.getState().data.lists).toBe(before.lists);
  });
  it("右键可隐藏整组，任务保留，设置＋可以恢复同一位置", () => {
    render();
    const tasks = appStore.getState().data.tasks;
    act(() => moduleElement("lists").querySelector(".side-module-heading")!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 20, clientY: 20 })));
    act(() => button("隐藏模块").click());
    expect(moduleIds()).not.toContain("lists");
    expect(appStore.getState().data.tasks).toBe(tasks);
    render(SidebarSettings);
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="添加清单"]')!.click());
    render();
    expect(moduleIds().slice(-3)).toEqual(["lists", "who", "tags"]);
  });
  it("隐藏全部后固定设置齿轮还在，所有模块都能恢复", () => {
    let prefs = appStore.getState().data.settings.sidebar;
    sidebarModules().forEach((m) => { prefs = setSidebarHidden(prefs, m.id, true); });
    appStore.setState({ data: { ...appStore.getState().data, settings: { ...appStore.getState().data.settings, sidebar: prefs } } });
    render();
    expect(moduleIds()).toEqual([]);
    expect(host.querySelector('button[title="设置"]')).not.toBeNull();
    expect(button("编辑侧栏", host)).toBeDefined();
    render(SidebarSettings);
    expect(host.querySelectorAll(".hidden-module .sidebar-toggle")).toHaveLength(10);
  });
});
