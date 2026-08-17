// 审查修复的回归测试：提醒复活（高危#1）、专注切换结算、无操作不压撤销栈
import { beforeEach, describe, expect, it } from "vitest";
import { defaultData, newTask } from "../src/core/model";
import { addDays, todayYMD, toLocalDT } from "../src/core/dates";
import {
  appStore, completeTask, postponeTasks, setTasksDue, undo, updateTask,
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
