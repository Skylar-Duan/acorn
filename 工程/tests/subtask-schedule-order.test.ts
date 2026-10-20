import { describe, expect, it } from "vitest";
import { defaultData, newTask, type Priority, type Subtask } from "../src/core/model";
import { planGroups } from "../src/core/plan";
import { comparePendingSchedule, pendingTimeKey } from "../src/core/pendingOrder";
import { repeatingRows } from "../src/core/repeating";
import { openRows, rowPriority, rowTime, sortRows, splitSubtasks, tasksForToday } from "../src/core/store";

const day = "2026-10-20";
const sub = (id: string, patch: Partial<Subtask> = {}): Subtask => ({ id, title: id, done: false, ...patch });
const ids = (items: Subtask[]) => items.map((s) => s.id);

describe("待办子任务时间主、重要性次", () => {
  it("日期和钟点先于高优先级，同一时刻才按有效重要性降序，同键稳定", () => {
    const task = newTask({ title: "演示母任务", due: day, dueTime: "10:00", priority: 2, subtasks: [
      sub("later-high", { due: "2026-10-21", dueTime: "09:00", priority: 3 }),
      sub("same-low", { due: day, dueTime: "10:00", priority: 1 }),
      sub("same-inherit"), sub("same-high", { due: day, dueTime: "10:00", priority: 3 }),
      sub("same-equal", { due: day, dueTime: "10:00", priority: 2 }),
      sub("early-none", { due: day, dueTime: "09:00", priority: 0 }),
      sub("day-no-time", { due: day, priority: 3 }),
    ] });
    const before = JSON.stringify(task);
    const expected = ["early-none", "same-high", "same-inherit", "same-equal", "same-low", "day-no-time", "later-high"];
    expect(ids(splitSubtasks(task.subtasks, task).open)).toEqual(expected);
    const rows = openRows({ ...defaultData(), tasks: [task] });
    expect(sortRows(rows, "time").map((r) => r.sub!.id)).toEqual(expected);
    expect(JSON.stringify(task)).toBe(before);
  });

  it("未安排日期沉底，残留钟点不伪造时间；无日期同键仍按优先级并保持同级原序", () => {
    const task = newTask({ title: "无日期母任务", priority: 1, subtasks: [
      sub("undated-low", { dueTime: "01:00", priority: 0 }),
      sub("undated-high", { dueTime: "22:00", priority: 3 }), sub("undated-equal", { priority: 3 }),
      sub("dated", { due: "2999-12-31", priority: 0 }), sub("undated-inherit"),
    ] });
    expect(ids(splitSubtasks(task.subtasks, task).open)).toEqual(["dated", "undated-high", "undated-equal", "undated-inherit", "undated-low"]);
    expect(pendingTimeKey(null, "01:00")).toBe(pendingTimeKey(null, "22:00"));
  });

  it("自身日期不借母钟点，显式0不误继承；母重要性改变后可重新排序", () => {
    const task = newTask({ title: "继承", due: day, dueTime: "09:00", priority: 1, subtasks: [
      sub("own-medium", { dueTime: "09:00", priority: 2 }), sub("inherit"), sub("explicit-zero", { priority: 0 }),
      sub("own-date-no-time", { due: day, priority: 3 }),
    ] });
    expect(ids(splitSubtasks(task.subtasks, task).open)).toEqual(["own-medium", "inherit", "explicit-zero", "own-date-no-time"]);
    expect(ids(splitSubtasks(task.subtasks, { ...task, priority: 3 }).open)).toEqual(["inherit", "own-medium", "explicit-zero", "own-date-no-time"]);
    expect(rowPriority({ task, sub: task.subtasks[2] })).toBe(0);
    expect(rowTime({ task, sub: task.subtasks[3] })).toBeNull();
  });

  it("已完成保持最新doneAt在上，不用优先级和截止时间重排；未知戳稳定置后", () => {
    const subs = [sub("unknown-a", { done: true }), sub("old-high", { done: true, doneAt: "2026-10-19T12:00:00Z", priority: 3 }),
      sub("new-none", { done: true, doneAt: "2026-10-20T12:00:00Z", priority: 0 }), sub("unknown-b", { done: true, doneAt: "bad" }),
      sub("deleted", { done: true, doneAt: "2026-10-21T12:00:00Z", deletedAt: "x" })];
    expect(ids(splitSubtasks(subs, { due: day, dueTime: "10:00", priority: 3 }).done)).toEqual(["new-none", "old-high", "unknown-a", "unknown-b"]);
  });

  it("计划时间分组与今日子清单均采用同一时间主排序，组内不漏继承项", () => {
    const task = newTask({ title: "时间分组", due: day, dueTime: "10:00", priority: 2, subtasks: [
      sub("low", { priority: 1 }), sub("high", { priority: 3 }), sub("early", { dueTime: "09:00", priority: 0 }),
      sub("tomorrow", { due: "2026-10-21", dueTime: "09:00", priority: 3 }),
    ] });
    const data = { ...defaultData(), tasks: [task] };
    const groups = planGroups(openRows(data), "time", day);
    expect(groups.find((g) => g.key === "today")!.rows.map((r) => r.sub!.id)).toEqual(["early", "high", "low"]);
    expect(groups.flatMap((g) => g.rows).map((r) => r.sub!.id)).toHaveLength(4);
    expect(tasksForToday(data, day).todays.map((r) => r.sub!.id)).toEqual(["early", "high", "low"]);
  });

  it("跨母任务原手排order和priority模式保持既有行为，同母完全同键保留原序", () => {
    const first = newTask({ title: "first", due: day, priority: 1, order: 3 });
    const second = newTask({ title: "second", due: day, priority: 1, order: 1 });
    expect(sortRows([{ task: first, sub: null }, { task: second, sub: null }], "time").map((r) => r.task.title)).toEqual(["second", "first"]);
    const task = newTask({ title: "same", subtasks: [sub("a"), sub("b")] });
    expect(sortRows(openRows({ ...defaultData(), tasks: [task] }), "time").map((r) => r.sub!.id)).toEqual(["a", "b"]);
    expect(comparePendingSchedule({ due: day, time: "10:00", priority: 1 as Priority }, { due: day, time: "10:00", priority: 1 as Priority })).toBe(0);
  });

  it("重复计划的子步骤不漏，同刻按优先级，完全同键不再按标题跳位", () => {
    const repeat = { kind: "daily", every: 1 } as const;
    const task = newTask({ title: "循环母", due: day, dueTime: "10:00", priority: 1, subtasks: [
      sub("乙同级原先", { repeat, priority: 2 }), sub("甲同级原后", { repeat, priority: 2 }),
      sub("高", { repeat, priority: 3 }), sub("早", { repeat, dueTime: "09:00", priority: 0 }),
      sub("非循环"), sub("已完成", { repeat, done: true }),
    ] });
    expect(repeatingRows({ tasks: [task] }).map((r) => r.sub!.id)).toEqual(["早", "高", "乙同级原先", "甲同级原后"]);
  });
});
