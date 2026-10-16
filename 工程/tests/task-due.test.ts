import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultData, newTask, type Subtask, type Task } from "../src/core/model";
import { taskDue, taskTime } from "../src/core/taskDue";
import { listGroups, planGroups } from "../src/core/plan";
import { exportWeekMarkdown, weeklyReview } from "../src/core/stats";
import {
  appStore, flushSave, openRows, rowDue, rowTime, sortTasks, tasksForToday,
  postponeRows, postponeRowsTo, postponeTasks, toggleSubtask, undo, updateTask,
} from "../src/core/store";
import TaskCard from "../src/components/TaskCard";
import SearchOverlay from "../src/components/SearchOverlay";
import ListView from "../src/views/ListView";
import QuadrantBoard from "../src/views/Quadrant";
import Calendar from "../src/views/Calendar";

const TODAY = "2026-10-15";
const STAMP = "2026-10-15T04:00:00.000Z";
const step = (id: string, due: string | null, patch: Partial<Subtask> = {}): Subtask =>
  ({ id, title: id, done: false, due, ...patch });
const parent = (patch: Partial<Task> = {}) => newTask({
  id: "parent", title: "整理项目", due: null,
  subtasks: [step("later", "2026-10-20"), step("next", TODAY)], ...patch,
});
const roots: Root[] = [];
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount(element: ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(element));
  return host;
}

function put(...tasks: Task[]) {
  appStore.setState({ data: { ...defaultData(), tasks } });
}

function findParent(host: HTMLDivElement) {
  const input = host.querySelector("input")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "整理项目");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return host.querySelector<HTMLButtonElement>(".so-item")!;
}

beforeEach(async () => {
  await flushSave();
  while (appStore.getState().undoDepth > 0) undo();
  await flushSave();
  localStorage.clear();
  appStore.setState({
    data: defaultData(), loaded: true, undoDepth: 0,
    ui: { ...appStore.getState().ui, expandedId: null, listId: null, view: "plan", selectedIds: [] },
  });
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 15, 12));
});

afterEach(async () => {
  act(() => roots.splice(0).forEach((r) => r.unmount()));
  document.body.innerHTML = "";
  vi.useRealTimers();
  await flushSave();
});

describe("母任务没手排日期时，从还欠着的子任务取最早安排", () => {
  it("显示最早日期，逾期的也算；不改写母任务和任何子任务", () => {
    const task = parent({ subtasks: [step("future", TODAY), step("overdue", "2026-10-12")] });
    const before = JSON.stringify(task);
    expect(taskDue(task)).toBe("2026-10-12");
    expect(rowDue({ task, sub: null })).toBe("2026-10-12");
    expect(JSON.stringify(task)).toBe(before);
    expect(task.due).toBeNull();
  });

  it("母任务有手排日期时，日期和钟点都优先用母任务的", () => {
    const task = parent({ due: "2026-10-30", dueTime: "16:00" });
    expect(taskDue(task)).toBe("2026-10-30");
    expect(taskTime(task)).toBe("16:00");
    expect(taskTime({ ...task, dueTime: null })).toBeNull();
  });

  it("排除已完成、回收站、放弃的步骤，兼容老子任务缺状态字段", () => {
    const task = parent({ subtasks: [
      step("done", "2026-10-01", { done: true }),
      step("deleted", "2026-10-02", { deletedAt: STAMP }),
      step("dropped", "2026-10-03", { droppedAt: STAMP }),
      step("old", TODAY),
    ] });
    expect(taskDue(task)).toBe(TODAY);
  });

  it("没有仍待办且已排期的步骤，母任务回到未安排", () => {
    expect(taskDue(parent({ subtasks: [step("done", TODAY, { done: true }), step("blank", null)] }))).toBeNull();
    expect(taskDue(parent({ subtasks: [] }))).toBeNull();
  });

  it.each([{ done: true }, { droppedAt: STAMP }, { deletedAt: STAMP }])(
    "已经收场或删除的母任务不从子任务获得日期 %j", (patch) => {
      expect(taskDue(parent(patch))).toBeNull();
      expect(taskTime(parent(patch))).toBeNull();
      expect(taskDue(parent({ ...patch, due: TODAY }))).toBe(TODAY);
    },
  );

  it("同日取最早钟点，绝不把别一天或母任务残留的钟点拼上来", () => {
    const task = parent({ dueTime: "06:00", subtasks: [
      step("untimed", TODAY), step("late", TODAY, { dueTime: "14:00" }),
      step("early", TODAY, { dueTime: "09:00" }), step("other", "2026-10-20", { dueTime: "07:00" }),
    ] });
    expect(taskTime(task)).toBe("09:00");
    expect(rowTime({ task, sub: null })).toBe("09:00");
    expect(taskTime(parent({ dueTime: "06:00" }))).toBeNull();
  });

  it("兄弟的安排不传给无日期子任务，今天/计划继续逐步安排", () => {
    const task = parent({ subtasks: [step("next", TODAY), step("blank", null)] });
    const data = { ...defaultData(), tasks: [task] };
    expect(taskDue(task)).toBe(TODAY);
    expect(rowDue({ task, sub: task.subtasks[1] })).toBeNull();
    const groups = planGroups(openRows(data), "time", TODAY);
    expect(groups.find((g) => g.key === "today")!.rows.map((r) => r.sub!.id)).toEqual(["next"]);
    expect(groups.find((g) => g.key === "nodate")!.rows.map((r) => r.sub!.id)).toEqual(["blank"]);
    expect(tasksForToday(data, TODAY).todays.map((r) => r.sub!.id)).toEqual(["next"]);
  });

  it("清单分组和排序把母任务按最近步骤安排，手排仍优先", () => {
    const auto = parent();
    const earlier = parent({ id: "earlier", due: "2026-10-14" });
    const manual = parent({ id: "manual", due: "2026-10-25" });
    const blank = parent({ id: "blank", subtasks: [] });
    const sorted = sortTasks([blank, manual, auto, earlier], "time");
    expect(sorted.map((t) => t.id)).toEqual(["earlier", "parent", "manual", "blank"]);
    expect(listGroups(sorted, TODAY, "未安排").map((g) => g.rows.map((t) => t.id)))
      .toEqual([["earlier"], ["parent"], ["manual"], ["blank"]]);
  });

  it("完成一步后母任务日期移到下一步，撤销后恢复，手排字段一直为空", () => {
    put(parent());
    toggleSubtask("parent", "next");
    expect(taskDue(appStore.getState().data.tasks[0])).toBe("2026-10-20");
    expect(appStore.getState().data.tasks[0].due).toBeNull();
    undo();
    expect(taskDue(appStore.getState().data.tasks[0])).toBe(TODAY);
  });

  it("清除母任务手排日期后恢复按子任务算，不写回推导结果", () => {
    put(parent({ due: "2026-10-30", dueTime: "16:00" }));
    updateTask("parent", { due: null });
    const task = appStore.getState().data.tasks[0];
    expect(taskDue(task)).toBe(TODAY);
    expect(task.due).toBeNull();
    expect(task.dueTime).toBeNull();
  });

  it("循环子任务完成时先按现有规则推进，母任务跟随下一次安排", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 15, 12));
    put(parent({ subtasks: [step("daily", TODAY, { repeat: { kind: "daily", every: 1 } })] }));
    toggleSubtask("parent", "daily");
    const task = appStore.getState().data.tasks[0];
    expect(taskDue(task)).toBe("2026-10-16");
    expect(task.subtasks[0].done).toBe(false);
    expect(task.due).toBeNull();
  });

  it("每周回顾和导出也包含由子任务排到本周的母任务", () => {
    const review = weeklyReview([parent({ subtasks: [step("overdue", "2026-10-12")] })], [], [], TODAY);
    expect(review.stillOpen.map((t) => t.id)).toEqual(["parent"]);
    expect(exportWeekMarkdown(review)).toContain("整理项目（逾期 6 天）");
    expect(review.stillOpen[0].due).toBeNull();
  });

  it("整件事顺延以显示的日期为起点，不会把未来子任务的母任务提前", () => {
    const task = parent({ subtasks: [step("future", "2026-10-20")] });
    put(task);
    postponeRowsTo([{ task, sub: null }], "2026-10-16");
    expect(appStore.getState().data.tasks[0].due).toBeNull();
    postponeRows([{ task, sub: null }], 1);
    expect(appStore.getState().data.tasks[0].due).toBe("2026-10-21");
    expect(appStore.getState().data.tasks[0].subtasks[0].due).toBe("2026-10-20");
    undo();
    postponeTasks([task.id], 1);
    expect(appStore.getState().data.tasks[0].due).toBe("2026-10-21");
  });
});

describe("用户实际看到的母任务安排", () => {
  it("任务卡显示最近子任务和钟点，编辑日期框仍是母任务空白日期", () => {
    const task = parent({ subtasks: [step("next", TODAY, { dueTime: "09:00" })] });
    put(task);
    const host = mount(createElement(TaskCard, { task }));
    const pill = [...host.querySelectorAll<HTMLButtonElement>("button.pill")]
      .find((b) => b.textContent?.includes("最近子任务"))!;
    expect(pill.textContent).toContain("今天 09:00 · 最近子任务");
    act(() => pill.click());
    const date = document.querySelector<HTMLInputElement>('[data-task-popover="parent"] input[type="date"]');
    expect(date).not.toBeNull();
    expect(host.contains(date)).toBe(false);
    expect(date?.value).toBe("");
    expect(appStore.getState().data.tasks[0].due).toBeNull();
  });

  it("整件事清单行在今天分组展示最近步骤日期", () => {
    put(parent());
    const host = mount(createElement(ListView, { kind: "tag" }));
    // 用真实标签列表入口取这件事。
    act(() => appStore.setState((s) => ({
      ui: { ...s.ui, tag: "project" },
      data: { ...s.data, tasks: s.data.tasks.map((t) => ({ ...t, tags: ["project"] })) },
    })));
    expect(host.querySelector(".group-head")?.textContent).toBe("今天");
    expect(host.querySelector(".task-row .meta")?.textContent).toContain("今天");
    expect(host.textContent).not.toContain("未安排");
  });

  it("四象限以最近步骤判断紧急并显示相同日期", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 15, 12));
    put(parent({ priority: 3 }));
    const host = mount(createElement(QuadrantBoard));
    expect(host.querySelector(".quad-iu .quad-title")?.textContent).toBe("整理项目");
    expect(host.querySelector(".quad-iu .quad-due")?.textContent).toBe("今天");
  });

  it("日历把无手排日期的母任务列到最近步骤那天", () => {
    put(parent());
    const host = mount(createElement(Calendar));
    const card = host.querySelector(".cal-task")!;
    expect(card.querySelector(".cal-title")?.textContent).toBe("整理项目");
    expect(card.closest(".cal-cell")?.querySelector(".cal-num")?.textContent).toBe("15");
    expect(host.querySelectorAll(".cal-task")).toHaveLength(1);
  });

  it("搜索最近步骤在今天的无手排日期母任务，点击结果能回到今天", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 15, 12));
    put(parent());
    const host = mount(createElement(SearchOverlay));
    const result = findParent(host);
    expect(result.textContent).toContain("今天");
    act(() => result.click());
    expect(appStore.getState().ui.view).toBe("today");
    expect(appStore.getState().ui.expandedId).toBe("parent");
  });

  it.each([{ done: true }, { deletedAt: STAMP }, { droppedAt: STAMP }])(
    "搜索不因已经收场或删除的步骤跳到空的今天页 %j", (patch) => {
      put(parent({ listId: "work", subtasks: [step("settled", TODAY, patch), step("future", "2026-10-20")] }));
      const result = findParent(mount(createElement(SearchOverlay)));
      act(() => result.click());
      expect(appStore.getState().ui.view).toBe("list");
      expect(appStore.getState().ui.listId).toBe("work");
    },
  );

  it("母任务手排今天但每一步都在未来时，搜索仍回到清单而非空的今天页", () => {
    put(parent({ due: TODAY, listId: "work", subtasks: [step("future", "2026-10-20")] }));
    const result = findParent(mount(createElement(SearchOverlay)));
    act(() => result.click());
    expect(appStore.getState().ui.view).toBe("list");
  });
});
