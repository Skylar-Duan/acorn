// 审查修复的回归测试：提醒复活、专注切换结算、无操作不压撤销栈、
// v1.1 复审修复（子任务行顺延 / 清日期连带清时间 / 循环补追赶）
import { beforeEach, describe, expect, it } from "vitest";
import { defaultData, newTask } from "../src/core/model";
import { addDays, todayYMD, toLocalDT } from "../src/core/dates";
import {
  appStore, completeTask, postponeRows, postponeTasks, setTasksDue, undo, updateTask,
} from "../src/core/store";

function reset(tasks: ReturnType<typeof newTask>[] = []) {
  localStorage.clear();
  const data = defaultData();
  data.tasks = tasks;
  appStore.setState({ data, loaded: true, loadError: null, undoDepth: 0 });
  // 弹空遗留撤销栈
  for (let i = 0; i < 60; i++) undo();
  appStore.setState({ data, loaded: true, loadError: null });
}

describe("提醒在日期推进时按 dueTime 复活（先响后完成的常规顺序）", () => {
  const today = todayYMD();

  it("循环任务：提醒已被消费成 null，完成后新落点带回提醒", () => {
    const t = newTask({
      title: "每天9点站会",
      due: today,
      dueTime: "09:00",
      reminder: null, // 已响过，被 sweep 清空
      repeat: { kind: "daily", every: 1 },
    });
    reset([t]);
    completeTask(t.id);
    const advanced = appStore.getState().data.tasks.find((x) => x.id === t.id)!;
    expect(advanced.due).toBe(addDays(today, 1));
    expect(advanced.reminder).toBe(toLocalDT(addDays(today, 1), "09:00"));
  });

  it("逾期任务推到明天：带 dueTime 的重新有提醒", () => {
    const t = newTask({ title: "回邮件", due: addDays(today, -1), dueTime: "15:00", reminder: null });
    reset([t]);
    postponeTasks([t.id]);
    const after = appStore.getState().data.tasks.find((x) => x.id === t.id)!;
    expect(after.due).toBe(addDays(today, 1));
    expect(after.reminder).toBe(toLocalDT(addDays(today, 1), "15:00"));
  });

  it("拖拽改期（setTasksDue）同样复活提醒", () => {
    const t = newTask({ title: "备课", due: today, dueTime: "20:00", reminder: null });
    reset([t]);
    setTasksDue([t.id], addDays(today, 3));
    const after = appStore.getState().data.tasks.find((x) => x.id === t.id)!;
    expect(after.reminder).toBe(toLocalDT(addDays(today, 3), "20:00"));
  });

  it("没有 dueTime 的任务改期不会凭空长出提醒", () => {
    const t = newTask({ title: "散步", due: today, reminder: null });
    reset([t]);
    setTasksDue([t.id], addDays(today, 1));
    expect(appStore.getState().data.tasks.find((x) => x.id === t.id)!.reminder).toBeNull();
  });

  it("清掉 dueTime 时挂在上面的提醒一并清除", () => {
    const t = newTask({ title: "开会", due: today, dueTime: "14:00", reminder: toLocalDT(today, "14:00") });
    reset([t]);
    updateTask(t.id, { dueTime: null });
    expect(appStore.getState().data.tasks.find((x) => x.id === t.id)!.reminder).toBeNull();
  });
});

describe("撤销不复活已消费的过期提醒", () => {
  it("快照里的过期提醒在 undo 后保持 null", () => {
    const today = todayYMD();
    const past = toLocalDT(today, "00:01");
    const t = newTask({ title: "早课", due: today, dueTime: "00:01", reminder: past });
    reset([t]);
    updateTask(t.id, { title: "早课改名" }); // 压快照（快照里 reminder=past）
    // 模拟 sweep 消费提醒
    const s = appStore.getState();
    appStore.setState({
      data: { ...s.data, tasks: s.data.tasks.map((x) => (x.id === t.id ? { ...x, reminder: null } : x)) },
    });
    undo(); // 撤销改名
    const after = appStore.getState().data.tasks.find((x) => x.id === t.id)!;
    expect(after.title).toBe("早课");
    expect(after.reminder).toBeNull(); // 不因撤销而再次轰炸
  });
});

describe("无操作不压撤销栈", () => {
  it("对已完成任务再次 completeTask 不产生空撤销步", () => {
    const t = newTask({ title: "x", done: true, doneAt: new Date().toISOString() });
    reset([t]);
    const before = appStore.getState().undoDepth;
    completeTask(t.id);
    expect(appStore.getState().undoDepth).toBe(before);
  });
});

describe("v1.1 复审修复", () => {
  const today = todayYMD();

  it("postponeRows：子任务行推子任务日期，母任务原地不动", () => {
    const t = newTask({
      title: "母",
      due: addDays(today, 5),
      subtasks: [{ id: "s1", title: "子", done: false, due: addDays(today, -1), dueTime: null, priority: null }],
    });
    reset([t]);
    postponeRows([{ task: t, sub: t.subtasks[0] }]);
    const after = appStore.getState().data.tasks.find((x) => x.id === t.id)!;
    expect(after.due).toBe(addDays(today, 5)); // 母任务没被误推
    expect(after.postponeCount).toBe(0);
    expect(after.subtasks[0].due).toBe(addDays(today, 1)); // 逾期子任务从今天起推明天
  });

  it("postponeRows：母行与子行混合各推各的", () => {
    const t = newTask({
      title: "母逾期",
      due: addDays(today, -2),
      subtasks: [{ id: "s1", title: "子", done: false, due: addDays(today, -1), dueTime: null, priority: null }],
    });
    reset([t]);
    postponeRows([{ task: t, sub: null }, { task: t, sub: t.subtasks[0] }]);
    const after = appStore.getState().data.tasks.find((x) => x.id === t.id)!;
    expect(after.due).toBe(addDays(today, 1));
    expect(after.subtasks[0].due).toBe(addDays(today, 1));
  });

  it("setTasksDue(null) 连带清 dueTime，重新排期不复活幻影提醒", () => {
    const t = newTask({ title: "x", due: today, dueTime: "09:00", reminder: null });
    reset([t]);
    setTasksDue([t.id], null);
    let after = appStore.getState().data.tasks.find((x) => x.id === t.id)!;
    expect(after.dueTime).toBeNull();
    setTasksDue([t.id], addDays(today, 1));
    after = appStore.getState().data.tasks.find((x) => x.id === t.id)!;
    expect(after.reminder).toBeNull(); // 没有残留时间 → 不再凭空长提醒
  });

  it("严重逾期的每日循环任务完成后直接追到明天，不再逐天爬行", () => {
    const t = newTask({
      title: "每日站会",
      due: addDays(today, -10),
      dueTime: "09:00",
      repeat: { kind: "daily", every: 1 },
    });
    reset([t]);
    completeTask(t.id);
    const after = appStore.getState().data.tasks.find((x) => x.id === t.id)!;
    expect(after.due).toBe(addDays(today, 1)); // 锚点取今天
    expect(after.reminder).toBe(toLocalDT(addDays(today, 1), "09:00")); // 提醒在未来，不会立刻响
  });
});
