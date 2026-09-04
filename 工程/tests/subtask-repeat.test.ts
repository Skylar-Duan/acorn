// 子任务自己的循环（v8，2026-09-04 PM 原话：「每周末」在子任务里认循环）。
//
// 以前 SUBTASK_SKIP 里带着 "repeat"，于是在子任务输入框里打「每周末 大扫除」是双重损失：
// 既没循环，「每」还被 parseSubtaskInput 那句清理正则吃掉，只剩一个一次性的周末。
// 这一版让子任务照抄整件事那套，但**有一处故意不同**：
//   · 解析——所有循环词一视同仁（每天 / 每周一三五 / 每周末 / 每月5号 / 每个工作日 / 每2天）；
//     没写日期时 due 落在第一个落点（跟整件事共用 parseQuickAdd 里那句 firstOccurrence）
//   · 行为——勾完成 / 放弃一条带循环且有 due 的子任务 = 推到下一个落点、**仍然未完成**；
//     锚点 max(旧 due, 今天)，逾期的能追上来
//   · ⚠️ **不留已完成副本**（整件事会留一条）。子任务的历史堆在母任务卡片里，
//     一条每周重复的子任务一年 52 行，卡片当场没法看——这是取舍不是遗漏
//   · 没有 due 的带循环子任务：没锚点可推，勾完成就正常标完成，不抛错
// 样式只能用 node:fs 读：vitest 默认不处理 CSS，`import x from "a.css?raw"` 读回来是空串。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import taskCardSource from "../src/components/TaskCard.tsx?raw";
import taskSheetSource from "../src/mobile/TaskSheet.tsx?raw";
import type { Subtask } from "../src/core/model";
import { defaultData } from "../src/core/model";
import { parseSubtaskInput, SUBTASK_SKIP } from "../src/core/parse";
import { addDays, dayOfWeek, formatShort, todayYMD } from "../src/core/dates";
import { describeRepeat, firstOccurrence } from "../src/core/recur";
import {
  addSubtask, addTask, advanceSub, appStore, completeTask, dropSubtask, flushSave,
  splitSubtasks, toggleSubtask, undo, updateSubtask,
} from "../src/core/store";

const read = (p: string) => readFileSync(p, "utf8");
const appCss = read("src/styles/app.css");
const mobileSheetCss = read("src/styles/mobile-sheet.css");

const today = todayYMD();

// 2026-08-17 是周一，跟 trash-subinput.test.ts 用的是同一天
const MON = new Date("2026-08-17T09:00:00");
// 2026-08-21 是周五，跟 parse-phrases.test.ts 里那组「每周末」用的是同一天
const FRI = new Date("2026-08-21T09:00:00");

const getTask = (id: string) => {
  const t = appStore.getState().data.tasks.find((x) => x.id === id);
  if (!t) throw new Error(`task ${id} not found`);
  return t;
};
const onlySub = (id: string): Subtask => getTask(id).subtasks[0];

beforeEach(async () => {
  vi.useRealTimers();
  while (appStore.getState().undoDepth > 0) undo();
  await flushSave();
  localStorage.clear();
  appStore.setState({
    data: defaultData(), loaded: true, loadError: null, dataFromNewer: null, undoDepth: 0,
    ui: { ...appStore.getState().ui, toast: null },
  });
});

/** 一件事 + 一条带循环的子任务，返回 [任务 id, 子任务 id] */
function withRepeatingSub(patch: Partial<Subtask>): [string, string] {
  const id = addTask({ title: "装修" });
  addSubtask(id, "大扫除", {
    due: patch.due ?? today,
    repeat: patch.repeat ?? { kind: "daily", every: 1 },
  });
  const s = onlySub(id);
  if (patch.done || patch.droppedAt) {
    appStore.setState((st) => ({
      data: {
        ...st.data,
        tasks: st.data.tasks.map((t) =>
          t.id === id ? { ...t, subtasks: [{ ...t.subtasks[0], ...patch }] } : t,
        ),
      },
    }));
  }
  return [id, s.id];
}

// ---------- 1. 解析 ----------

describe("解析：子任务里所有循环词都认", () => {
  const p = (s: string, now = MON, weekend?: "sat" | "sun") => parseSubtaskInput(s, now, [], weekend);

  it("每周末 大扫除 → 每周日重复，首个落点是本周日，标题干净", () => {
    const r = p("每周末 大扫除", FRI);
    expect(r.repeat).toEqual({ kind: "weekly", days: [0] });
    expect(r.due).toBe("2026-08-23");
    expect(r.title).toBe("大扫除");
  });

  it("weekendDay 设成周六：「每周末」跟着变成每周六，落点提前到 22 号", () => {
    const r = p("每周末 大扫除", FRI, "sat");
    expect(r.repeat).toEqual({ kind: "weekly", days: [6] });
    expect(r.due).toBe("2026-08-22");
    expect(r.title).toBe("大扫除");
  });

  it("每天 / 每2天 / 每周一三五 / 每月5号 / 每个工作日 都认，标题都清干净", () => {
    expect(p("每天 记录体重").repeat).toEqual({ kind: "daily", every: 1 });
    expect(p("每天 记录体重").title).toBe("记录体重");
    expect(p("每2天 浇花").repeat).toEqual({ kind: "daily", every: 2 });
    expect(p("每2天 浇花").title).toBe("浇花");
    expect(p("每周一三五 跑步").repeat).toEqual({ kind: "weekly", days: [1, 3, 5] });
    expect(p("每周一三五 跑步").title).toBe("跑步");
    expect(p("每月5号 交房租").repeat).toEqual({ kind: "monthly", day: 5 });
    expect(p("每月5号 交房租").title).toBe("交房租");
    expect(p("每个工作日 站会").repeat).toEqual({ kind: "workday" });
    expect(p("每个工作日 站会").title).toBe("站会");
  });

  it("循环词没带日期：due 落在第一个落点，跟整件事同一条路（firstOccurrence）", () => {
    // 8-17 本身是周一，「每周一」的第一个落点含今天
    expect(p("每周一 交周报").due).toBe("2026-08-17");
    // 每天：今天就是落点
    expect(p("每天 记录体重").due).toBe("2026-08-17");
    // 每月5号：这个月 5 号已经过了，落到下个月
    expect(p("每月5号 交房租").due).toBe("2026-09-05");
    // 每个工作日：周一本身就是工作日
    expect(p("每个工作日 站会").due).toBe("2026-08-17");
    // 一条有循环、没日期的子任务永远推不动，所以这一条不许回到 null
    expect(p("每周一 交周报").due).not.toBeNull();
  });

  it("句子里另写了日期：日期说了算，循环照旧带着", () => {
    const r = p("每周一 交周报 后天");
    expect(r.repeat).toEqual({ kind: "weekly", days: [1] });
    expect(r.due).toBe("2026-08-19");
    expect(r.title).toBe("交周报");
  });

  it("清单 / 标签 / 需求方仍然不认，原文照留在标题里", () => {
    const r = p("每天 发给 @李哥 的 #材料 /工作");
    expect(r.repeat).toEqual({ kind: "daily", every: 1 });
    expect(r.who).toEqual([]);
    expect(r.tags).toEqual([]);
    expect(r.listName).toBeNull();
    expect(r.title).toBe("发给 @李哥 的 #材料 /工作");
  });

  it("SUBTASK_SKIP 只剩这三类——repeat 从表里拿掉了，改这里等于改口径", () => {
    expect(SUBTASK_SKIP).toEqual(["tag", "list", "who"]);
  });
});

describe("解析：那句「每月?」清理正则**保留**，只剩一种触发场景", () => {
  const p = (s: string) => parseSubtaskInput(s, MON);

  // 结论：留着。循环认了之后它不再是「循环词的残渣清扫」，而是「用户打了半句话」的兜底——
  // 光杆「每」后面没跟循环词、日期另写在别处，那个「每」不是标题的一部分
  it("光杆「每」+ 另写的日期：「每」不留在标题里", () => {
    const r = p("每 交周报 明天");
    expect(r.repeat).toBeNull();
    expect(r.due).toBe("2026-08-18");
    expect(r.title).toBe("交周报");
  });

  it("光杆「每月」同理", () => {
    const r = p("每月 交房租 明天");
    expect(r.repeat).toBeNull();
    expect(r.title).toBe("交房租");
  });

  it("没识别出日期时一个字都不动：光杆「每」照旧留在标题里", () => {
    expect(p("每 交周报").title).toBe("每 交周报");
  });

  it("成词的正文不误伤：「每日一记」「每人一份」里的「每」不是光杆", () => {
    expect(p("每日一记 明天").title).toBe("每日一记");
    expect(p("每人一份 明天").title).toBe("每人一份");
  });
});

// ---------- 2. 行为 ----------

describe("行为：勾完成 = 推到下一次，不是标完成", () => {
  it("勾一条每天重复的：due +1 天，done 仍是 false，doneAt 仍是 null", () => {
    const [id, subId] = withRepeatingSub({ due: today, repeat: { kind: "daily", every: 1 } });
    toggleSubtask(id, subId);
    const s = onlySub(id);
    expect(s.id).toBe(subId); // 还是原来那一条，没换 id
    expect(s.due).toBe(addDays(today, 1));
    expect(s.done).toBe(false);
    expect(s.doneAt).toBeNull();
    expect(s.repeat).toEqual({ kind: "daily", every: 1 });
  });

  it("**不留历史副本**：任务表里不多一件事，子任务也还是一条（跟整件事故意不一样）", () => {
    const before = appStore.getState().data.tasks.length;
    const [id, subId] = withRepeatingSub({});
    toggleSubtask(id, subId);
    expect(appStore.getState().data.tasks).toHaveLength(before + 1); // 只有刚建的那件事
    expect(getTask(id).subtasks).toHaveLength(1);
    // 已完成那一堆里一条都不该有
    expect(splitSubtasks(getTask(id).subtasks).done).toHaveLength(0);
    expect(splitSubtasks(getTask(id).subtasks).open).toHaveLength(1);
  });

  it("逾期的补追赶：锚点取 max(旧 due, 今天)，新落点落在未来", () => {
    const [id, subId] = withRepeatingSub({
      due: addDays(today, -10), repeat: { kind: "daily", every: 1 },
    });
    toggleSubtask(id, subId);
    expect(onlySub(id).due).toBe(addDays(today, 1)); // 不是 -9 天
  });

  it("每周重复的推到下一个那个星期几", () => {
    const [id, subId] = withRepeatingSub({ due: today, repeat: { kind: "weekly", days: [0] } });
    toggleSubtask(id, subId);
    const next = onlySub(id).due as string;
    expect(dayOfWeek(next)).toBe(0);
    expect(next > today).toBe(true);
  });

  it("给一句人话的提示：下一次是哪天", () => {
    const [id, subId] = withRepeatingSub({ due: today, repeat: { kind: "daily", every: 1 } });
    toggleSubtask(id, subId);
    expect(appStore.getState().ui.toast?.msg).toBe(`这一步下一次是 ${formatShort(addDays(today, 1))}`);
  });

  it("进撤销栈：撤一下回到原来那天、原来的未完成", () => {
    const [id, subId] = withRepeatingSub({ due: today, repeat: { kind: "daily", every: 1 } });
    toggleSubtask(id, subId);
    undo();
    const s = onlySub(id);
    expect(s.due).toBe(today);
    expect(s.done).toBe(false);
  });

  it("列表行 / 右键菜单 / 手机那几条路（直调 updateSubtask({done})）走的是同一套", () => {
    const [id, subId] = withRepeatingSub({ due: today, repeat: { kind: "daily", every: 1 } });
    updateSubtask(id, subId, { done: true });
    const s = onlySub(id);
    expect(s.due).toBe(addDays(today, 1));
    expect(s.done).toBe(false);
  });

  it("没有 due 的带循环子任务：没锚点可推，正常标完成，不抛错", () => {
    const id = addTask({ title: "装修" });
    addSubtask(id, "大扫除", { repeat: { kind: "daily", every: 1 } });
    const subId = onlySub(id).id;
    expect(() => toggleSubtask(id, subId)).not.toThrow();
    const s = onlySub(id);
    expect(s.done).toBe(true);
    expect(s.doneAt).not.toBeNull();
    expect(s.due).toBeNull();
  });

  it("不带循环的子任务：一个字没变，照旧勾完成", () => {
    const id = addTask({ title: "装修" });
    addSubtask(id, "量尺寸", { due: today });
    const subId = onlySub(id).id;
    toggleSubtask(id, subId);
    const s = onlySub(id);
    expect(s.done).toBe(true);
    expect(s.due).toBe(today); // 不推进
  });

  it("取消完成（把已完成的再点一下）：现有行为不变，只是清掉完成状态", () => {
    const [id, subId] = withRepeatingSub({
      due: today, repeat: { kind: "daily", every: 1 }, done: true, doneAt: "2026-01-01T00:00:00.000Z",
    });
    toggleSubtask(id, subId);
    const s = onlySub(id);
    expect(s.done).toBe(false);
    expect(s.doneAt).toBeNull();
    expect(s.due).toBe(today); // 取消完成不是「了结」，不推进
  });

  it("导入回填（显式带 doneAt）不算用户在勾：照旧写成已完成，不推进", () => {
    const [id, subId] = withRepeatingSub({ due: today, repeat: { kind: "daily", every: 1 } });
    updateSubtask(id, subId, { done: true, doneAt: "2026-01-01T00:00:00.000Z" });
    const s = onlySub(id);
    expect(s.done).toBe(true);
    expect(s.doneAt).toBe("2026-01-01T00:00:00.000Z");
    expect(s.due).toBe(today);
  });
});

describe("行为：放弃 = 这次不做了，下次还来", () => {
  it("放弃一条带循环的：推到下一次、不留档、droppedAt 仍是空", () => {
    const [id, subId] = withRepeatingSub({ due: today, repeat: { kind: "daily", every: 1 } });
    dropSubtask(id, subId);
    const s = onlySub(id);
    expect(s.due).toBe(addDays(today, 1));
    expect(s.droppedAt).toBeNull();
    expect(s.done).toBe(false);
    expect(getTask(id).subtasks).toHaveLength(1); // 没有「这一轮放弃了」的副本
    expect(appStore.getState().ui.toast?.msg).toBe(`这一步下一次是 ${formatShort(addDays(today, 1))}`);
  });

  it("不带循环的放弃：照旧盖 droppedAt、照旧那句提示", () => {
    const id = addTask({ title: "装修" });
    addSubtask(id, "量尺寸", { due: today });
    const subId = onlySub(id).id;
    dropSubtask(id, subId);
    expect(onlySub(id).droppedAt).not.toBeNull();
    expect(appStore.getState().ui.toast?.msg).toBe("已放弃这一步");
  });

  it("取消放弃：不推进，只把那个戳清掉", () => {
    const [id, subId] = withRepeatingSub({
      due: today, repeat: { kind: "daily", every: 1 }, droppedAt: "2026-01-01T00:00:00.000Z",
    });
    dropSubtask(id, subId, false);
    const s = onlySub(id);
    expect(s.droppedAt).toBeNull();
    expect(s.due).toBe(today);
  });
});

describe("advanceSub 自己的口径", () => {
  it("没循环 / 没 due 都推不动，返回 null", () => {
    const base: Subtask = { id: "s1", title: "x", done: false, due: today, dueTime: null, priority: null, doneAt: null, droppedAt: null };
    expect(advanceSub(base)).toBeNull(); // 没 repeat
    expect(advanceSub({ ...base, due: null, repeat: { kind: "daily", every: 1 } })).toBeNull(); // 没 due
  });

  it("推得动时：done / doneAt / droppedAt 一起清干净，别的字段原样", () => {
    const s: Subtask = {
      id: "s1", title: "大扫除", done: true, due: today, dueTime: "15:00", priority: 3,
      doneAt: "2026-01-01T00:00:00.000Z", droppedAt: "2026-01-01T00:00:00.000Z",
      repeat: { kind: "daily", every: 1 },
    };
    const next = advanceSub(s);
    expect(next).not.toBeNull();
    expect(next!.done).toBe(false);
    expect(next!.doneAt).toBeNull();
    expect(next!.droppedAt).toBeNull();
    expect(next!.due).toBe(addDays(today, 1));
    expect(next!.dueTime).toBe("15:00");
    expect(next!.priority).toBe(3);
    expect(next!.title).toBe("大扫除");
  });
});

// ---------- 3. 创建路径 ----------

describe("创建：解析出的 repeat 一路存进去", () => {
  it("addSubtask 带 repeat 就落库；不带就连这个键都不出现（缺失 = 不循环）", () => {
    const id = addTask({ title: "装修" });
    addSubtask(id, "大扫除", { due: today, repeat: { kind: "weekly", days: [0] } });
    addSubtask(id, "量尺寸", { due: today });
    const [a, b] = getTask(id).subtasks;
    expect(a.repeat).toEqual({ kind: "weekly", days: [0] });
    expect("repeat" in b).toBe(false);
  });

  it("一条命令记全一条循环子任务：解析结果直接喂进 addSubtask", () => {
    const id = addTask({ title: "装修" });
    const r = parseSubtaskInput("每周末 大扫除", FRI);
    addSubtask(id, r.title, { due: r.due, dueTime: r.dueTime, priority: r.priority || null, repeat: r.repeat });
    const s = onlySub(id);
    expect(s.title).toBe("大扫除");
    expect(s.due).toBe("2026-08-23");
    expect(s.repeat).toEqual({ kind: "weekly", days: [0] });
  });

  it("桌面那条路（TaskCard.addSubFromInput）把 repeat 一起存了", () => {
    expect(taskCardSource).toContain("parseSubtaskInput(newSub");
    const start = taskCardSource.indexOf("function addSubFromInput");
    expect(start).toBeGreaterThan(0);
    expect(taskCardSource.slice(start, start + 700)).toContain("repeat: r.repeat");
  });

  it("手机那条路（TaskSheet.addSubFromInput）也把 repeat 一起存了", () => {
    const start = taskSheetSource.indexOf("function addSubFromInput");
    expect(start).toBeGreaterThan(0);
    expect(taskSheetSource.slice(start, start + 600)).toContain("repeat: r.repeat");
  });
});

// ---------- 4. 界面 ----------

describe("界面：两端的子任务行上都看得见它会重复", () => {
  it("桌面子任务行画了循环小签，样式在 app.css 里", () => {
    expect(taskCardSource).toContain('className="sub-rep"');
    expect(taskCardSource).toContain("s.repeat && (");
    expect(taskCardSource).toContain("describeRepeat(s.repeat)");
    expect(appCss).toContain(".task-card .subs .sub-rep");
    // 只用主题 token，不许写死颜色
    const start = appCss.indexOf(".task-card .subs .sub-rep");
    const block = appCss.slice(start, appCss.indexOf("}", start));
    expect(block).toContain("var(--ink-3)");
    expect(block).toContain("var(--hair)");
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,6}/);
    // 圆角跟同一行里的「已放弃」小签一致
    expect(block).toContain("border-radius: 999px");
    expect(block).toContain("font-size: 11px");
  });

  it("手机子任务行画了循环小签，样式在 mobile-sheet.css 里", () => {
    expect(taskSheetSource).toContain('className="msh-subrep"');
    expect(taskSheetSource).toContain("describeRepeat(sub.repeat)");
    expect(mobileSheetCss).toContain(".msh-subrep");
    const start = mobileSheetCss.indexOf(".msh-subrep {");
    const block = mobileSheetCss.slice(start, mobileSheetCss.indexOf("}", start));
    expect(block).toContain("var(--ink-3)");
    expect(block).toContain("var(--hair)");
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,6}/);
    // 跟同一行的 .msh-droptag 逐字同款
    expect(block).toContain("border-radius: 999px");
    expect(block).toContain("var(--fs-xs)");
  });

  it("小签上的字就是 describeRepeat 的结果（「每周日」不是「weekly」）", () => {
    expect(describeRepeat({ kind: "weekly", days: [0] })).toBe("每周日");
    expect(describeRepeat({ kind: "workday" })).toBe("每个工作日");
    expect(describeRepeat({ kind: "monthly", day: 5 })).toBe("每月5号");
  });
});

// ---------- 5. 母任务的循环推进不许清掉子任务自己的循环 ----------

describe("母任务转下一轮时，子任务自己的 repeat 活下来", () => {
  it("completeTask 推进母任务：子任务的 repeat 原样带走，**锚点也保住**（清了它就再也推不动）", () => {
    const id = addTask({ title: "周报", due: today, repeat: { kind: "weekly", days: [1] } });
    addSubtask(id, "大扫除", { due: today, repeat: { kind: "weekly", days: [0] } });
    completeTask(id);
    const advanced = getTask(id); // 本体（副本是另一条 id）
    expect(advanced.done).toBe(false);
    const s = advanced.subtasks[0];
    expect(s.repeat).toEqual({ kind: "weekly", days: [0] }); // ← 这一条是本节的全部意义
    expect(s.done).toBe(false);
    // 还没到期的锚点原样留着：repeat 在、due 没了 = 一条推不动的死规则（v8 起 resetSubForRound 管这个）
    expect(s.due).toBe(today);
  });

  it("母任务转轮时，子任务那个**已经过期**的锚点顺手推到今天或之后的第一个落点", () => {
    const id = addTask({ title: "周报", due: today, repeat: { kind: "weekly", days: [1] } });
    addSubtask(id, "大扫除", { due: addDays(today, -10), repeat: { kind: "weekly", days: [0] } });
    completeTask(id);
    const s = getTask(id).subtasks[0];
    expect(s.repeat).toEqual({ kind: "weekly", days: [0] });
    expect(s.due).toBe(firstOccurrence({ kind: "weekly", days: [0] }, today));
    expect(dayOfWeek(s.due as string)).toBe(0);
  });

  it("没有自己循环的那几步照旧：这一轮的日期和收场戳全清掉，重新继承母任务", () => {
    const id = addTask({ title: "周报", due: today, repeat: { kind: "weekly", days: [1] } });
    addSubtask(id, "写初稿", { due: today });
    const sid = getTask(id).subtasks[0].id;
    updateSubtask(id, sid, { done: true });
    completeTask(id);
    const s = getTask(id).subtasks[0];
    expect(s.due).toBeNull();
    expect(s.dueTime ?? null).toBeNull();
    expect(s.done).toBe(false);
    expect(s.doneAt ?? null).toBeNull();
  });

  it("母任务留下的那条已完成副本里，子任务的 repeat 也还在（那是历史，一个字不许改）", () => {
    const id = addTask({ title: "周报", due: today, repeat: { kind: "weekly", days: [1] } });
    addSubtask(id, "大扫除", { due: today, repeat: { kind: "weekly", days: [0] } });
    completeTask(id);
    const copy = appStore.getState().data.tasks.find((t) => t.id !== id && t.title === "周报");
    expect(copy).toBeTruthy();
    expect(copy!.done).toBe(true);
    expect(copy!.subtasks[0].repeat).toEqual({ kind: "weekly", days: [0] });
    expect(copy!.subtasks[0].due).toBe(today);
  });
});
