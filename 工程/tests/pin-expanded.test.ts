// 展开着的那张卡，位置不许被它自己的改动挪走（core/pin.ts）。
//
// 用户原话（2026-09-02）：「子任务添加可能存在一个小bug……如果主任务时间点在后面比如两个月后，
// 子任务时间点在前面比如今天，添加后卡片会自动收缩而不能连贯输入。
// 希望后台的卡片顺序调整不影响到前台卡片展开和继续输入的状态。」
//
// 病根是三条各自都对的规矩叠在一起：
//   ① openRows：一件事只要有没做完的子任务，母任务行就撤掉，改成一行一个子任务；
//   ② 分组按**行的日期**算，于是那条今天到期的子任务行落进「今天」，跟母任务原来那组隔着老远；
//   ③ 卡片挂在它那一行下面画，而每一组各自一个 RowList。
// 三条合起来 = 加完子任务，卡片换了个 React 父节点，整张卡卸载重挂：输入框焦点、
// 「＋子任务」草稿、「整句改」草稿、已完成子任务的折叠状态一起清空。
//
// 这一组钉的就是「钉住」这件事本身：pinExpanded 是个纯函数，只重排，不改数据也不改行的内容。
import { beforeEach, describe, expect, it } from "vitest";
import type { Task } from "../src/core/model";
import { defaultData, newTask } from "../src/core/model";
import {
  addSubtask, aliveTasks, appStore, openRows, sortTasks, updateSubtask, updateTask,
} from "../src/core/store";
import { listGroups, planGroups } from "../src/core/plan";
import type { PinGroup, PinIds } from "../src/core/pin";
import { pinExpanded } from "../src/core/pin";
import { addDays, todayYMD } from "../src/core/dates";
import pinSource from "../src/core/pin.ts?raw";
import rowListSource from "../src/components/RowList.tsx?raw";
import planViewSource from "../src/views/Plan.tsx?raw";
import todayViewSource from "../src/views/Today.tsx?raw";
import doneViewSource from "../src/views/Done.tsx?raw";
import listViewSource from "../src/views/ListView.tsx?raw";
import calendarViewSource from "../src/views/Calendar.tsx?raw";

// ---------- 纯函数那一层：拿最小的行来钉，跟真实数据结构解耦 ----------

/** key 里带斜杠的就是子任务行（跟 RowList.rowKey 一个形状：`任务/子任务`） */
interface Row {
  key: string;
}
const IDS: PinIds<Row> = { key: (r) => r.key, taskId: (r) => r.key.split("/")[0] };

const G = (key: string, ...keys: string[]): PinGroup<Row> => ({ key, rows: keys.map((k) => ({ key: k })) });
/** 把分组摊成一行字好断言：`组名: 行 行 行` */
const shape = (gs: PinGroup<Row>[]) => gs.map((g) => `${g.key}: ${g.rows.map((r) => r.key).join(" ")}`);

describe("pinExpanded：展开期间把这件事的行钉在原位", () => {
  it("没展开就什么都不做——原样那份返回去，连新数组都不建", () => {
    const next = [G("today", "a"), G("far", "z")];
    expect(pinExpanded(next, [G("today", "a", "z")], null, IDS)).toBe(next);
  });

  it("没有上一版（刚进这个视图）也什么都不做：没有「原位」可言", () => {
    const next = [G("today", "a"), G("far", "z")];
    expect(pinExpanded(next, null, "a", IDS)).toBe(next);
  });

  it("上一版这件事根本不在页面上（刚被搜索筛出来）——不硬安一个位置", () => {
    const next = [G("today", "t4/s1"), G("far", "z")];
    expect(pinExpanded(next, [G("today", "a"), G("far", "z")], "t4", IDS)).toBe(next);
  });

  it("🔴 用户报的那一条：母任务行被子任务行顶掉、新行落进「今天」——钉回「更远」原来的位置", () => {
    const prev = [G("today", "a", "b"), G("far", "t4", "z")];
    const next = [G("today", "t4/s1", "a", "b"), G("far", "z")];
    expect(shape(pinExpanded(next, prev, "t4", IDS))).toEqual([
      "today: a b",
      "far: t4/s1 z",
    ]);
  });

  it("接着敲第二条：新行紧跟在卡片那一行后面，还是在原来那一组（连贯输入）", () => {
    // prev 是上一版**钉住之后**的那份（视图记的就是真画出去的那一版）
    const prev = [G("today", "a", "b"), G("far", "t4/s1", "z")];
    const next = [G("today", "t4/s1", "t4/s2", "a", "b"), G("far", "z")];
    expect(shape(pinExpanded(next, prev, "t4", IDS))).toEqual([
      "today: a b",
      "far: t4/s1 t4/s2 z",
    ]);
  });

  it("改子任务日期也不许把行挪走——老行认的是上一版的位置，不是它现在的日子", () => {
    const prev = [G("today", "t4/s1", "a"), G("far", "z")];
    const next = [G("today", "a"), G("far", "t4/s1", "z")];
    expect(shape(pinExpanded(next, prev, "t4", IDS))).toEqual([
      "today: t4/s1 a",
      "far: z",
    ]);
  });

  it("🔴 天然横跨两组的一件事：展开它不许把散落的行拢到一起（那是展开自己惹的挪动）", () => {
    const prev = [G("today", "t6/s1", "a"), G("far", "t6/s2", "z")];
    const next = [G("today", "t6/s1", "a"), G("far", "t6/s2", "z")];
    expect(shape(pinExpanded(next, prev, "t6", IDS))).toEqual([
      "today: t6/s1 a",
      "far: t6/s2 z",
    ]);
  });

  it("卡片那一行整个没了（头一条子任务被删）：接替它的那一行搬到它的位置来，卡片才不跟着跑", () => {
    const prev = [G("today", "t6/s1", "a"), G("far", "t6/s2", "z")];
    const next = [G("today", "a"), G("far", "t6/s2", "z")];
    expect(shape(pinExpanded(next, prev, "t6", IDS))).toEqual([
      "today: t6/s2 a",
      "far: z",
    ]);
  });

  it("前邻居也一起没了就落回组首，不许被甩到组尾去", () => {
    const prev = [G("today", "a", "b", "t4"), G("far", "z")];
    const next = [G("today", "c", "d"), G("far", "t4/s1", "z")];
    expect(shape(pinExpanded(next, prev, "t4", IDS))).toEqual([
      "today: t4/s1 c d",
      "far: z",
    ]);
  });

  it("前面那些行还在几条就贴着最近的那条——别的行怎么增减都不影响它落在哪", () => {
    const prev = [G("today", "a", "b", "t4/s1", "c")];
    const next = [G("today", "a", "b", "c", "t4/s1")];
    expect(shape(pinExpanded(next, prev, "t4", IDS))).toEqual(["today: a b t4/s1 c"]);
  });

  it("这件事是真没了（删掉 / 整件勾完）就让它没——不留一个空壳挂在那儿", () => {
    const prev = [G("today", "a"), G("far", "t4", "z")];
    const next = [G("today", "a"), G("far", "z")];
    expect(pinExpanded(next, prev, "t4", IDS)).toBe(next);
  });

  it("兜底行池：这一版一行都不剩（日期改到这个视图管不着的日子）也能把它捞回来", () => {
    // 「今天」视图就是这一路：把日期改到明天，两组里一条都不剩，光靠 next 是找不回来的
    const prev = [G("overdue"), G("today", "t1", "a")];
    const next = [G("overdue"), G("today", "a")];
    const pool = [{ key: "t1/s1" }];
    expect(shape(pinExpanded(next, prev, "t1", IDS, pool))).toEqual([
      "overdue: ",
      "today: t1/s1 a",
    ]);
  });

  it("分组本身换了一套（切了排序口径）就不硬凑——上一版的组名对不上号", () => {
    const prev = [G("today", "a"), G("far", "t4", "z")];
    const next = [G("p3", "t4"), G("p0", "a", "z")];
    expect(pinExpanded(next, prev, "t4", IDS)).toBe(next);
  });

  it("别的事一条都不动：钉的只有展开那一件", () => {
    const prev = [G("today", "a", "b"), G("far", "t4", "z")];
    const next = [G("today", "t4/s1", "b", "a"), G("far", "z", "y")];
    const out = pinExpanded(next, prev, "t4", IDS);
    expect(shape(out)).toEqual(["today: b a", "far: t4/s1 z y"]);
  });

  it("🔴 幂等：钉过的结果再喂一遍进去还是它，不然每渲染一次位置就漂一格", () => {
    const prev = [G("today", "a", "b"), G("far", "t4", "z")];
    const next = [G("today", "t4/s1", "a", "b"), G("far", "z")];
    const once = pinExpanded(next, prev, "t4", IDS);
    const twice = pinExpanded(next, once, "t4", IDS);
    expect(shape(twice)).toEqual(shape(once));
  });

  it("只重排、不碰行本身：出来的还是原来那几个对象", () => {
    const prev = [G("today", "a"), G("far", "t4", "z")];
    const next = [G("today", "t4/s1", "a"), G("far", "z")];
    const row = next[0].rows[0];
    const out = pinExpanded(next, prev, "t4", IDS);
    expect(out[1].rows[0]).toBe(row);
  });

  it("组上挂的别的字段（label / warn）原样带过去，不能钉一次把组标题钉没了", () => {
    const prev = [{ key: "today", label: "今天", warn: true, rows: [{ key: "t4" }] }];
    const next = [{ key: "today", label: "今天", warn: true, rows: [{ key: "t4/s1" }] }];
    const out = pinExpanded(next, prev, "t4", IDS);
    expect(out[0].label).toBe("今天");
    expect(out[0].warn).toBe(true);
  });
});

// ---------- 接上真数据走一遍：store + openRows + planGroups ----------

function reset() {
  localStorage.clear();
  appStore.setState({ data: { ...defaultData(), lists: [], tasks: [] } });
}

describe("接上真数据：两个月后的事，在卡里加一条今天到期的子任务", () => {
  beforeEach(reset);

  const today = todayYMD();
  const ROWS: PinIds<{ task: { id: string }; sub: { id: string } | null }> = {
    key: (r) => (r.sub ? `${r.task.id}/${r.sub.id}` : r.task.id),
    taskId: (r) => r.task.id,
  };
  const lay = () => planGroups(openRows(appStore.getState().data), "time", today);

  function seed() {
    const big = newTask({ id: "big", title: "两个月后的大事", due: addDays(today, 60), order: 3 });
    appStore.setState({
      data: {
        ...appStore.getState().data,
        tasks: [
          newTask({ id: "a", title: "今天要做的甲", due: today, order: 1 }),
          newTask({ id: "c", title: "一周内的丙", due: addDays(today, 3), order: 2 }),
          big,
          newTask({ id: "z", title: "两个月后的另一件", due: addDays(today, 61), order: 4 }),
        ],
      },
    });
    return big;
  }

  it("不钉的话它真的会换一组——这条先证明病在", () => {
    seed();
    const before = lay();
    expect(before.find((g) => g.key === "h1")!.rows.map(ROWS.key)).toEqual(["big", "z"]);
    addSubtask("big", "补一条数据", { due: today });
    const after = lay();
    expect(after.find((g) => g.key === "h1")!.rows.map(ROWS.key)).not.toContain("big");
    expect(after.find((g) => g.key === "today")!.rows.map(ROWS.key).some((k) => k.startsWith("big/"))).toBe(true);
  });

  it("钉上之后：新的子任务行留在「半年内」母任务原来那个位置", () => {
    seed();
    const before = lay();
    addSubtask("big", "补一条数据", { due: today });
    const pinned = pinExpanded(lay(), before, "big", ROWS);
    const far = pinned.find((g) => g.key === "h1")!.rows.map(ROWS.key);
    expect(far.length).toBe(2);
    expect(far[0].startsWith("big/")).toBe(true);
    expect(far[1]).toBe("z");
    // 「今天」那组只有原来的甲，没被塞进来
    expect(pinned.find((g) => g.key === "today")!.rows.map(ROWS.key)).toEqual(["a"]);
  });

  it("接着再加一条明天的：两条都跟着卡片待在原地，顺序是先加的在前", () => {
    seed();
    let ver = lay();
    addSubtask("big", "补一条数据", { due: today });
    ver = pinExpanded(lay(), ver, "big", ROWS);
    addSubtask("big", "再补一条", { due: addDays(today, 1) });
    ver = pinExpanded(lay(), ver, "big", ROWS);
    const far = ver.find((g) => g.key === "h1")!.rows;
    expect(far.map((r) => r.sub?.title ?? r.task.title)).toEqual([
      "补一条数据",
      "再补一条",
      "两个月后的另一件",
    ]);
  });

  it("卡片一收起（expandedId 变 null）立刻松开，该去「今天」去「今天」", () => {
    seed();
    const before = lay();
    addSubtask("big", "补一条数据", { due: today });
    const pinned = pinExpanded(lay(), before, "big", ROWS);
    const free = pinExpanded(lay(), pinned, null, ROWS);
    expect(free.find((g) => g.key === "today")!.rows.map(ROWS.key).some((k) => k.startsWith("big/"))).toBe(true);
    expect(free.find((g) => g.key === "h1")!.rows.map(ROWS.key)).toEqual(["z"]);
  });

  it("在卡里改子任务的日期同样不许挪窝", () => {
    const big = seed();
    let ver = lay();
    addSubtask("big", "补一条数据", { due: today });
    ver = pinExpanded(lay(), ver, "big", ROWS);
    const subId = appStore.getState().data.tasks.find((t) => t.id === big.id)!.subtasks[0].id;
    updateSubtask("big", subId, { due: addDays(today, 3) });
    ver = pinExpanded(lay(), ver, "big", ROWS);
    expect(ver.find((g) => g.key === "h1")!.rows.map(ROWS.key)).toEqual([`big/${subId}`, "z"]);
    expect(ver.find((g) => g.key === "w1")!.rows.map(ROWS.key)).toEqual(["c"]);
  });
});

// ---------- 清单这一路（随手记 / 清单 / 需求方 / 标签）：一件事只占一行 ----------
//
// 用户报这个 bug 时最可能就是在清单里操作的——他的事大多挂在「工作」清单底下。
// 这个视图的病跟今天/计划略有出入：子任务的日期**不参与**这儿的分组（一件事只占一行），
// 所以「加一条今天到期的子任务」本身就不该让它换组——头两条钉的是「以后也不许动」。
// 真会把它甩到别的组去的是在同一张卡里改母任务的日期、改归属，后面两条走的就是那两条路。

describe("清单视图：分组按语义名，展开那一件不换组", () => {
  beforeEach(reset);

  const today = todayYMD();
  const TASK_PIN: PinIds<Task> = { key: (t) => t.id, taskId: (t) => t.id };

  /** 跟 ListView 里一模一样的一条链：按视图口径筛出「工作」清单 → 排序 → 切组 */
  const lay = () =>
    listGroups(
      sortTasks(
        aliveTasks(appStore.getState().data).filter((t) => !t.done && !t.droppedAt && t.listId === "work"),
        "time",
      ),
      today,
      "未安排",
    );
  /** 摊成一行字好断言：`组名: 任务 任务` */
  const rowsOf = (gs: { key: string; rows: Task[] }[]) =>
    gs.map((g) => `${g.key}: ${g.rows.map((t) => t.id).join(" ")}`);
  const START = ["overdue: ", "today: a", "later: b c", "nodate: d"];

  function seed() {
    appStore.setState({
      data: {
        ...appStore.getState().data,
        lists: [{ id: "work", name: "工作", color: "clay", order: 0, updatedAt: "" }],
        tasks: [
          newTask({ id: "a", title: "今天要做的甲", due: today, listId: "work", order: 1 }),
          newTask({ id: "b", title: "以后要做的乙", due: addDays(today, 10), listId: "work", order: 2 }),
          newTask({ id: "c", title: "以后要做的丙", due: addDays(today, 20), listId: "work", order: 3 }),
          newTask({ id: "d", title: "还没排期的丁", listId: "work", order: 4 }),
        ],
      },
    });
  }

  it("四组一律出场、组名固定：谁空了都不许让后面的组错位（下标当 key 就是这么错的）", () => {
    seed();
    expect(lay().map((g) => g.key)).toEqual(["overdue", "today", "later", "nodate"]);
    // 把今天那件挪到两个月后，「今天」组空了——组还在原位，后面两组的名字一个都没变
    updateTask("a", { due: addDays(today, 60) });
    const after = lay();
    expect(after.map((g) => g.key)).toEqual(["overdue", "today", "later", "nodate"]);
    expect(after[1].rows).toEqual([]);
  });

  it("🔴 点开「以后」组的乙、加一条今天到期的子任务：四组一行都没动，卡片还在原来那一组", () => {
    seed();
    const before = lay();
    expect(rowsOf(before)).toEqual(START);
    addSubtask("b", "补一条数据", { due: today });
    // 子任务是真加上了（不然这条断言就是空跑）
    expect(appStore.getState().data.tasks.find((t) => t.id === "b")!.subtasks.length).toBe(1);
    const pinned = pinExpanded(lay(), before, "b", TASK_PIN);
    expect(rowsOf(pinned)).toEqual(START);
    // 卡片挂在哪一组、排第几，跟加子任务之前一模一样
    expect(pinned.find((g) => g.key === "later")!.rows[0].id).toBe("b");
  });

  it("接着再加两条（一条今天、一条明天）：位置照旧，连着输入不会被打断", () => {
    seed();
    let ver = lay();
    addSubtask("b", "补一条数据", { due: today });
    ver = pinExpanded(lay(), ver, "b", TASK_PIN);
    addSubtask("b", "再补一条", { due: addDays(today, 1) });
    ver = pinExpanded(lay(), ver, "b", TASK_PIN);
    expect(rowsOf(ver)).toEqual(START);
  });

  it("真会甩走的那条路：在卡里把乙的日期改到今天——钉住之后它留在「以后」的原位", () => {
    seed();
    const before = lay();
    updateTask("b", { due: today });
    // 不钉的话它当场换一组：换组 = 换 Fragment = 整张卡卸载重挂
    expect(rowsOf(lay())).toEqual(["overdue: ", "today: a b", "later: c", "nodate: d"]);
    const pinned = pinExpanded(lay(), before, "b", TASK_PIN);
    expect(rowsOf(pinned)).toEqual(START);
    // 卡片一收起就松开，该去「今天」去「今天」
    expect(rowsOf(pinExpanded(lay(), pinned, null, TASK_PIN))).toEqual([
      "overdue: ",
      "today: a b",
      "later: c",
      "nodate: d",
    ]);
  });

  it("兜底行池：在卡里把乙改去别的清单，这个视图一行都不剩也能把它捞回来", () => {
    seed();
    const before = lay();
    updateTask("b", { listId: null });
    expect(rowsOf(lay())).toEqual(["overdue: ", "today: a", "later: c", "nodate: d"]);
    // 池子就是 ListView 给的那一份：还活着、还没了结的全部任务里挑出这一件
    const pool = aliveTasks(appStore.getState().data).filter(
      (t) => !t.done && !t.droppedAt && t.id === "b",
    );
    expect(rowsOf(pinExpanded(lay(), before, "b", TASK_PIN, pool))).toEqual(START);
  });

  it("真勾掉就让它没：池子里也不留完成的，别在清单里挂一个已经做完的空壳", () => {
    seed();
    const before = lay();
    updateTask("b", { done: true, doneAt: new Date().toISOString() });
    const pool = aliveTasks(appStore.getState().data).filter(
      (t) => !t.done && !t.droppedAt && t.id === "b",
    );
    expect(rowsOf(pinExpanded(lay(), before, "b", TASK_PIN, pool))).toEqual([
      "overdue: ",
      "today: a",
      "later: c",
      "nodate: d",
    ]);
  });
});

// ---------- 四个视图都得真接上，不然这套东西只有测试在用 ----------

describe("视图接线", () => {
  it("行的「谁是谁」只有一份（ROW_PIN 用的就是 rowKey）——认错行就等于没钉", () => {
    expect(rowListSource).toContain(
      "export const ROW_PIN: PinIds<DateRow> = { key: rowKey, taskId: (r) => r.task.id };",
    );
  });

  it("计划：先 planGroups 再 usePinExpanded，allRows / fold / anchor 全吃钉过的那份", () => {
    expect(planViewSource).toContain("const laid = useMemo(() => planGroups(rows, sortMode, today)");
    expect(planViewSource).toContain("const groups = usePinExpanded(laid, expandedId, ROW_PIN, pinPool);");
    expect(planViewSource).toContain("const allRows = useMemo(() => groups.flatMap((g) => g.rows), [groups]);");
    // 搜索筛着的时候得有兜底行池，否则卡里一改标题这件事就从页面上消失
    expect(planViewSource).toContain("openAll.filter((r) => r.task.id === expandedId)");
  });

  it("今天：两组一起钉，兜底行池给的是整份 openRows（改到明天时这两组一条都不剩）", () => {
    expect(todayViewSource).toContain('[{ key: "overdue", rows: overdue }, { key: "today", rows: todays }]');
    expect(todayViewSource).toContain("openRows(data).filter((r) => r.task.id === expandedId)");
    // 真画出去的必须是钉过的那份
    expect(todayViewSource).toContain("<RowList rows={overdueShown}");
    expect(todayViewSource).toContain("<RowList rows={todayShown}");
    expect(todayViewSource).toContain("const allRows = [...overdueShown, ...todayShown];");
    // 空态按真画出来的行算：钉在这儿的那一件已经不属于这两组了
    expect(todayViewSource).toContain("{allRows.length === 0 && doneToday.length === 0 && (");
  });

  it("已完成：钉的是这一轮真画出来的那份（shown），画的也是它", () => {
    expect(doneViewSource).toContain("const laid = groups.map((g) => ({ ...g, rows: g.shown }));");
    expect(doneViewSource).toContain("const pinned = usePinExpanded(laid, expandedId, DONE_PIN);");
    expect(doneViewSource).toContain("const shown = pinned.flatMap((g) => g.rows);");
    expect(doneViewSource).toContain("{g.rows.flatMap(renderRow)}");
    // 组标题那个数字照旧数整组（钉住只影响画面，不改「这一段有多少条」这个事实）
    expect(doneViewSource).toContain("{g.label} {g.items.length}");
  });

  it("清单/随手记/需求方/标签：组按语义名给 key，钉过的那份才是真画出去的", () => {
    // 用户报 bug 时最可能就在这个视图里（他的事大多挂在「工作」清单下）
    expect(listViewSource).toContain(
      "const LIST_PIN: PinIds<Task> = { key: (t) => t.id, taskId: (t) => t.id };",
    );
    expect(listViewSource).toContain('listGroups(tasks, today, kind === "inbox" ? "" : "未安排")');
    expect(listViewSource).toContain("const groups = usePinExpanded(laid, expandedId, LIST_PIN, pinPool);");
    // 组的 key 是组名不是下标——下标当 key，某一组一空后面全体错位，整片重挂
    expect(listViewSource).toContain("<Fragment key={g.key}>");
    expect(listViewSource).not.toContain("key={gi}");
    // 兜底行池：改了归属之后这四组里一行都不剩，得从没过滤的那一份里捞
    expect(listViewSource).toContain(
      "aliveTasks(data).filter((t) => !t.done && !t.droppedAt && t.id === expandedId)",
    );
    // 画的、连选的、空态判的，全是钉过的那一份
    expect(listViewSource).toContain("const shown = useMemo(() => groups.flatMap((g) => g.rows), [groups]);");
    expect(listViewSource).toContain("{g.rows.map((t) =>");
    expect(listViewSource).toContain("const orderedIds = useMemo(() => shown.map((t) => t.id), [shown]);");
    // v7 起回收站页还单列已删的子任务（subRows），空态得把它们也算上——但判的仍是钉过的 shown
    expect(listViewSource).toContain("{shown.length === 0 && subRows.length === 0 && (");
    // 空组照旧不画，但判的是钉过之后这一组还剩什么
    expect(listViewSource).toContain("{g.rows.length > 0 && g.label && (");
  });

  it("日历不用钉：卡片本来就画在网格外面那块固定的详情区，日子怎么改它都不挪窝", () => {
    expect(calendarViewSource).toContain('<div className="cal-detail">');
    expect(calendarViewSource).toContain("<TaskCard key={expanded.id} task={expanded} />");
    expect(calendarViewSource).not.toContain("usePinExpanded");
  });

  it("收起之后还要多钉一拍：卡片收起动画得先演完，行才好重排（时长跟 RowList 同一个来源）", () => {
    // RowList 那边收起的卡片也要在树上多活 cardMs() 那一拍。这边要是先松手，
    // 正在收的那张卡会连着它那一行凭空消失，收起就成了硬切
    expect(pinSource).toContain('import { cardMs } from "./motion";');
    expect(pinSource).toContain("setTimeout(() => setHeld(null), cardMs())");
    expect(rowListSource).toContain("setTimeout(() => setClosing(null), cardMs())");
  });

  it("上一版只在提交之后才记（渲染里读到的永远是真画出去的那一份）", () => {
    // 写在渲染里的话，被打断的渲染、StrictMode 重跑的那一遍都会污染「上一版」，
    // 位置就会照着一份根本没画出去的排布来钉
    expect(pinSource).toContain("const prev = useRef<G[] | null>(null);");
    expect(pinSource).toContain("prev.current = out;");
  });
});
