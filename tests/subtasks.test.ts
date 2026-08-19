// 子任务分拆与继承：用户口径「有子任务的把重要级和截止日期挪到子任务，默认等于母任务，
// 总任务排序时分开排」。这套规则同时管今天 / 计划 / 全部三个视图，改坏了三处一起坏。
import { beforeEach, describe, expect, it } from "vitest";
import type { AppData, Priority, Subtask } from "../src/core/model";
import { defaultData, newTask } from "../src/core/model";
import { addDays, todayYMD } from "../src/core/dates";
import {
  appStore, openRows, postponeRows, rowDue, rowPriority, rowTaskIds, rowTime,
  sortRows, tasksForToday, undo,
} from "../src/core/store";

const today = todayYMD();

function sub(id: string, title: string, patch: Partial<Subtask> = {}): Subtask {
  return { id, title, done: false, due: null, dueTime: null, priority: null, ...patch };
}

function dataOf(...tasks: ReturnType<typeof newTask>[]): AppData {
  return { ...defaultData(), tasks };
}

/** 行的可读标签，断言里比对顺序用 */
const label = (r: { task: { title: string }; sub: Subtask | null }) =>
  r.sub ? `${r.task.title}›${r.sub.title}` : r.task.title;

describe("继承：子任务没单独设的，日期和重要性都跟母任务", () => {
  it("不填日期不填重要性 → 完全等于母任务", () => {
    const t = newTask({
      title: "写周报", due: today, dueTime: "15:00", priority: 2,
      subtasks: [sub("s1", "收集数据")],
    });
    const r = { task: t, sub: t.subtasks[0] };
    expect(rowDue(r)).toBe(today);
    expect(rowTime(r)).toBe("15:00");
    expect(rowPriority(r)).toBe(2);
  });

  it("母任务也没日期 → 子任务行就是「未安排」，不会凭空长出日期", () => {
    const t = newTask({ title: "整理书架", subtasks: [sub("s1", "分类")] });
    expect(rowDue({ task: t, sub: t.subtasks[0] })).toBeNull();
  });

  it("子任务自填日期 → 用自己的；此时不再继承母任务那天的钟点", () => {
    const t = newTask({
      title: "写周报", due: today, dueTime: "15:00", priority: 3,
      subtasks: [sub("s1", "收集数据", { due: addDays(today, 2) })],
    });
    const r = { task: t, sub: t.subtasks[0] };
    expect(rowDue(r)).toBe(addDays(today, 2));
    expect(rowTime(r)).toBeNull();
    expect(rowPriority(r)).toBe(3); // 重要性没单独设，仍然继承
  });

  it("子任务自填日期又自填时间/重要性 → 全用自己的", () => {
    const t = newTask({
      title: "写周报", due: today, dueTime: "15:00", priority: 1,
      subtasks: [sub("s1", "画图", { due: addDays(today, 1), dueTime: "09:30", priority: 3 })],
    });
    const r = { task: t, sub: t.subtasks[0] };
    expect(rowDue(r)).toBe(addDays(today, 1));
    expect(rowTime(r)).toBe("09:30");
    expect(rowPriority(r)).toBe(3);
  });

  it("重要性 0（无）也是有效值，不能被当成「没设」而去继承母任务的高", () => {
    const t = newTask({
      title: "写周报", priority: 3,
      subtasks: [sub("s1", "收尾", { priority: 0 as Priority })],
    });
    expect(rowPriority({ task: t, sub: t.subtasks[0] })).toBe(0);
  });
});

describe("分拆：有未完成子任务的事，母任务行收起，一行一个子任务", () => {
  it("三个未完成子任务 → 三行，且没有母任务那一行", () => {
    const t = newTask({
      title: "写周报", due: today,
      subtasks: [sub("s1", "收集数据"), sub("s2", "画图"), sub("s3", "写正文")],
    });
    const rows = openRows(dataOf(t));
    expect(rows.map(label)).toEqual(["写周报›收集数据", "写周报›画图", "写周报›写正文"]);
  });

  it("做完的子任务不再占行，剩下的还在", () => {
    const t = newTask({
      title: "写周报", due: today,
      subtasks: [sub("s1", "收集数据", { done: true }), sub("s2", "画图")],
    });
    expect(openRows(dataOf(t)).map(label)).toEqual(["写周报›画图"]);
  });

  it("子任务全做完 → 母任务行回来收尾", () => {
    const t = newTask({
      title: "写周报", due: today,
      subtasks: [sub("s1", "收集数据", { done: true }), sub("s2", "画图", { done: true })],
    });
    expect(openRows(dataOf(t)).map(label)).toEqual(["写周报"]);
  });

  it("没有子任务的事照旧一行", () => {
    const t = newTask({ title: "交电费", due: today });
    expect(openRows(dataOf(t)).map(label)).toEqual(["交电费"]);
  });

  it("已完成 / 已删除的母任务一行都不占", () => {
    const done = newTask({ title: "已完成", due: today, done: true, subtasks: [sub("s1", "子")] });
    const gone = newTask({ title: "已删", due: today, deletedAt: new Date().toISOString(), subtasks: [sub("s2", "子")] });
    expect(openRows(dataOf(done, gone))).toEqual([]);
  });
});

describe("总任务排序：分拆出来的子任务各排各的", () => {
  it("按时间：同一件事的子任务按各自日期散开，中间可以插进别的任务", () => {
    const big = newTask({
      title: "写周报", due: addDays(today, 5), order: 0,
      subtasks: [
        sub("s1", "收集数据", { due: addDays(today, 1) }),
        sub("s2", "画图", { due: addDays(today, 3) }),
      ],
    });
    const other = newTask({ title: "交电费", due: addDays(today, 2), order: 1 });
    const rows = sortRows(openRows(dataOf(big, other)), "time");
    expect(rows.map(label)).toEqual(["写周报›收集数据", "交电费", "写周报›画图"]);
  });

  it("按重要性：子任务自己的重要性说了算，压过母任务的", () => {
    const big = newTask({
      title: "写周报", due: today, priority: 1, order: 0,
      subtasks: [sub("s1", "收集数据", { priority: 1 }), sub("s2", "画图", { priority: 3 })],
    });
    const other = newTask({ title: "交电费", due: today, priority: 2, order: 1 });
    const rows = sortRows(openRows(dataOf(big, other)), "priority");
    expect(rows.map(label)).toEqual(["写周报›画图", "交电费", "写周报›收集数据"]);
  });

  it("继承日期的子任务跟母任务同一天，排在一起且保持任务里的先后", () => {
    const big = newTask({
      title: "写周报", due: addDays(today, 1), order: 0,
      subtasks: [sub("s1", "第一步"), sub("s2", "第二步"), sub("s3", "第三步")],
    });
    const rows = sortRows(openRows(dataOf(big)), "time");
    expect(rows.map(label)).toEqual(["写周报›第一步", "写周报›第二步", "写周报›第三步"]);
  });

  it("没日期的行（含继承来的空日期）一律排最后", () => {
    const nodate = newTask({ title: "有空再说", order: 0, subtasks: [sub("s1", "想想")] });
    const dated = newTask({ title: "交电费", due: addDays(today, 9), order: 1 });
    expect(sortRows(openRows(dataOf(nodate, dated)), "time").map(label)).toEqual([
      "交电费", "有空再说›想想",
    ]);
  });
});

describe("今天视图：继承日期的子任务照样按时到场", () => {
  it("母任务今天到期、子任务没自己的日期 → 子任务行进「今天」，母任务行不出现", () => {
    const t = newTask({ title: "写周报", due: today, subtasks: [sub("s1", "收集数据"), sub("s2", "画图")] });
    const { todays, overdue } = tasksForToday(dataOf(t), today);
    expect(overdue).toEqual([]);
    expect(todays.map(label)).toEqual(["写周报›收集数据", "写周报›画图"]);
  });

  it("母任务逾期 → 继承的子任务行也跟着进逾期区", () => {
    const t = newTask({ title: "写周报", due: addDays(today, -2), subtasks: [sub("s1", "收集数据")] });
    const { overdue } = tasksForToday(dataOf(t), today);
    expect(overdue.map(label)).toEqual(["写周报›收集数据"]);
  });

  it("子任务把自己排到了明天 → 今天就看不到它", () => {
    const t = newTask({
      title: "写周报", due: today,
      subtasks: [sub("s1", "收集数据"), sub("s2", "画图", { due: addDays(today, 1) })],
    });
    const { todays } = tasksForToday(dataOf(t), today);
    expect(todays.map(label)).toEqual(["写周报›收集数据"]);
  });
});

describe("rowTaskIds：分拆后按「件」去重", () => {
  it("一件事占三行只算一件，顺序按首次出现", () => {
    const big = newTask({ title: "写周报", due: today, order: 0, subtasks: [sub("s1", "a"), sub("s2", "b")] });
    const other = newTask({ title: "交电费", due: today, order: 1 });
    const rows = sortRows(openRows(dataOf(big, other)), "time");
    expect(rowTaskIds(rows)).toEqual([big.id, other.id]);
  });
});

describe("顺延：子任务行只推自己那一条", () => {
  function reset(tasks: ReturnType<typeof newTask>[]) {
    localStorage.clear();
    const data = dataOf(...tasks);
    appStore.setState({ data, loaded: true, loadError: null, undoDepth: 0 });
    for (let i = 0; i < 60; i++) undo();
    appStore.setState({ data, loaded: true, loadError: null });
  }
  const getTask = (id: string) => appStore.getState().data.tasks.find((t) => t.id === id)!;

  beforeEach(() => localStorage.clear());

  it("推一条继承日期的子任务 → 它落成自己的日期，母任务和兄弟子任务纹丝不动", () => {
    const t = newTask({
      title: "写周报", due: addDays(today, -1), dueTime: "15:00",
      subtasks: [sub("s1", "收集数据"), sub("s2", "画图")],
    });
    reset([t]);
    postponeRows([{ task: t, sub: t.subtasks[0] }]);
    const after = getTask(t.id);
    expect(after.due).toBe(addDays(today, -1)); // 母任务没被连累
    expect(after.subtasks[0].due).toBe(addDays(today, 1)); // 逾期的从今天起推明天
    expect(after.subtasks[0].dueTime).toBe("15:00"); // 继承来的钟点一起落下来
    expect(after.subtasks[1].due).toBeNull(); // 兄弟还继承着
  });

  it("逾期区「全部推到明天」：几条子任务行一起推，各自落到明天", () => {
    const t = newTask({
      title: "写周报", due: addDays(today, -3),
      subtasks: [sub("s1", "收集数据"), sub("s2", "画图", { due: addDays(today, -1) })],
    });
    reset([t]);
    postponeRows([
      { task: t, sub: t.subtasks[0] },
      { task: t, sub: t.subtasks[1] },
    ]);
    const after = getTask(t.id);
    expect(after.subtasks[0].due).toBe(addDays(today, 1));
    expect(after.subtasks[1].due).toBe(addDays(today, 1));
    expect(after.postponeCount).toBe(0); // 顺延次数是任务级的，推子任务不该记在母任务头上
  });

  it("排在未来的子任务从它自己那天往后推，不是从今天推", () => {
    const t = newTask({
      title: "写周报", due: today,
      subtasks: [sub("s1", "收集数据", { due: addDays(today, 5) })],
    });
    reset([t]);
    postponeRows([{ task: t, sub: t.subtasks[0] }]);
    expect(getTask(t.id).subtasks[0].due).toBe(addDays(today, 6));
  });
});
