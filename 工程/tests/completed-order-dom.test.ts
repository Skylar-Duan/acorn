import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const platform = vi.hoisted(() => ({ mobile: false }));
vi.mock("../src/core/platform", async (original) => ({ ...await original<typeof import("../src/core/platform")>(), get isMobile() { return platform.mobile; } }));
import Done from "../src/views/Done";
import Calendar from "../src/views/Calendar";
import Today from "../src/views/Today";
import { appStore, completeTask, updateTask } from "../src/core/store";
import { defaultData, newTask, type Subtask, type Task } from "../src/core/model";
import { todayYMD } from "../src/core/dates";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-16T18:00:00+08:00"));
  platform.mobile = false; localStorage.clear();
  appStore.setState({ data: defaultData(), loaded: true, loadError: null, ui: { ...appStore.getState().ui, expandedId: null, selectedIds: [], ctxMenu: null } });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });
const render = (component: typeof Done) => act(() => root.render(createElement(component)));
const click = (node: Element) => act(() => (node as HTMLElement).click());
const button = (text: string) => [...host.querySelectorAll("button")].find((node) => node.textContent?.trim() === text)!;
const load = (tasks: Task[]) => act(() => appStore.setState({ data: { ...defaultData(), tasks } }));
const rows = () => [...host.querySelectorAll(platform.mobile ? ".mrow-title" : ".task-row .title")].map((node) => node.textContent?.trim());
const sub = (id: string, title: string, doneAt: string | null): Subtask => ({ id, title, done: true, doneAt });
const done = (title: string, doneAt: string | null) => newTask({ title, done: true, doneAt });

describe.each([false, true])("已完成真实行共用排序，mobile=%s", (mobile) => {
  it("母任务和子任务按实际时刻倒序，刚完成的置顶，编辑旧标题不跳位且不写原数组", () => {
    platform.mobile = mobile;
    const early = done("早完成", "2026-10-16T01:00:00Z");
    const parent = newTask({ title: "母任务", subtasks: [sub("middle", "中间完成步骤", "2026-10-16T02:00:00Z")] });
    const latest = done("晚完成", "2026-10-16T03:00:00Z");
    const original = [early, parent, latest]; load(original); render(Done);
    expect(rows()).toEqual(["晚完成", mobile ? "中间完成步骤" : "母任务 › 中间完成步骤", "早完成"]);
    const newest = newTask({ title: "刚完成" });
    load([...original, newest]);
    act(() => completeTask(newest.id));
    expect(rows()[0]).toBe("刚完成");
    act(() => updateTask(early.id, { title: "早完成改文字" }));
    const data = appStore.getState().data;
    const titles = rows();
    expect(titles[titles.length - 1]).toBe("早完成改文字");
    expect(appStore.getState().data).toBe(data);
    expect(original).toEqual([early, parent, latest]);
  });

  it("同刻稳定、缺失和非法时刻沉底且不显示伪完成日", () => {
    platform.mobile = mobile;
    const noTime = done("缺完成时间", null);
    const invalid = done("非法完成时间", "not-a-date");
    const first = done("同刻第一条", "2026-10-16T02:00:00Z");
    const equal = done("同刻第二条", "2026-10-16T02:00:00Z");
    load([noTime, first, invalid, equal]); render(Done);
    expect(rows()).toEqual(["同刻第一条", "同刻第二条", "缺完成时间", "非法完成时间"]);
    expect(host.textContent).not.toMatch(/NaN|Invalid Date/);
    const unknown = [...host.querySelectorAll(platform.mobile ? ".mrow" : ".task-row")].filter((node) => /缺完成时间|非法完成时间/.test(node.textContent || ""));
    expect(unknown).toHaveLength(2);
    unknown.forEach((node) => expect(node.textContent).not.toContain("完成于"));
  });

  it("放弃仍按放弃时间，全部按各自实际结束时间排序并保留时间分组", () => {
    platform.mobile = mobile;
    const completed = done("完成记录", "2026-10-16T02:00:00Z");
    const oldDropped = newTask({ title: "早放弃", droppedAt: "2026-10-16T01:00:00Z" });
    const newDropped = newTask({ title: "晚放弃", droppedAt: "2026-10-16T03:00:00Z" });
    load([oldDropped, completed, newDropped]); render(Done);
    click(button("放弃的")); expect(rows()).toEqual(["晚放弃", "早放弃"]);
    click(button("全部")); expect(rows()).toEqual(["晚放弃", "完成记录", "早放弃"]);
    expect(host.querySelector(".group-label")!.textContent).toContain("过去一周");
  });
});

describe("日历和今日已完成小列表", () => {
  it.each([false, true])("日历完成桶的预览和完整清单均按时刻倒序，mobile=%s", (mobile) => {
    platform.mobile = mobile;
    const early = done("日历早完成", "2026-10-16T01:00:00Z");
    const late = done("日历晚完成", "2026-10-16T03:00:00Z");
    const data = { ...defaultData(), tasks: [early, late, done("无时刻不进日历", null), done("非法不进日历", "bad-time")] };
    act(() => appStore.setState({ data })); render(Calendar);
    click(button("已完成"));
    if (mobile) {
      expect([...host.querySelectorAll(".cal-daylist .mrow-title")].map((node) => node.textContent)).toEqual(["日历晚完成", "日历早完成"]);
    } else {
      const today = host.querySelector(`[data-day="${todayYMD()}"]`)!;
      expect([...today.querySelectorAll(".cal-task")].map((node) => node.textContent)).toEqual(["✓日历晚完成", "✓日历早完成"]);
      click(today);
      expect([...host.querySelectorAll(".cal-day-row")].map((node) => node.textContent)).toEqual(["✓日历晚完成", "✓日历早完成"]);
    }
    expect(appStore.getState().data).toBe(data);
  });

  it.each([false, true])("今日已完成同刻稳定，带时区戳按真实时刻，mobile=%s", (mobile) => {
    platform.mobile = mobile;
    // 字面字符串倒序会把+09:00的18点排到17:30+08:00前面，但真实时刻后者晚30分钟。
    const first = done("同刻第一", "2026-10-16T17:30:00+08:00");
    const equal = done("同刻第二", "2026-10-16T09:30:00Z");
    const early = done("更早", "2026-10-16T18:00:00+09:00");
    load([first, early, equal]); render(Today);
    if (mobile) click(host.querySelector(".mfoldrow")!);
    expect(rows()).toEqual(["同刻第一", "同刻第二", "更早"]);
  });
});
