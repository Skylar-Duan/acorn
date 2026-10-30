import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CategoryOverview from "../src/views/CategoryOverview";
import ListView from "../src/views/ListView";
import { appStore, flushSave } from "../src/core/store";
import { defaultData, newTask } from "../src/core/model";

// 10-30：清单／需求方不在侧栏展开，改成右侧主区的总览卡片页。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, host: HTMLDivElement;

beforeEach(async () => {
  await flushSave(); localStorage.clear();
  vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 30, 12));
  const data = defaultData();
  data.lists = ["工作", "学业", "家里"].map((name, i) => ({ id: `l${i}`, name, color: "moss", order: i, updatedAt: "2026-01-01T00:00:00.000Z" }));
  data.tasks = [
    newTask({ id: "a", title: "交周报", listId: "l0", who: ["老板"], due: "2026-10-28" }),
    newTask({ id: "b", title: "订会议室\n第二行不显示", listId: "l0", due: "2026-11-02" }),
    newTask({ id: "c", title: "改简历", listId: "l0", due: "2026-11-05" }),
    newTask({ id: "d", title: "排练", listId: "l0", due: "2026-11-09" }),
    newTask({ id: "e", title: "刷题", listId: "l1", who: ["老师"] }),
    newTask({ id: "f", title: "已做完", listId: "l2", done: true }),
  ];
  appStore.setState({ data, loaded: true, loadError: null, wiped: false, ui: { ...appStore.getState().ui, view: "list", listId: null, who: null, tag: null, expandedId: null } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { act(() => root.unmount()); document.body.innerHTML = ""; vi.useRealTimers(); vi.restoreAllMocks(); await flushSave(); });

const cards = () => [...host.querySelectorAll<HTMLElement>(".category-card")];
const names = () => cards().map((c) => c.querySelector(".category-card-name")!.textContent);
function drop(el: Element, payload: Record<string, string>) {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { types: Object.keys(payload), getData: (k: string) => payload[k] ?? "" } });
  act(() => el.dispatchEvent(event));
}

describe("清单总览", () => {
  it("按清单顺序一张卡一个，显示未完成数、最近三件和过期数", () => {
    act(() => root.render(createElement(CategoryOverview, { kind: "list" })));
    expect(host.querySelector("h1")!.textContent).toBe("清单");
    expect(names()).toEqual(["工作", "学业", "家里"]);
    const work = cards()[0];
    expect(work.querySelector(".category-card-count")!.textContent).toBe("4");
    expect([...work.querySelectorAll(".category-peek-title")].map((e) => e.textContent)).toEqual(["交周报", "订会议室", "改简历"]);
    expect(work.querySelector(".category-peek-due.late")).not.toBeNull();
    expect(work.querySelector(".category-card-foot")!.textContent).toContain("还有 1 件");
    expect(work.querySelector(".category-card-foot")!.textContent).toContain("1 件已过期");
    expect(cards()[2].querySelector(".category-card-clear")!.textContent).toBe("都做完了");
    act(() => appStore.setState({ data: { ...appStore.getState().data, lists: [...appStore.getState().data.lists, { id: "l3", name: "空的", color: "sea", order: 3, updatedAt: "2026-01-01T00:00:00.000Z" }] } }));
    expect(cards()[3].querySelector(".category-card-clear")!.textContent).toBe("还没有事");
  });

  it("点卡进入这个清单；任务拖到卡上归进去；卡拖卡换顺序", () => {
    act(() => root.render(createElement(CategoryOverview, { kind: "list" })));
    drop(cards()[1], { "text/acorn-task": "a,b" });
    expect(appStore.getState().data.tasks.filter((t) => t.listId === "l1").map((t) => t.id).sort()).toEqual(["a", "b", "e"]);
    drop(cards()[0], { "text/acorn-list-move": "l2" });
    expect(names()).toEqual(["家里", "工作", "学业"]);
    act(() => cards()[1].click());
    expect(appStore.getState().ui).toMatchObject({ view: "list", listId: "l0" });
  });

  it("需求方总览：点进某人，任务拖上去追加需求方", () => {
    appStore.setState({ ui: { ...appStore.getState().ui, view: "who" } });
    act(() => root.render(createElement(CategoryOverview, { kind: "who" })));
    expect(host.querySelector("h1")!.textContent).toBe("需求方");
    expect(names()).toEqual(expect.arrayContaining(["老板", "老师"]));
    const teacher = cards().find((c) => c.textContent!.includes("老师"))!;
    drop(teacher, { "text/acorn-task": "a" });
    expect(appStore.getState().data.tasks.find((t) => t.id === "a")!.who).toEqual(["老板", "老师"]);
    act(() => teacher.click());
    expect(appStore.getState().ui).toMatchObject({ view: "who", who: "老师" });
  });

  it("单个清单页左上有返回，回到总览", () => {
    appStore.setState({ ui: { ...appStore.getState().ui, view: "list", listId: "l0" } });
    act(() => root.render(createElement(ListView, { kind: "list" })));
    expect(host.querySelector(".main")!.classList).toContain("category-detail");
    act(() => host.querySelector<HTMLButtonElement>(".category-back")!.click());
    expect(appStore.getState().ui).toMatchObject({ view: "list", listId: null });
  });
});
