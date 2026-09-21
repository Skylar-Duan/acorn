// 桌面「顺延 ▾」菜单 + 右键「整件事」菜单（v1.15.x，用户 2026-09 三条需求）。
//   ① 顺延按钮点开可选 明天 / 本周末 / 下周末 / 本月末 / 选日期…（core/dates.postponePresets）
//   ② 过期的行行尾常驻「顺延 ▾」；收起的链头顺延的是这件事**所有过期的子任务**（store.overdueSubRows）
//   ③ 右键：「推到明天」收进「调整日期 ▸」（原「安排日期」），「今天」后面加一个明天（adjustDatePresets）；
//      代表整件事的那一行右键出的是整件事的菜单，日期 / 优先级改母任务
// 本周末 / 下周末按设置里的周末日算，跟记事语法「~周末 / ~下周末」逐天对过。

import { beforeEach, describe, expect, it } from "vitest";
import {
  addDays, adjustDatePresets, cmpYMD, dayOfWeek, duePresets, fromYMD, monthEnd, postponePresets, weekendOf,
} from "../src/core/dates";
import { parseQuickAdd } from "../src/core/parse";
import {
  appStore, flushSave, overdueSubRows, postponeRowsTo, rowDue, rowPriority, setTasksDue, undo, updateTask,
} from "../src/core/store";
import type { DateRow, UIState } from "../src/core/store";
import { defaultData, newTask } from "../src/core/model";
import type { Subtask, Task } from "../src/core/model";
import { todayYMD } from "../src/core/dates";
import { planFold, rowKey } from "../src/components/RowList";
import ctxSource from "../src/components/ContextMenu.tsx?raw";
import taskRowSource from "../src/components/TaskRow.tsx?raw";
import rowListSource from "../src/components/RowList.tsx?raw";
import postponeSource from "../src/components/PostponeMenu.tsx?raw";
import todaySource from "../src/views/Today.tsx?raw";
import appSource from "../src/App.tsx?raw";

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

/** 2026-08-17 是周一；往后排 14 天，周一到周日各走两遍 */
const MON = "2026-08-17";
const FORTNIGHT = Array.from({ length: 14 }, (_, i) => addDays(MON, i));

describe("weekendOf：跟记事语法「~周末 / ~下周末」逐天一致", () => {
  for (const wd of ["sun", "sat"] as const) {
    it(`周末日 = ${wd === "sun" ? "周日" : "周六"}：两周里每一天都对得上`, () => {
      for (const d of FORTNIGHT) {
        const now = fromYMD(d);
        now.setHours(10);
        const opts = { now, listNames: [], weekendDay: wd };
        expect(weekendOf(d, wd, 0), `${d} 周末`).toBe(parseQuickAdd("~周末 x", opts).due);
        expect(weekendOf(d, wd, 1), `${d} 下周末`).toBe(parseQuickAdd("~下周末 x", opts).due);
      }
    });
  }

  it("不给设置 = 周日（跟 settings 默认值同口径）", () => {
    expect(weekendOf(MON, undefined)).toBe("2026-08-23");
    expect(weekendOf(MON, undefined, 1)).toBe("2026-08-30");
  });
});

describe("postponePresets：明天 / 本周末 / 下周末 / 本月末", () => {
  it("平常的一天四项都在，按这个顺序", () => {
    // 周一 2026-08-17，周末日周日
    const ps = postponePresets(MON, "sun");
    expect(ps.map((p) => p.label)).toEqual(["明天", "本周末", "下周末", "本月末"]);
    expect(ps.map((p) => p.ymd)).toEqual(["2026-08-18", "2026-08-23", "2026-08-30", "2026-08-31"]);
  });

  it("周末日设成周六：本周末 / 下周末都落在周六", () => {
    const ps = postponePresets(MON, "sat");
    expect(ps.find((p) => p.key === "weekend")!.ymd).toBe("2026-08-22");
    expect(ps.find((p) => p.key === "nextWeekend")!.ymd).toBe("2026-08-29");
  });

  it("两种设置 × 两周每一天：全都落在今天之后、没有两项同一天", () => {
    for (const wd of ["sun", "sat"] as const) {
      for (const d of FORTNIGHT) {
        const ps = postponePresets(d, wd);
        for (const p of ps) expect(cmpYMD(p.ymd, d), `${d} ${wd} ${p.label}`).toBeGreaterThan(0);
        expect(new Set(ps.map((p) => p.ymd)).size, `${d} ${wd}`).toBe(ps.length);
        // 明天和下周末永远在
        expect(ps[0].key).toBe("tomorrow");
        expect(ps.some((p) => p.key === "nextWeekend"), `${d} ${wd}`).toBe(true);
        // 下周末永远是周末日那一天
        expect(dayOfWeek(ps.find((p) => p.key === "nextWeekend")!.ymd)).toBe(wd === "sat" ? 6 : 0);
      }
    }
  });

  it("今天就是周末日：不出「本周末」，只留「下周末」", () => {
    const sun = "2026-08-23";
    expect(postponePresets(sun, "sun").map((p) => p.key)).not.toContain("weekend");
    expect(postponePresets("2026-08-22", "sat").map((p) => p.key)).not.toContain("weekend");
  });

  it("周末日已经过了（周末日周六、今天周日）：也不出「本周末」", () => {
    const ps = postponePresets("2026-08-23", "sat");
    expect(ps.map((p) => p.key)).not.toContain("weekend");
    expect(ps.find((p) => p.key === "nextWeekend")!.ymd).toBe("2026-08-29");
  });

  it("周六点开、周末日周日：本周末 = 明天，只留「明天」", () => {
    const ps = postponePresets("2026-08-22", "sun");
    expect(ps.map((p) => p.key)).toEqual(["tomorrow", "nextWeekend", "monthEnd"]);
  });

  it("月底：最后一天不出「本月末」（不落回今天），倒数第二天本月末 = 明天也不出", () => {
    expect(postponePresets("2026-08-31", "sun").map((p) => p.key)).not.toContain("monthEnd");
    expect(postponePresets("2026-08-30", "sun").map((p) => p.key)).not.toContain("monthEnd");
    // 倒数第三天还在
    expect(postponePresets("2026-08-29", "sun").find((p) => p.key === "monthEnd")!.ymd).toBe(monthEnd("2026-08-29"));
  });

  it("跨年：12 月 31 日的明天是 1 月 1 日，下周末跨进新年", () => {
    const ps = postponePresets("2026-12-31", "sun");
    expect(ps[0].ymd).toBe("2027-01-01");
    expect(ps.find((p) => p.key === "nextWeekend")!.ymd).toBe("2027-01-10");
    expect(ps.find((p) => p.key === "weekend")!.ymd).toBe("2027-01-03");
  });
});

describe("adjustDatePresets：右键「调整日期 ▸」= 安排日期那一套 + 今天后面一个明天", () => {
  it("今天、明天打头，后面接 duePresets 剩下的", () => {
    const ps = adjustDatePresets(MON);
    expect(ps.map((p) => p.label)).toEqual(["今天", "明天", "本周五", "本周日", "本月末"]);
    expect(ps[1].ymd).toBe(addDays(MON, 1));
  });

  it("明天撞上后面某项（周四：本周五 = 明天）就不重复出现", () => {
    const thu = "2026-08-20";
    const ps = adjustDatePresets(thu);
    expect(ps.map((p) => p.label)).toEqual(["今天", "明天", "本周日", "本月末"]);
    expect(new Set(ps.map((p) => p.ymd)).size).toBe(ps.length);
  });

  it("duePresets 本身一个字没动：安排日期那五处照旧不带明天", () => {
    for (const d of FORTNIGHT) expect(duePresets(d).map((p) => p.label)).not.toContain("明天");
  });
});

// ---------------------------------------------------------------------------
// store：postponeRowsTo / overdueSubRows
// ---------------------------------------------------------------------------

function sub(id: string, patch: Partial<Subtask> = {}): Subtask {
  return { id, title: id, done: false, due: null, dueTime: null, priority: null, ...patch };
}
function seed(tasks: Task[]) {
  appStore.setState({ data: { ...defaultData(), tasks } });
}
function get(id: string): Task {
  return appStore.getState().data.tasks.find((t) => t.id === id)!;
}

beforeEach(async () => {
  while (appStore.getState().undoDepth > 0) undo();
  await flushSave();
  localStorage.clear();
  appStore.setState({
    data: defaultData(),
    loaded: true,
    loadError: null,
    ui: {
      view: "today", listId: null, who: null, tag: null,
      expandedId: null, selectedIds: [], searchOpen: false, paletteOpen: false, toast: null,
      ctxMenu: null, foldAll: false, foldExcept: [], changelogOpen: false, quickAddOpen: false,
    },
    saveError: null,
    webNewVersion: null,
    focus: { taskId: null, running: false, endsAt: null, totalMinutes: 0 },
    undoDepth: 0,
  });
});

describe("postponeRowsTo：顺延到选定的那一天", () => {
  it("母任务行：日期落到选的那天，往后挪了才 +1 顺延，提醒跟到新日子", () => {
    const today = todayYMD();
    const late = newTask({ title: "逾期", due: addDays(today, -2), dueTime: "09:00" });
    const none = newTask({ title: "没日期" });
    const far = newTask({ title: "本来在后面", due: addDays(today, 30) });
    seed([late, none, far]);
    const to = addDays(today, 5);
    postponeRowsTo([late, none, far].map((t) => ({ task: t, sub: null })), to);
    expect(get(late.id).due).toBe(to);
    expect(get(late.id).postponeCount).toBe(1);
    expect(get(late.id).reminder).toBe(`${to}T09:00`);
    // 从无到有不算顺延
    expect(get(none.id).due).toBe(to);
    expect(get(none.id).postponeCount).toBe(0);
    // 改早了也不算
    expect(get(far.id).due).toBe(to);
    expect(get(far.id).postponeCount).toBe(0);
  });

  it("一次只数一次、只压一张撤销快照；弹「已顺延 N 项」可撤销", () => {
    const today = todayYMD();
    const a = newTask({ title: "a", due: addDays(today, -1) });
    const b = newTask({ title: "b", due: addDays(today, -1) });
    seed([a, b]);
    const depth = appStore.getState().undoDepth;
    postponeRowsTo([{ task: a, sub: null }, { task: b, sub: null }], addDays(today, 1));
    expect(appStore.getState().undoDepth).toBe(depth + 1);
    expect(get(a.id).postponeCount).toBe(1);
    const toast = appStore.getState().ui.toast!;
    expect(toast.msg).toBe("已顺延 2 项");
    expect(toast.undoable).toBe(true);
    undo();
    expect(get(a.id).due).toBe(addDays(today, -1));
    expect(get(b.id).due).toBe(addDays(today, -1));
    expect(get(a.id).postponeCount).toBe(0);
  });

  it("子任务行只改这一条：继承来的日期先落成自己的，钟点照继承；母任务和兄弟一个字都不动", () => {
    const today = todayYMD();
    const t = newTask({
      title: "装修", due: addDays(today, -3), dueTime: "10:00",
      subtasks: [sub("s1"), sub("s2"), sub("s3", { due: addDays(today, -1) })],
    });
    seed([t]);
    const to = addDays(today, 2);
    postponeRowsTo([{ task: t, sub: t.subtasks[0] }], to);
    const after = get(t.id);
    expect(after.subtasks[0].due).toBe(to);
    expect(after.subtasks[0].dueTime).toBe("10:00");
    expect(after.subtasks[1]).toEqual(t.subtasks[1]);
    expect(after.subtasks[2]).toEqual(t.subtasks[2]);
    expect(after.due).toBe(t.due);
    expect(after.postponeCount).toBe(0);
  });

  it("不认识的字段原样留着", () => {
    const today = todayYMD();
    const t = { ...newTask({ title: "x", due: addDays(today, -1) }), futureField: 42 } as Task;
    seed([t]);
    postponeRowsTo([{ task: t, sub: null }], addDays(today, 1));
    expect((get(t.id) as Task & { futureField: number }).futureField).toBe(42);
  });

  it("空的一组什么都不做（不压快照、不弹提示）", () => {
    const depth = appStore.getState().undoDepth;
    postponeRowsTo([], "2030-01-01");
    expect(appStore.getState().undoDepth).toBe(depth);
    expect(appStore.getState().ui.toast).toBeNull();
  });
});

describe("overdueSubRows：收起的链头点顺延，推的是这件事所有过期的子任务", () => {
  it("只挑过期、没做完、没放弃、没删的；继承母任务日期的也算", () => {
    const today = todayYMD();
    const t = newTask({
      title: "季度复盘", due: addDays(today, -5),
      subtasks: [
        sub("inherit"), // 继承母任务的 -5 天 → 过期
        sub("own-late", { due: addDays(today, -1) }),
        sub("future", { due: addDays(today, 3) }),
        sub("today", { due: today }),
        sub("done", { due: addDays(today, -1), done: true }),
        sub("dropped", { due: addDays(today, -1), droppedAt: "2026-01-01T00:00:00.000Z" }),
        sub("trashed", { due: addDays(today, -1), deletedAt: "2026-01-01T00:00:00.000Z" }),
      ],
    });
    expect(overdueSubRows(t, today).map((r) => r.sub!.id)).toEqual(["inherit", "own-late"]);
  });

  it("配 postponeRowsTo：过期的几条一起挪走，没过期的原地不动", () => {
    const today = todayYMD();
    const t = newTask({
      title: "搬家", due: null,
      subtasks: [sub("a", { due: addDays(today, -2) }), sub("b", { due: addDays(today, -1) }), sub("c", { due: addDays(today, 4) })],
    });
    seed([t]);
    const to = addDays(today, 1);
    postponeRowsTo(overdueSubRows(get(t.id), today), to);
    const after = get(t.id);
    expect(after.subtasks.map((s) => s.due)).toEqual([to, to, addDays(today, 4)]);
    expect(appStore.getState().ui.toast!.msg).toBe("已顺延 2 项");
  });
});

// ---------------------------------------------------------------------------
// 右键「整件事」：改的是母任务，还在继承的子任务跟着变，自己设过的不动
// ---------------------------------------------------------------------------

describe("整件事的菜单改母任务：继承的跟着变，子任务字段一个都不写", () => {
  it("改日期 / 重要性走 setTasksDue / updateTask(母任务)", () => {
    const today = todayYMD();
    const t = newTask({
      title: "出差", due: addDays(today, 1), priority: 1,
      subtasks: [sub("inherit"), sub("own", { due: addDays(today, 9), priority: 3 })],
    });
    seed([t]);
    setTasksDue([t.id], addDays(today, 4));
    updateTask(t.id, { priority: 2 });
    const after = get(t.id);
    // 子任务一个字段都没被写
    expect(after.subtasks).toEqual(t.subtasks);
    const [inh, own] = after.subtasks.map((s): DateRow => ({ task: after, sub: s }));
    expect(rowDue(inh)).toBe(addDays(today, 4));
    expect(rowPriority(inh)).toBe(2);
    expect(rowDue(own)).toBe(addDays(today, 9));
    expect(rowPriority(own)).toBe(3);
  });
});

describe("planFold.solo：一件事整页只露出一行时，那一行代表整件事", () => {
  const ui = (foldAll: boolean) => ({ foldAll, foldExcept: [] }) as unknown as UIState;

  it("只有一条子任务行 → solo；有链的不进 solo", () => {
    const one = newTask({ title: "买牛奶", subtasks: [sub("x")] });
    const many = newTask({ title: "装修", subtasks: [sub("a"), sub("b")] });
    const rows: DateRow[] = [
      { task: one, sub: one.subtasks[0] },
      ...many.subtasks.map((s) => ({ task: many, sub: s })),
    ];
    const fold = planFold(rows, ui(true));
    expect([...fold.solo]).toEqual([rowKey(rows[0])]);
    // 收起的链头在 more 里（右键同样出整件事的菜单）
    expect(fold.more.has(rowKey(rows[1]))).toBe(true);
    // 摊开以后链头不再代表整件事
    expect(planFold(rows, ui(false)).more.size).toBe(0);
  });

  it("RowList 把「收起的链头 或 solo」交给 TaskRow 的 whole", () => {
    expect(rowListSource).toContain("whole={fold.more.has(key) || fold.solo.has(key)}");
  });
});

// ---------------------------------------------------------------------------
// 源码守卫：入口换成「顺延 ▾」、右键菜单改口
// ---------------------------------------------------------------------------

describe("入口：三处都是同一个「顺延 ▾」", () => {
  it("今天页逾期组：桌面是「全部顺延」，推的是整组逾期行；手机照旧（这次不动手机）", () => {
    const src = stripComments(todaySource);
    const head = src.slice(src.indexOf('<span className="group-label">逾期'), src.indexOf("<RowList rows={overdueShown}"));
    expect(head).toMatch(/\{isMobile \? \(\s*<button className="act" onClick=\{\(\) => postponeRows\(overdue\)\}>\s*全部推到明天 →/);
    expect(head).toContain('<PostponeButton className="act" label="全部顺延" getRows={() => overdue} />');
  });

  it("多选浮条：「顺延」，不再是「推到明天」", () => {
    const bar = stripComments(appSource.slice(appSource.indexOf('className={`bulk-bar'), appSource.indexOf("移到清单")));
    expect(bar).toContain("<PostponeButton");
    expect(bar).toContain('label="顺延"');
    expect(bar).not.toContain("推到明天");
  });

  it("Ctrl+→ 一个字没动：照旧 postponeTasks（原日期加一天）", () => {
    expect(appSource).toContain('mod && e.key === "ArrowRight" && selectedIds.length');
    expect(appSource).toContain("postponeTasks(selectedIds);");
  });

  it("菜单只走 postponePresets + 一次落库的 postponeRowsTo；选日期那项用 DateField、只记草稿", () => {
    expect(postponeSource).toContain("postponePresets(today, weekendDay)");
    expect(postponeSource).toContain("postponeRowsTo(rows, ymd)");
    expect(postponeSource).toContain("<DateField");
    // 日期框停手时只记在本地，不落库
    const onCommit = postponeSource.slice(postponeSource.indexOf("onCommit={(v) => {"), postponeSource.indexOf("确定"));
    expect(onCommit).not.toContain("postponeRowsTo");
    expect(onCommit).not.toContain("setTasksDue");
    // 画到 body 上，不会被行裁掉
    expect(postponeSource).toContain("createPortal(");
    expect(postponeSource).toContain("document.body");
  });

  it("行尾按钮：只在桌面、过期、不是只留日期的行尾；收起的链头推整件事过期的子任务", () => {
    expect(taskRowSource).toContain(
      "const showPostpone = !isMobile && !dateOnlyTail && !doneDate && (overdue || headOverdue.length > 0);",
    );
    expect(taskRowSource).toContain("getRows={() => (foldedHead ? overdueSubRows(task) : [row])}");
    // Ctrl / Shift 点它照旧连选
    expect(taskRowSource).toContain("intercept={multiSelect}");
    // 点它不冒泡成打开任务卡
    expect(postponeSource).toContain("e.stopPropagation();");
  });
});

describe("右键菜单：推到明天收进「调整日期」，代表整件事的行出整件事的菜单", () => {
  const code = stripComments(ctxSource);

  it("单独那一项「推到明天」两个菜单都删了", () => {
    expect(code).not.toContain("推到明天");
    expect(code).not.toContain("postponeTasks(");
    expect(code).not.toContain("postponeRows(");
  });

  it("「安排日期」改名「调整日期」（任务、子任务两个都改），候选走 adjustDatePresets", () => {
    expect(code).not.toContain("安排日期");
    expect(code.match(/调整日期<span className="ctx-caret">▸<\/span>/g) ?? []).toHaveLength(2);
    expect(code).toContain("调整日期");
    expect(code.match(/adjustDatePresets\(today\)\.map\(/g) ?? []).toHaveLength(2);
    expect(code).not.toContain("duePresets(");
  });

  it("整件事的菜单：标题写「整件事 · 名字」；TaskRow 按 whole 分流", () => {
    expect(code).toContain("整件事 · ");
    expect(taskRowSource).toContain("if (sub && !whole) {");
    expect(taskRowSource).toContain("openCtxMenu(x, y, ids, null, { whole: !!sub && ids.length === 1 });");
  });

  it("整件事的菜单里日期 / 优先级改的是母任务（setTasksDue / updateTask），不碰 updateSubtask", () => {
    const menu = code.slice(code.indexOf("function Menu("));
    expect(menu).toContain("setTasksDue(ids, p.ymd)");
    expect(menu).toContain("updateTask(id, { priority: p })");
    expect(menu).not.toContain("updateSubtask");
  });
});
