// 子任务分拆与继承：用户口径「有子任务的把重要级和截止日期挪到子任务，默认等于母任务，
// 总任务排序时分开排」。这套规则同时管今天 / 计划 / 全部三个视图，改坏了三处一起坏。
// 另外这里也管任务卡里那两堆的分法（splitSubtasks / foldDoneSubs）：做完的排在后面、多了默认收起。
import { beforeEach, describe, expect, it } from "vitest";
import type { AppData, Priority, Subtask } from "../src/core/model";
import { defaultData, newTask } from "../src/core/model";
import { addDays, todayYMD, toYMD } from "../src/core/dates";
import {
  appStore, doneRows, foldDoneSubs, openRows, postponeRows, rowDoneAt, rowDoneDay, rowDoneGuessed,
  rowDue, rowPriority, rowTaskIds, rowTime, sortRows, splitSubtasks, SUB_DONE_PEEK, tasksForToday,
  undo,
} from "../src/core/store";

const today = todayYMD();

function sub(id: string, title: string, patch: Partial<Subtask> = {}): Subtask {
  return { id, title, done: false, due: null, dueTime: null, priority: null, doneAt: null, ...patch };
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

describe("任务卡分堆：没做完的在上，做完的收在下面", () => {
  const subs = [
    sub("s1", "收集数据", { done: true }),
    sub("s2", "画趋势图"),
    sub("s3", "对数", { done: true }),
    sub("s4", "写结论"),
  ];

  it("两堆内部都保持原数组顺序，谁也不会自己动", () => {
    const { open, done } = splitSubtasks(subs);
    expect(open.map((s) => s.id)).toEqual(["s2", "s4"]);
    expect(done.map((s) => s.id)).toEqual(["s1", "s3"]);
  });

  it("两堆接起来 = 原来「做完的沉到最下面」那个稳定排序，一条不多一条不少", () => {
    const { open, done } = splitSubtasks(subs);
    const idx = new Map(subs.map((s, i) => [s.id, i]));
    const old = [...subs].sort(
      (a, b) => Number(a.done) - Number(b.done) || idx.get(a.id)! - idx.get(b.id)!,
    );
    expect([...open, ...done].map((s) => s.id)).toEqual(old.map((s) => s.id));
  });

  it("没有子任务时两堆都是空的", () => {
    expect(splitSubtasks([])).toEqual({ open: [], done: [] });
  });

  it("原数组不被改动", () => {
    const input = [...subs];
    splitSubtasks(input);
    expect(input.map((s) => s.id)).toEqual(["s1", "s2", "s3", "s4"]);
  });
});

describe("任务卡折叠：做完的攒够 3 条才默认收起", () => {
  const done = (n: number) =>
    Array.from({ length: n }, (_, i) => sub(`d${i}`, `做完的${i}`, { done: true }));

  it("阈值就是 3", () => {
    expect(SUB_DONE_PEEK).toBe(3);
  });

  it("差一条不收（2 条已完成 + 还有没做的）", () => {
    expect(foldDoneSubs([...done(SUB_DONE_PEEK - 1), sub("o1", "还欠着")])).toBe(false);
  });

  it("刚好够数就收", () => {
    expect(foldDoneSubs([...done(SUB_DONE_PEEK), sub("o1", "还欠着")])).toBe(true);
  });

  it("再多也收", () => {
    expect(foldDoneSubs([...done(SUB_DONE_PEEK + 5), sub("o1", "还欠着")])).toBe(true);
  });

  it("全部做完就不收——不然「已完成」视图里点开卡片一条子任务都看不见", () => {
    expect(foldDoneSubs(done(SUB_DONE_PEEK + 3))).toBe(false);
  });

  it("一条子任务都没有，谈不上收起", () => {
    expect(foldDoneSubs([])).toBe(false);
  });

  it("一条都没做完，也没什么可收的", () => {
    expect(foldDoneSubs([sub("o1", "甲"), sub("o2", "乙"), sub("o3", "丙")])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 「已完成」按行列（2026-08-31）。openRows 的对偶：做完的子任务各占一行，
// 母任务勾掉了也占一行。完成日只有 rowDoneAt / rowDoneDay 这一个口径，
// 「已完成」视图和日历的已完成桶都从这儿取，不许各写一遍。
// ---------------------------------------------------------------------------

describe("doneRows：做完的事怎么占行", () => {
  it("母任务还欠着，做完的子任务照样各出一行——不用等整件事做完", () => {
    const t = newTask({
      title: "装修",
      subtasks: [sub("s1", "量尺寸", { done: true }), sub("s2", "选瓷砖"), sub("s3", "订货", { done: true })],
    });
    expect(doneRows(dataOf(t)).map(label)).toEqual(["装修›量尺寸", "装修›订货"]);
  });

  it("母任务勾掉了就多出一行——那一行代表「这件事本身收尾了」", () => {
    const t = newTask({
      title: "装修", done: true, doneAt: "2026-08-20T02:00:00.000Z",
      subtasks: [sub("s1", "量尺寸", { done: true })],
    });
    expect(doneRows(dataOf(t)).map(label)).toEqual(["装修›量尺寸", "装修"]);
  });

  it("没有子任务的事做完了就一行", () => {
    expect(doneRows(dataOf(newTask({ title: "交税", done: true }))).map(label)).toEqual(["交税"]);
  });

  it("一条都没做完的事一行都不出", () => {
    const t = newTask({ title: "装修", subtasks: [sub("s1", "量尺寸")] });
    expect(doneRows(dataOf(t))).toEqual([]);
  });

  it("回收站里的和习惯都不进来（跟 openRows 同一道门 aliveTasks）", () => {
    const trashed = newTask({ title: "删掉的", done: true, deletedAt: "2026-08-20T00:00:00.000Z" });
    const habit = newTask({ title: "喝水", kind: "habit", done: true });
    expect(doneRows(dataOf(trashed, habit))).toEqual([]);
  });

  it("按「件」去重后就是几件事——连选和计数都按件走", () => {
    const t = newTask({
      title: "装修", done: true,
      subtasks: [sub("s1", "量尺寸", { done: true }), sub("s2", "订货", { done: true })],
    });
    const rows = doneRows(dataOf(t, newTask({ title: "交税", done: true })));
    expect(rows).toHaveLength(4);
    expect(rowTaskIds(rows)).toHaveLength(2);
  });
});

describe("完成日：一个口径，全应用共用", () => {
  it("子任务有自己的完成时刻就用自己的", () => {
    const t = newTask({
      title: "装修", done: true, doneAt: "2026-08-25T02:00:00.000Z",
      subtasks: [sub("s1", "量尺寸", { done: true, doneAt: "2026-08-20T02:00:00.000Z" })],
    });
    expect(rowDoneAt({ task: t, sub: t.subtasks[0] })).toBe("2026-08-20T02:00:00.000Z");
  });

  it("老子任务没有完成时刻 → 回落到母任务的（不单开「不知道哪天」那一组）", () => {
    const t = newTask({
      title: "装修", done: true, doneAt: "2026-08-25T02:00:00.000Z",
      subtasks: [sub("s1", "量尺寸", { done: true })],
    });
    expect(rowDoneAt({ task: t, sub: t.subtasks[0] })).toBe("2026-08-25T02:00:00.000Z");
  });

  it("母任务也没完成时刻 → 再回落到创建时刻，绝不让它从所有视图里消失", () => {
    const t = newTask({
      title: "装修", createdAt: "2026-01-02T00:00:00.000Z",
      subtasks: [sub("s1", "量尺寸", { done: true })],
    });
    expect(rowDoneAt({ task: t, sub: t.subtasks[0] })).toBe("2026-01-02T00:00:00.000Z");
    expect(rowDoneAt({ task: t, sub: null })).toBe("2026-01-02T00:00:00.000Z");
  });

  it("归日转本地时区：凌晨做完的算今天，不能被 UTC 拖回昨天", () => {
    // 本地时间「今天 00:30」——直接写 UTC 字面量的话，测试换个时区就自己坏了
    const [y, m, dd] = today.split("-").map(Number);
    const at = new Date(y, m - 1, dd, 0, 30).toISOString();
    const t = newTask({ title: "赶稿", done: true, doneAt: at });
    expect(rowDoneDay({ task: t, sub: null })).toBe(today);
  });

  it("同一件事在两个视图里落同一天：日历和已完成走的是同一个函数", () => {
    const t = newTask({
      title: "装修", subtasks: [sub("s1", "量尺寸", { done: true, doneAt: "2026-08-20T12:00:00.000Z" })],
    });
    const row = doneRows(dataOf(t))[0];
    expect(rowDoneDay(row)).toBe(toYMD(new Date(rowDoneAt(row))));
  });
});

// 回落到创建时刻那一档纯粹是「排序总得有个位置」，不是真的完成时刻。
// 日历要是照着它落格，用户会在什么都没做完的那天看见一条 ✓ ——凭空捏造的完成记录。
describe("完成日是不是猜的：猜出来的日子不许当成完成记录", () => {
  it("子任务有自己的戳 → 不是猜的", () => {
    const t = newTask({
      title: "装修",
      subtasks: [sub("s1", "量尺寸", { done: true, doneAt: "2026-08-20T02:00:00.000Z" })],
    });
    expect(rowDoneGuessed({ task: t, sub: t.subtasks[0] })).toBe(false);
  });

  it("子任务没戳但母任务做完了 → 不是猜的（跟着母任务那天走，有据可依）", () => {
    const t = newTask({
      title: "装修", done: true, doneAt: "2026-08-25T02:00:00.000Z",
      subtasks: [sub("s1", "量尺寸", { done: true })],
    });
    expect(rowDoneGuessed({ task: t, sub: t.subtasks[0] })).toBe(false);
  });

  it("**两边都没戳 → 就是猜的**：这类行不进日历", () => {
    const t = newTask({
      title: "装修", createdAt: "2026-01-02T00:00:00.000Z",
      subtasks: [sub("s1", "量尺寸", { done: true })],
    });
    expect(rowDoneGuessed({ task: t, sub: t.subtasks[0] })).toBe(true);
    // 但它照样出行——「已完成」视图还得列出来，只是不写日期
    expect(doneRows(dataOf(t))).toHaveLength(1);
  });

  it("母任务行永远不算猜的（doneRows 只在 done=true 时才推母任务行）", () => {
    const t = newTask({ title: "交税", done: true, doneAt: "2026-08-25T02:00:00.000Z" });
    expect(rowDoneGuessed({ task: t, sub: null })).toBe(false);
  });
});
