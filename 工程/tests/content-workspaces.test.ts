import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Calendar from "../src/views/Calendar";
import Habits from "../src/views/Habits";
import StatsView from "../src/views/StatsView";
import Quadrant from "../src/views/Quadrant";
import ListView from "../src/views/ListView";
import { appStore } from "../src/core/store";
import { defaultData, newTask } from "../src/core/model";
import { addDays, todayYMD } from "../src/core/dates";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let host: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-16T12:00:00+08:00"));
  localStorage.clear();
  appStore.setState({ data: defaultData(), loaded: true, loadError: null, ui: { ...appStore.getState().ui, expandedId: null, ctxMenu: null } });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); document.body.innerHTML = ""; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });
const render = (node: ReactElement) => act(() => root.render(node));
const click = (node: Element) => act(() => (node as HTMLElement).click());
const button = (name: string, within: ParentNode = host) => [...within.querySelectorAll<HTMLButtonElement>("button")].find((el) => el.textContent?.trim() === name)!;
const dataWith = (tasks: ReturnType<typeof newTask>[]) => appStore.setState({ data: { ...defaultData(), tasks } });

describe("日历工作面真实交互", () => {
  it("拥挤日+N打开完整议程，切换筛选不写任务，关闭后仍可键盘打开", () => {
    const today = todayYMD();
    dataWith([...Array.from({ length: 8 }, (_, i) => newTask({ title: `合成安排${i}`, due: today, dueTime: "09:30" })), newTask({ title: "合成已完成", done: true, doneAt: new Date().toISOString(), due: today })]);
    const before = appStore.getState().data;
    render(createElement(Calendar));
    expect(host.querySelector(".cal-toolbar")).not.toBeNull();
    expect(host.querySelector(".cal-task-time")!.textContent).toBe("09:30");
    click(host.querySelector("button.cal-more")!);
    const agenda = host.querySelector('[aria-label="当天议程"]')!;
    expect(agenda.querySelectorAll(".cal-day-row")).toHaveLength(9);
    click(button("已完成", host.querySelector('[aria-label="日历记录"]')!));
    expect(agenda.querySelectorAll(".cal-day-row")).toHaveLength(1);
    expect(agenda.textContent).toContain("合成已完成");
    expect(appStore.getState().data).toBe(before);
    click(host.querySelector('[aria-label="收起当天议程"]')!);
    expect(host.querySelector('[aria-label="当天议程"]')).toBeNull();
    act(() => host.querySelector(`[data-day="${today}"]`)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(host.querySelector('[aria-label="当天议程"]')).not.toBeNull();
  });

  it("月周切换和翻页保留模式、当日安排点击仍展开原任务", () => {
    const task = newTask({ title: "合成日程", due: todayYMD() }); dataWith([task]); render(createElement(Calendar));
    click(button("周", host.querySelector('[aria-label="日历视图"]')!));
    expect(host.querySelectorAll(".cal-cell")).toHaveLength(7);
    expect(localStorage.getItem("acorn-calendar-mode")).toBe("week");
    click(host.querySelector('[aria-label="下一周"]')!);
    expect(host.querySelector(".cal-task")).toBeNull();
    click(button("今天", host.querySelector(".cal-nav")!));
    click(host.querySelector(".cal-task")!);
    expect(appStore.getState().ui.expandedId).toBe(task.id);
  });

  it("回到今天同步议程日期，切换模式清除旧视野的议程", () => {
    render(createElement(Calendar));
    click(host.querySelector('[aria-label="下个月"]')!);
    const future = host.querySelector('.cal-cell[data-day^="2026-11"]')!;
    click(future);
    expect(host.querySelector('[aria-label="当天议程"]')!.textContent).toContain("11月");
    click(button("今天", host.querySelector(".cal-nav")!));
    expect(host.querySelector('[aria-label="当天议程"]')!.textContent).toContain("10月16日");
    click(button("周", host.querySelector('[aria-label="日历视图"]')!));
    expect(host.querySelector('[aria-label="当天议程"]')).toBeNull();
    expect(host.querySelectorAll(".cal-cell")).toHaveLength(7);
  });
});

describe("习惯周进度保持独立规则", () => {
  it("三组继续按顺序显示，打卡/撤销和展开详情均可用", () => {
    const today = todayYMD();
    const habit = newTask({ title: "阅读演示资料", kind: "habit", repeat: { kind: "daily", every: 1 }, createdAt: "2026-10-01T00:00:00Z" });
    dataWith([habit, newTask({ title: "周末运动", kind: "habit", repeat: { kind: "weekly", days: [0] }, createdAt: "2026-10-01T00:00:00Z" }), newTask({ title: "下月复盘", repeat: { kind: "monthly", day: 1 }, due: "2026-11-01" })]);
    render(createElement(Habits));
    const labels = [...host.querySelectorAll(".hb-section-head h2,.group-head")].map((e) => e.textContent);
    expect(labels).toEqual(["今天要做的0/1", "重复的计划", "今天不用做"]);
    expect(host.querySelectorAll(".hb-week-labels span")).toHaveLength(14);
    expect(host.querySelectorAll(".hb-row .hb-dot")).toHaveLength(14);
    click(host.querySelector('.hb-check[aria-label="给「阅读演示资料」打卡"]')!);
    expect(appStore.getState().data.tasks[0].checkIns).toContain(today);
    click(host.querySelector('.hb-check[aria-label="撤销「阅读演示资料」今天的打卡"]')!);
    expect(appStore.getState().data.tasks[0].checkIns).not.toContain(today);
    click(host.querySelector(".hb-main")!);
    expect(host.querySelectorAll(".hb-month .hb-cell").length).toBeGreaterThan(27);
    expect(host.querySelector(".hb-main")!.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("四象限可访问性与原属性变更", () => {
  it("键盘向远期移三天只改变日期，重要性不被重写；仍打开同一任务", () => {
    const task = newTask({ title: "合成跨格任务", priority: 3, due: todayYMD() }); dataWith([task]); render(createElement(Quadrant));
    const target = host.querySelector(".quad-point")!;
    for (const key of [" ", "ArrowLeft", "ArrowLeft", "ArrowLeft", "Enter"]) act(() => target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
    expect(appStore.getState().data.tasks[0]).toMatchObject({ due: addDays(todayYMD(), 3), priority: 3 });
    act(() => target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(appStore.getState().ui.expandedId).toBe(task.id);
  });
});

describe("回收站恢复优先的真实行", () => {
  it("母/子两类行展示上下文，分别恢复后退出回收站，且不加入普通任务键盘选行", () => {
    const deletedAt = new Date().toISOString();
    dataWith([newTask({ title: "合成已删任务", deletedAt }), newTask({ title: "仍在的母任务", subtasks: [{ id: "deleted-step", title: "可恢复的步骤", done: false, deletedAt }] })]);
    render(createElement(ListView, { kind: "trash" }));
    expect(host.querySelectorAll(".trash-row")).toHaveLength(2);
    expect(host.querySelector(".trash-sub .trash-parent")!.textContent).toContain("仍在的母任务");
    expect(host.querySelector(".trash-row[data-task-id]")).toBeNull();
    click(host.querySelector(".trash-sub .trash-restore")!);
    expect(appStore.getState().data.tasks[1].subtasks[0].deletedAt).toBeFalsy();
    expect(host.querySelectorAll(".trash-row")).toHaveLength(1);
    click(host.querySelector(".trash-restore")!);
    expect(host.querySelector(".trash-empty")!.textContent).toContain("回收站是空的");
    expect(button("清空回收站")).toBeUndefined();
  });
});

describe("统计双栏仪表板", () => {
  it("完成/放弃保持分列，图表有范围摘要，长需求方继续完整提供提示", () => {
    const now = new Date().toISOString(); const who = "合成的很长需求方名称";
    dataWith([newTask({ title: "完成", done: true, doneAt: now, who: [who] }), newTask({ title: "放弃", droppedAt: now })]);
    render(createElement(StatsView));
    expect(host.querySelectorAll(".stats-analysis > .stats-panel")).toHaveLength(2);
    expect([...host.querySelectorAll(".stats-label")].map((e) => e.textContent)).toEqual(["本周完成", "本周放弃", "连续有完成"]);
    expect(host.querySelector('[aria-label="完成热力图"] [role="img"]')!.getAttribute("aria-label")).toContain("共完成1件");
    expect(host.querySelector('[aria-label="各需求方分布"] .stats-dist-name')!.getAttribute("title")).toBe(who);
    expect(button("导出本周小结")).toBeDefined();
  });

  it("空本数字为零，所有比例有限，空图仍有可理解范围", () => {
    render(createElement(StatsView));
    expect([...host.querySelectorAll(".stats-num")].every((e) => e.textContent?.startsWith("0"))).toBe(true);
    expect(host.innerHTML).not.toMatch(/NaN|Infinity/);
    expect(host.querySelector('[aria-label="各需求方分布"]')!.textContent).toContain("还没有记录需求方");
    expect(host.querySelector(".stats-chart-caption")!.textContent).toContain("—");
  });
});
