// 子任务排序要认「继承来的日期」（2026-09-07 PM 报的）。
//
// 现场：「Serge留学」母任务 9月11日，底下五步——三步自己填了 9月30日，一步自己填了 9月11日，
// 还有一步（「客户收集：办理护照」）没填日期。没填 = 跟着母任务走，屏幕上写的就是 9月11日，
// 可它却被排到了最下面，跟同为 9月11日的那一步中间隔着三条 9月30日。
//
// 病根：splitSubtasks 排序时读的是子任务自己的 due，没填就当「没日期」一律沉底——
// 而界面显示、日期视图（rowDue）用的是「自己填了用自己的，没填用母任务的」。同一件事两套口径。
// 修法：排序改走 subDue / subTime，跟 rowDue / rowTime 同一个源头。
import { describe, expect, it } from "vitest";
import type { AppData, Subtask, Task } from "../src/core/model";
import { defaultData, newTask } from "../src/core/model";
import { addDays, todayYMD } from "../src/core/dates";
import { planGroups } from "../src/core/plan";
import { appStore, openRows, postponeRows, rowDue, sortRows, splitSubtasks } from "../src/core/store";

function sub(id: string, patch: Partial<Subtask> = {}): Subtask {
  return { id, title: id, done: false, due: null, dueTime: null, priority: null, doneAt: null, ...patch };
}

/** 造一件带子任务的事；母任务的日期/钟点由调用方给 */
function task(due: string | null, subtasks: Subtask[], dueTime: string | null = null): Task {
  return newTask({ title: "Serge留学", due, dueTime, subtasks });
}

const ids = (subs: Subtask[]) => subs.map((s) => s.id);

describe("PM 报的现场：母任务 9月11日，没填日期的那一步该跟 9月11日的挨着", () => {
  const t = task("2026-09-11", [
    sub("材料一", { due: "2026-09-30" }),
    sub("材料二", { due: "2026-09-30" }),
    sub("办理护照"), // 没填 = 9月11日
    sub("材料三", { due: "2026-09-30" }),
    sub("选校清单", { due: "2026-09-11" }),
  ]);

  it("两条 9月11日的排最前、挨在一起，三条 9月30日在后", () => {
    const { open } = splitSubtasks(t.subtasks, t);
    expect(ids(open)).toEqual(["办理护照", "选校清单", "材料一", "材料二", "材料三"]);
  });

  it("排在一起是因为生效日期真的相同（跟屏幕上显示的同一个数）", () => {
    const { open } = splitSubtasks(t.subtasks, t);
    const dues = open.map((s) => rowDue({ task: t, sub: s }));
    expect(dues).toEqual([
      "2026-09-11", "2026-09-11", "2026-09-30", "2026-09-30", "2026-09-30",
    ]);
  });

  it("跟「今天 / 计划」页把同一批子任务排出来的先后一致（两处口径不许再分家）", () => {
    const { open } = splitSubtasks(t.subtasks, t);
    const rows = sortRows(t.subtasks.map((s) => ({ task: t, sub: s })), "time");
    expect(ids(open)).toEqual(rows.map((r) => r.sub!.id));
  });
});

describe("边界", () => {
  it("母任务也没日期：没填的那些一起沉到最后，彼此保持原序", () => {
    const t = task(null, [
      sub("甲"),
      sub("乙", { due: "2026-09-20" }),
      sub("丙"),
      sub("丁", { due: "2026-09-05" }),
    ]);
    expect(ids(splitSubtasks(t.subtasks, t).open)).toEqual(["丁", "乙", "甲", "丙"]);
  });

  it("自己填的日期比母任务早：排到继承母任务的那些前面", () => {
    const t = task("2026-09-11", [sub("继承的"), sub("提前做", { due: "2026-09-01" })]);
    expect(ids(splitSubtasks(t.subtasks, t).open)).toEqual(["提前做", "继承的"]);
  });

  it("自己填的日期比母任务晚：排到继承母任务的那些后面", () => {
    const t = task("2026-09-11", [sub("推后做", { due: "2026-09-25" }), sub("继承的")]);
    expect(ids(splitSubtasks(t.subtasks, t).open)).toEqual(["继承的", "推后做"]);
  });

  it("同一天的（不管是自己填的还是继承的）保持原来的先后", () => {
    const t = task("2026-09-11", [
      sub("一"),
      sub("二", { due: "2026-09-11" }),
      sub("三"),
      sub("四", { due: "2026-09-11" }),
    ]);
    expect(ids(splitSubtasks(t.subtasks, t).open)).toEqual(["一", "二", "三", "四"]);
  });

  it("做完的那堆不参与排序，按原序留在下面一堆", () => {
    const t = task("2026-09-11", [
      sub("做完的晚", { due: "2026-09-30", done: true }),
      sub("没做的继承"),
      sub("做完的早", { due: "2026-09-01", done: true }),
    ]);
    const { open, done } = splitSubtasks(t.subtasks, t);
    expect(ids(open)).toEqual(["没做的继承"]);
    expect(ids(done)).toEqual(["做完的晚", "做完的早"]);
  });

  it("回收站里的两堆都不进（不管它有没有自己的日期）", () => {
    const OLD = "2026-02-02T00:00:00.000Z";
    const t = task("2026-09-11", [
      sub("删掉的继承", { deletedAt: OLD }),
      sub("删掉的早", { due: "2026-09-01", deletedAt: OLD }),
      sub("删掉的做完了", { done: true, deletedAt: OLD }),
      sub("还在的继承"),
      sub("还在的做完了", { done: true }),
    ]);
    const { open, done } = splitSubtasks(t.subtasks, t);
    expect(ids(open)).toEqual(["还在的继承"]);
    expect(ids(done)).toEqual(["还在的做完了"]);
  });

  it("不改原数组", () => {
    const t = task("2026-09-11", [sub("后", { due: "2026-09-30" }), sub("前")]);
    splitSubtasks(t.subtasks, t);
    expect(ids(t.subtasks)).toEqual(["后", "前"]);
  });
});

describe("钟点：跟 rowTime 一个口径", () => {
  it("同一天里写了钟点的排在没钟点的前面", () => {
    const t = task("2026-09-11", [
      sub("没钟点", { due: "2026-09-11" }),
      sub("下午", { due: "2026-09-11", dueTime: "14:00" }),
      sub("上午", { due: "2026-09-11", dueTime: "09:00" }),
    ]);
    expect(ids(splitSubtasks(t.subtasks, t).open)).toEqual(["上午", "下午", "没钟点"]);
  });

  it("没填日期的连母任务的钟点一起继承，排在同一天没钟点的那条前面", () => {
    const t = task("2026-09-11", [sub("自己写了日期", { due: "2026-09-11" }), sub("继承的")], "09:00");
    expect(ids(splitSubtasks(t.subtasks, t).open)).toEqual(["继承的", "自己写了日期"]);
  });

  it("自己排了别的日子就不再继承母任务的钟点——那个钟点是给母任务那天的", () => {
    const t = task("2026-09-11", [
      sub("改到别天", { due: "2026-09-30" }),
      sub("那天晚上", { due: "2026-09-30", dueTime: "20:00" }),
    ], "09:00");
    expect(ids(splitSubtasks(t.subtasks, t).open)).toEqual(["那天晚上", "改到别天"]);
  });
});

// 顺着这个病把「别处按日期摆子任务」的地方逐个核了一遍。结论：
//   · 今天 / 计划 / 侧栏计数（openRows → sortRows → rowDue）本来就走生效日期 ✓
//   · 计划页分组（plan.planGroups）每个判据都是 rowDue ✓
//   · 日历、四象限：按**整件事**摆，压根不拆子任务，不是同一个病（也不该顺手改成拆）
//   · 已完成（doneRows）按**完成日**摆，跟截止日期无关
//   · 搜索（core/search）只按文字相关度排，不碰日期
// 下面这几条把「已经对的」钉住，省得哪天有人把 rowDue 换成裸 due 又分一次家。
describe("别处：按日期摆子任务的地方都得是生效日期", () => {
  const t = task("2026-09-11", [
    sub("材料一", { due: "2026-09-30" }),
    sub("办理护照"), // 没填 = 9月11日
    sub("选校清单", { due: "2026-09-11" }),
  ]);
  const data: AppData = { ...defaultData(), tasks: [t] };

  it("今天 / 计划页把子任务拆成行之后，先后跟任务卡里那一列一致", () => {
    const rows = sortRows(openRows(data), "time");
    expect(rows.map((r) => r.sub!.id)).toEqual(ids(splitSubtasks(t.subtasks, t).open));
  });

  it("计划页分组：没填日期的那步落进母任务那天的组，不落「未安排」", () => {
    const groups = planGroups(sortRows(openRows(data), "time"), "time", "2026-09-11");
    const idsIn = (key: string) => groups.find((g) => g.key === key)!.rows.map((r) => r.sub!.id);
    expect(idsIn("today")).toEqual(["办理护照", "选校清单"]);
    expect(idsIn("nodate")).toEqual([]); // 继承来的日期算数，它不是「没安排」
    expect(idsIn("m1")).toEqual(["材料一"]);
  });
});

describe("顺延一条继承日期的子任务：从母任务那天起算", () => {
  // postponeRows 里那份「继承来的日期是哪个数」以前是手抄的第三份，现已并进 subDue / subTime。
  // 这条钉的是并完之后行为没变：母任务排在未来时，推它的子任务是从**母任务那天**往后挪，
  // 不是从今天（从今天算的话，这一步会莫名其妙跑到母任务前面去）
  const today = todayYMD();
  it("母任务在 5 天后、子任务继承 → 推一天落在 6 天后，钟点也一起落下来", () => {
    const t = newTask({
      title: "母任务在未来",
      due: addDays(today, 5),
      dueTime: "15:00",
      subtasks: [{ id: "继承的", title: "继承的", done: false, due: null, dueTime: null, priority: null, doneAt: null }],
    });
    localStorage.clear();
    appStore.setState({ data: { ...defaultData(), tasks: [t] }, loaded: true, loadError: null, undoDepth: 0 });
    postponeRows([{ task: t, sub: t.subtasks[0] }]);
    const after = appStore.getState().data.tasks.find((x) => x.id === t.id)!;
    expect(after.subtasks[0].due).toBe(addDays(today, 6));
    expect(after.subtasks[0].dueTime).toBe("15:00");
    expect(after.due).toBe(addDays(today, 5)); // 母任务没被连累
  });
});
