// v1.9.0 续跑复核挑出来的「回执 / 提交 / 丢弃」那一组毛病，逐条钉住。
// 都是交互上的事，没有 DOM 可跑，按 wipe.test.ts / dropped.test.ts 那个路数读源码钉结构。
// 每个 describe 的标题就是当初那条发现。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// 全仓的 .tsx 要按目录现读一遍（写死清单就会漏掉「下次又新加一个日期框」那种），
// ?raw 只能一个个点名，所以这儿用 node:fs
import { readdirSync, readFileSync, statSync } from "node:fs";
import taskCardSource from "../src/components/TaskCard.tsx?raw";
import dateFieldSource from "../src/components/DateField.tsx?raw";
import datesSource from "../src/core/dates.ts?raw";
import syntaxInputSource from "../src/components/SyntaxInput.tsx?raw";
import guideSource from "../src/components/GuideContent.tsx?raw";
import sidebarSource from "../src/components/Sidebar.tsx?raw";
import quickAddSource from "../src/components/QuickAddBar.tsx?raw";
import ctxMenuSource from "../src/components/ContextMenu.tsx?raw";
import calendarSource from "../src/views/Calendar.tsx?raw";
import habitsSource from "../src/views/Habits.tsx?raw";
import listViewSource from "../src/views/ListView.tsx?raw";
import settingsSource from "../src/views/Settings.tsx?raw";
import { isPlausibleYMD } from "../src/core/dates";
import { DATE_COMMIT_MS, makeDateCommitter } from "../src/core/dateinput";
import { defaultData } from "../src/core/model";
import type { Task } from "../src/core/model";
import storeSource from "../src/core/store.ts?raw";
import {
  addTask, appStore, completeTask, flushSave, setTasksDue, undo, updateTask,
} from "../src/core/store";

function getTask(id: string): Task {
  const t = appStore.getState().data.tasks.find((x) => x.id === id);
  if (!t) throw new Error(`task ${id} not found in store`);
  return t;
}

/** `src` 底下**递归**收到的每一个 .tsx（路径, 内容）。
 *  以前这儿写死了 `src/components` 和 `src/views` 两个目录、还是非递归的，
 *  于是 `src/windows/*.tsx`（quickadd / focus / guide 三个独立小窗）整个在扫描范围之外——
 *  哪天在浮窗里加一个日期框，下面那三条规矩一条都管不着，测试还照样全绿。
 *  递归着收，顺带把以后新开的子目录一起罩住 */
function collectTsx(dir: string): [string, string][] {
  return readdirSync(dir).flatMap((name: string): [string, string][] => {
    const p = `${dir}/${name}`;
    if (statSync(p).isDirectory()) return collectTsx(p);
    return name.endsWith(".tsx") ? [[p, readFileSync(p, "utf8")]] : [];
  });
}
const allTsx: [string, string][] = collectTsx("src");

/** 一份源码里每一个 `<DateField … />` 的整段（含它的注释和回调）。
 *  日期框全仓只此一个件，调用点都长这个样 */
function dateFieldsIn(src: string): string[] {
  const out: string[] = [];
  // `\b` 单靠 indexOf 拦不住 `useRef<DateFieldHandle | null>` 那种，得让标签名到此为止
  const tag = /<DateField(?=[\s/>])/g;
  for (let m = tag.exec(src); m; m = tag.exec(src)) {
    const end = src.indexOf("/>", m.index);
    if (end === -1) throw new Error(`抓不全这个 DateField：${src.slice(m.index, m.index + 120)}`);
    out.push(src.slice(m.index, end + 2));
    tag.lastIndex = end;
  }
  return out;
}

// 只有下面「年份段」那一组真动 store，其余全是读源码；照 store.test.ts 那套重置
beforeEach(async () => {
  while (appStore.getState().undoDepth > 0) undo();
  await flushSave();
  localStorage.clear();
  appStore.setState({ data: defaultData(), loaded: true, loadError: null, undoDepth: 0 });
});

/** 任务卡「需求方」那个内联框的整段（含它的三个事件）。
 *  收尾记号用下一块「优先级」——onBlur 那行现在包了一层窗口判据，不再是个能拿来定位的字面量 */
const whoInput = taskCardSource.slice(
  taskCardSource.indexOf("ref={whoInputRef}"),
  taskCardSource.indexOf("{/* 优先级 */}"),
);
/** 任务卡「标签」那个内联框的整段 */
const tagInput = taskCardSource.slice(
  taskCardSource.indexOf("ref={tagInputRef}"),
  taskCardSource.indexOf("{/* 放弃和删除"),
);

describe("Esc 得关得掉任务卡：两个内联框只在真有东西可丢弃时才吞这一下", () => {
  it("需求方框：框里有字才 stopPropagation，空框上的 Esc 放行去收卡片", () => {
    expect(whoInput).toContain("if (el.value) {");
    // 整段里只有一处吞按键，而且它在那个条件里面
    expect(whoInput.split("e.stopPropagation()").length - 1).toBe(1);
    expect(whoInput.indexOf("if (el.value) {")).toBeLessThan(whoInput.indexOf("e.stopPropagation()"));
  });

  it("标签框：跟这件事现在的标签不一样才吞这一下，一样就放行", () => {
    expect(tagInput).toContain("if (el.value !== cur) {");
    expect(tagInput.split("e.stopPropagation()").length - 1).toBe(1);
    expect(tagInput.indexOf("if (el.value !== cur) {")).toBeLessThan(tagInput.indexOf("e.stopPropagation()"));
  });

  it("口径跟同一批里别处一致：onEscape 没东西可丢就返回 false 放行", () => {
    expect(taskCardSource).toContain("if (!newSub) return false;");
    expect(taskCardSource).toContain("if (live === baseText) return false;");
  });
});

describe("「需求方」不许被提交两次：回车 / 失焦 / 点卡外只认第一次", () => {
  it("三条路共用 commitWho 这一个出口，落完就把非受控框清空", () => {
    const commitWho = taskCardSource.slice(
      taskCardSource.indexOf("function commitWho"),
      taskCardSource.indexOf("function flushPending"),
    );
    expect(commitWho).toContain("if (!el || whoSettled.current) return;");
    expect(commitWho).toContain("whoSettled.current = true;");
    expect(commitWho).toContain('el.value = "";');
    expect(whoInput).toContain("commitWho();");
    expect(taskCardSource).toContain("onBlur={() => { if (document.hasFocus()) commitWho(); }}");
  });

  it("点卡外那条路（flushPending）不再自己写库，两个内联框都走各自那个闸门", () => {
    const flush = taskCardSource.slice(
      taskCardSource.indexOf("function flushPending"),
      taskCardSource.indexOf("flushRef.current = flushPending;"),
    );
    expect(flush).toContain('if (menu === "who") commitWho();');
    expect(flush).toContain('if (menu === "tags") commitTags();');
    expect(flush).not.toContain("addTasksWho");
    expect(flush).not.toContain("updateTask(task.id, { tags");
  });

  it("标签框是同一条路数（点卡外一次、紧接着失焦又一次），同样只认第一次", () => {
    const commitTags = taskCardSource.slice(
      taskCardSource.indexOf("function commitTags"),
      taskCardSource.indexOf("function flushPending"),
    );
    expect(commitTags).toContain("if (!el || tagsSettled.current) return;");
    expect(commitTags).toContain("tagsSettled.current = true;");
    expect(tagInput).toContain("onBlur={() => { if (document.hasFocus()) commitTags(); }}");
    expect(tagInput).toContain("onChange={() => { tagsSettled.current = false; }}");
  });

  it("又打字 / 又聚焦就把闸门放回去，接着加下一个人", () => {
    expect(whoInput).toContain("onChange={() => { whoSettled.current = false; }}");
    expect(whoInput).toContain("onFocus={() => { whoSettled.current = false; }}");
  });
});

describe("回执不许说谎：什么都没存就不闪 ✓", () => {
  it("「＋子任务」照实汇报——只打了日期没打标题时一条都没加，也就没有回执", () => {
    expect(taskCardSource).toContain("function addSubFromInput(): boolean");
    expect(taskCardSource).toContain("if (!title) return false;");
    expect(taskCardSource).toContain("onBlurCommit={() => addSubFromInput()}");
  });

  it("flash 的决定权交给调用方：明说「没存」的那一下不闪", () => {
    expect(syntaxInputSource).toContain("onSubmit: (parsed: ParseResult) => boolean | void;");
    expect(syntaxInputSource).toContain("const stored = onSubmit(p);");
    expect(syntaxInputSource).toContain("if (stored !== false && value.trim()) flash();");
  });

  it("用法页那个「试写」框明说不落库，就不许给回执", () => {
    expect(guideSource).toContain("不会创建任务");
    expect(guideSource).toContain("onSubmit={() => false}");
  });
});

describe("日期弹层：原生 date 控件填到一半的空串不算「改成了没有日期」", () => {
  it("只认完整值，清日期由「清除日期」那个按钮承担", () => {
    // 判据统一在 DateField 里：空串（三段没填满）过不了 isPlausibleYMD 这道闸，一个字都不落
    expect(dateFieldSource).toContain("if (!isPlausibleYMD(v)) return;");
    expect(isPlausibleYMD("")).toBe(false);
    expect(taskCardSource).toContain("清除日期");
  });
});

// ---------------------------------------------------------------------------
// 年份段的左移中间值（v1.9.0 收口）。空串那道闸挡不住它们：
// Chromium 的年份段是**累加**的，焦点落在年份上敲 2/0/2/7，段内依次显示
// 0002 → 0020 → 0202 → 2027，每一下都发一次 change，而三段都填着的时候
// value 是「0002-09-10」这种**格式合法的完整日期**，`if (!v) return;` 一个都拦不住。
// ---------------------------------------------------------------------------

describe("日期弹层：年份段还在累加的那几拍不许落库", () => {
  /** 敲「2027」这四下，原生控件依次吐出来的四个 value（末位才是用户真想要的） */
  const TYPING_2027 = ["0002-09-10", "0020-09-10", "0202-09-10", "2027-09-10"];

  it("isPlausibleYMD：四位年的中间态全部拒掉，正经日子照常放行", () => {
    expect(TYPING_2027.map(isPlausibleYMD)).toEqual([false, false, false, true]);
    // 四位年的中间态最大只到 299（floor(2999/10)），这一格必定罩得住
    for (let y = 1000; y <= 2999; y++) {
      const v = `${y}-09-10`;
      expect(isPlausibleYMD(v), v).toBe(y >= 1900);
      expect(isPlausibleYMD(`${Math.floor(y / 10)}`.padStart(4, "0") + "-09-10"), v).toBe(false);
    }
    // 空串、半截、非法格式一律不算
    for (const bad of ["", "2026-09", "2026/09/10", "20260910", "abcd-09-10", "3000-01-01"]) {
      expect(isPlausibleYMD(bad), bad).toBe(false);
    }
  });

  it("逐段敲年份：due 只改一次，postponeCount 只 +1（不是 +3）", () => {
    const id = addTask({ title: "写周报", due: "2026-09-10" });
    expect(getTask(id).postponeCount).toBe(0);

    // 照抄弹层那个 onChange 的判断顺序：空串挡掉、中间态挡掉、剩下的才落库
    for (const v of TYPING_2027) {
      if (!v) continue;
      if (!isPlausibleYMD(v)) continue;
      updateTask(id, { due: v, dueTime: null });
    }

    const t = getTask(id);
    expect(t.due).toBe("2027-09-10");
    expect(t.postponeCount).toBe(1); // 用户就顺延了这一次
    // 中间那三个公元 2 年 / 20 年 / 202 年一个都没落过盘
    expect(isPlausibleYMD(t.due ?? "")).toBe(true);
  });

  it("反证：不装这道闸就是 postponeCount 净加 3、行上凭空挂出「顺延×3」", () => {
    const id = addTask({ title: "写周报", due: "2026-09-10" });
    for (const v of TYPING_2027) updateTask(id, { due: v, dueTime: null });
    // 0002→0020→0202→2027 三次都是「变晚了」，各加一次
    expect(getTask(id).postponeCount).toBe(3);
    expect(getTask(id).postponeCount >= 2).toBe(true); // TaskRow 那个警告标的判据当场成立
  });

  it("全仓不许再有裸的 <input type=\"date\">：日期框只此一个（DateField），四处调用点全用它", () => {
    // ——这一条是**类**，不是实例。上一版写的是「每个 date 框都得有草稿」，还顺手把非受控的
    // 整段豁免了（`if (!el.includes("value={")) continue;`）；全仓唯一一个非受控、又一凑齐
    // 就当场落库并关窗的，正是侧栏「拖到计划」那个框，于是它永远测不到——同一个病能连着复发
    // 四轮、每轮都在下一个地方，靠的就是这种「规矩窄化成实例」的豁免。
    // 现在改成：**日期框只能从 DateField 出**，谁再手写一个，这条当场红。
    const bare = allTsx
      .filter(([name, src]) => src.includes('type="date"') && !name.endsWith("/DateField.tsx"))
      .map(([name]) => name);
    expect(bare, '日期框一律用 DateField，别再手写 <input type="date">').toEqual([]);

    // 组件自己那一处：**草稿 → 闸门 → 去抖**，三件套齐全且顺序不许变
    const input = dateFieldSource.slice(dateFieldSource.lastIndexOf("<input"));
    // ① 本地草稿：中间值先无条件写进去。不显它，受控输入会被 React 每敲一下复原一次，
    //    键盘就再也敲不动年份段了
    expect(input).toContain("value={focused ? draft : value}");
    expect(input).toContain("setDraft(v);");
    // ② 闸门：年份段那几拍的中间值一律不放行。判据只有一份，在 core/dates 里
    expect(input.indexOf("setDraft(v);"), "草稿得写在闸门前面，不然中间值没地方待")
      .toBeLessThan(input.indexOf("isPlausibleYMD(v)"));
    // ③ 去抖：过了闸也不当场落，一串连打并成一次
    expect(input.indexOf("isPlausibleYMD(v)")).toBeLessThan(input.indexOf("committer.schedule(v)"));
    expect(datesSource).toContain("export function isPlausibleYMD");
    // 落库那句只落库：收弹层是调用方的事（onDone），绝不许写进 onChange / 去抖回调
    const onChange = input.slice(input.indexOf("onChange={"), input.indexOf("onBlur={"));
    expect(onChange).not.toContain("doneRef");
    expect(onChange).not.toContain("setMenu");

    // 七处调用点：任务卡两个（日期弹层 / 子任务日期小签）、侧栏一个、随手记一个，
    // v1.11.0 起手机端三张抽屉各一个（长按的动作单 / 任务详情的日期段 / 记一条的日期段）。
    // 数字对不上就是新加了一个日期框——它已经被上面那三件套罩住了，改这个数就行
    const spots = allTsx.flatMap(([name, src]) => dateFieldsIn(src).map(() => name));
    expect(spots.length).toBe(7);
    expect([...new Set(spots)].sort()).toEqual([
      "src/components/QuickAddBar.tsx",
      "src/components/Sidebar.tsx",
      "src/components/TaskCard.tsx",
      "src/mobile/ActionSheet.tsx",
      "src/mobile/QuickAddSheet.tsx",
      "src/mobile/TaskSheet.tsx",
    ]);
    // 扫描范围本身也钉一下：三个独立小窗和 src 根上那两个必须在名单里。
    // 少了任何一个就是收 .tsx 那段又退回成「写死目录 + 非递归」了，
    // 于是「浮窗里新加一个日期框」会重新变成一条测不到的路
    const scanned = allTsx.map(([n]) => n);
    for (const must of [
      "src/App.tsx",
      "src/windows/quickadd.tsx",
      "src/windows/focus.tsx",
      "src/windows/guide.tsx",
    ]) {
      expect(scanned, `扫描范围漏了 ${must}`).toContain(must);
    }
  });

  it("四处调用点一个都不许把「收弹层」挂在落库回调里（第四轮那个 bug 的类）", () => {
    for (const [name, src] of allTsx) {
      for (const el of dateFieldsIn(src)) {
        const commit = el.slice(
          el.indexOf("onCommit={"),
          el.includes("onDone={") ? el.indexOf("onDone={") : el.length,
        );
        // 落库回调里出现这些 = 用户敲到一半框就被拆掉，后面的键全落空
        for (const forbidden of ["setMenu(null)", "setSubMenu(null)", "setPendingPlan(null)"]) {
          expect(commit, `${name}: onCommit 里不许收弹层（${forbidden}）`).not.toContain(forbidden);
        }
      }
    }
    // 侧栏那处尤其要盯：planTo 默认是「设好并收弹层」（点预设走这条），
    // 日期框那条必须显式传 false，只落库不收窗
    expect(sidebarSource).toContain("onCommit={(ymd) => planTo(ymd, false)}");
    // 收弹层挂在 onDone 上，但焦点还在这个弹层里的时候不许收（见下面那一组）
    expect(sidebarSource).toContain('if (next && next.closest(".side-plan-pop")) return;');
    expect(sidebarSource).toContain("setPendingPlan(null);");
    expect(sidebarSource).toContain("const planTo = (due: string, close = true) => {");
    expect(sidebarSource).toContain("if (close) setPendingPlan(null);");
    // 点弹层外 = 点走（先把欠着的落了再收）；Esc = 丢弃（那一次作废）
    expect(sidebarSource).toContain("planFieldRef.current?.flush();");
    expect(sidebarSource).toContain("planFieldRef.current?.cancel();");
  });
});

// ---------------------------------------------------------------------------
// 月段和日段的中间值（v1.9.0 收口 · 同一个洞的另一半）。
// 上面那道闸对它们**完全无效**：Chromium 的月/日段同样是累加的，而中间值全是四位年、
// 格式合法、年份也合法。别再指望补判据——月/日段本来就没有「不可能的中间值」可判。
// 改的是「落几次」：一次键盘编辑 = 一次落库（core/dateinput.ts 那个去抖）。
// ---------------------------------------------------------------------------

describe("日期弹层：月/日段一路累加出来的中间值，一次都不许落盘", () => {
  /** 用键盘把 2026-09-10 改成 2026-10-15：月段敲「1」「0」、日段敲「1」「5」，
   *  原生控件依次吐出来的四个 value（末位才是用户真想要的那天） */
  const TYPING_1015 = ["2026-01-10", "2026-10-10", "2026-10-01", "2026-10-15"];

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("先钉住前提：这四个值 isPlausibleYMD 全部放行——白名单救不了这条路", () => {
    expect(TYPING_1015.map(isPlausibleYMD)).toEqual([true, true, true, true]);
  });

  it("四拍连发只落一次库：postponeCount 只 +1、due 是最后那个、中间两个假日期一次都没进过盘", () => {
    const id = addTask({ title: "写周报", due: "2026-09-10" });
    expect(getTask(id).postponeCount).toBe(0);

    // 照抄弹层那个 onChange 的三步：空串挡掉 → 过闸 → **排一次去抖**（不是当场落库）
    const committer = makeDateCommitter((ymd) => {
      if (ymd !== (getTask(id).due ?? "")) updateTask(id, { due: ymd, dueTime: null });
    });
    function onChange(v: string) {
      if (!v) return;
      if (!isPlausibleYMD(v)) return;
      committer.schedule(v);
    }

    // 库里这件事的 due 每变一次就记一笔——假日期哪怕只闪进去一拍也会留下痕迹
    const seen: (string | null)[] = [];
    const unsub = appStore.subscribe((s) => {
      const t = s.data.tasks.find((x) => x.id === id);
      if (t) seen.push(t.due);
    });

    for (const v of TYPING_1015) {
      onChange(v);
      vi.advanceTimersByTime(60); // 打字的手速，四拍都在一个去抖窗口里
    }
    expect(seen, "还在敲的时候一个字都不许落").toEqual([]);
    vi.advanceTimersByTime(DATE_COMMIT_MS); // 停手
    unsub();

    const t = getTask(id);
    expect(t.due).toBe("2026-10-15");
    expect(t.postponeCount).toBe(1); // 用户就挪了这一次
    // 中间那两个假日期一次都没落过盘（也就不会把提醒重算成过去时刻、被 sweep 撞出假通知）
    expect(seen).not.toContain("2026-01-10");
    expect(seen).not.toContain("2026-10-01");
    expect([...new Set(seen)]).toEqual(["2026-10-15"]);
  });

  it("反证：不装这道去抖就是四拍逐个落库、postponeCount 净加 2，「顺延×2」当场成立", () => {
    const id = addTask({ title: "写周报", due: "2026-09-10" });
    for (const v of TYPING_1015) updateTask(id, { due: v, dueTime: null });
    // 2026-01-10 早、10-10 晚(+1)、10-01 早、10-15 晚(+1)
    expect(getTask(id).postponeCount).toBe(2);
    expect(getTask(id).postponeCount >= 2).toBe(true); // TaskRow 那个「顺延×2」的判据
    expect(getTask(id).due).toBe("2026-10-15");
  });

  it("鼠标点日历格那条路不受影响：一次 change 就到位，停手照样落", () => {
    const id = addTask({ title: "写周报", due: "2026-09-10" });
    const committer = makeDateCommitter((ymd) => updateTask(id, { due: ymd, dueTime: null }));
    committer.schedule("2026-10-15");
    vi.advanceTimersByTime(DATE_COMMIT_MS);
    expect(getTask(id).due).toBe("2026-10-15");
    expect(getTask(id).postponeCount).toBe(1);
  });

  it("去抖器本身：欠着的只有一次，flush 是提前做掉、cancel 是作废", () => {
    const got: string[] = [];
    const c = makeDateCommitter((v) => got.push(v));

    c.schedule("2026-10-10");
    c.schedule("2026-10-15");
    expect(c.pending()).toBe("2026-10-15");
    c.flush();
    expect(got).toEqual(["2026-10-15"]); // 只落最后那一下
    expect(c.pending()).toBeNull();

    // flush 完计时器不许再烧一次
    vi.advanceTimersByTime(DATE_COMMIT_MS * 2);
    expect(got).toEqual(["2026-10-15"]);

    // 没欠着的时候 flush 什么都不做
    c.flush();
    expect(got).toEqual(["2026-10-15"]);

    // cancel = 那句作废，一个字都不落（点了预设 / 清了日期走这条）
    c.schedule("2026-11-01");
    c.cancel();
    vi.advanceTimersByTime(DATE_COMMIT_MS * 2);
    expect(got).toEqual(["2026-10-15"]);
    expect(c.pending()).toBeNull();
  });

  it("任务卡：点走那一下把欠着的落掉，点预设 / 清日期把欠着的作废", () => {
    // 点到卡外先收尾（A1），日期那一份也在里面——不然刚敲完就点走，落库要等 350ms
    const flush = taskCardSource.slice(
      taskCardSource.indexOf("function flushPending"),
      taskCardSource.indexOf("flushRef.current = flushPending;"),
    );
    expect(flush).toContain("dueFieldRef.current?.flush();");
    // 点预设 = 话说完了：刚敲了一半的那句作废，别让它一会儿回来盖掉预设
    const setDue = taskCardSource.slice(taskCardSource.indexOf("function setDue"));
    expect(setDue.slice(0, 300)).toContain("dueFieldRef.current?.cancel();");
    // 清日期同理，否则清完 350ms 又被写回来
    expect(taskCardSource).toContain('{ dueFieldRef.current?.cancel(); updateTask(task.id, { due: null, dueTime: null }); dueWrittenRef.current = null; setMenu(null); }');
    // 去抖烧到点时用的是**那一刻**的落库那句，不是按下那一帧的闭包（统一封在 DateField 里）
    expect(dateFieldSource).toContain("commitRef.current = onCommit;");
    expect(dateFieldSource).toContain("makeDateCommitter((ymd) => commitRef.current(ymd))");
    // 弹层被别处收掉（Esc / 点走 / 收卡片）时，刚敲完那一天也不许丢
    expect(dateFieldSource).toContain("useEffect(() => () => committer.flush(), [committer]);");
  });

  it("「随手记」那个 📅 跟另外三处同一个件：草稿 + 闸门 + 去抖都在 DateField 里", () => {
    const el = dateFieldsIn(quickAddSource)[0];
    expect(el).toContain("ref={dueFieldRef}");
    // 框显示的那一天就是「现在选中的那天」，草稿归组件自己管——
    // 调用方再也没有机会漏掉它（这个框以前正是漏了草稿才「键盘敲不动」的）
    expect(el).toContain('value={pick.due ?? ""}');
    // 点预设 / 点「不定日期」都走同一个出口，并把欠着的那一次作废
    expect(quickAddSource).toContain("function pickDue(d: string | null) {");
    expect(quickAddSource.slice(quickAddSource.indexOf("function pickDue")).slice(0, 200)).toContain("dueFieldRef.current?.cancel();");
    expect(quickAddSource).toContain("onClick={() => pickDue(p.ymd)}");
    expect(quickAddSource).toContain("onClick={() => pickDue(null)}");
    // 「清空」也得把欠着的作废，否则清完 350ms 又被写回来
    expect(quickAddSource).toContain('onClick={() => { dueFieldRef.current?.cancel(); setPick(EMPTY); setMenu(null); }}');
  });

  it("「随手记」的 📅 不许在人还在敲的时候自己关掉：收弹层挂在失焦，不在去抖回调里", () => {
    // 落库回调只管「记下来」。以前它顺手 setMenu(null)，于是同一个「停手 350ms」
    // 把弹层连同 date 框一起卸载，后面敲的键全部落空、半截日期被当成用户的选择
    const el = dateFieldsIn(quickAddSource)[0];
    const onCommit = el.slice(el.indexOf("onCommit={"), el.indexOf("onDone={"));
    expect(onCommit).toContain("setPick({ ...pick, due: ymd })");
    expect(onCommit).not.toContain("setMenu(null)");

    // 收弹层挂在 onDone 上（由 DateField 的失焦触发），焦点还在这排点选按钮里
    // （正按着上面的预设）就别收，否则那一下 click 落在退场中的弹层上
    const onDone = el.slice(el.indexOf("onDone={"));
    expect(onDone).toContain('next.closest(".qa-picks")');
    expect(onDone).toContain("setMenu(null);");

    // 那道窗口判据（alt-tab 不算点走）现在是全仓日期框共用的一份，在 DateField 的 onBlur 里，
    // 而且拦在最前面：窗口失焦时**什么都不做**，不 flush 也不叫 onDone
    const onBlur = dateFieldSource.slice(dateFieldSource.lastIndexOf("onBlur={"));
    expect(onBlur).toContain("if (!document.hasFocus()) return;");
    expect(onBlur.indexOf("document.hasFocus()")).toBeLessThan(onBlur.indexOf("committer.flush();"));
    expect(onBlur.indexOf("document.hasFocus()")).toBeLessThan(onBlur.indexOf("doneRef.current?.(e);"));
    // 顺序还得是「先落库、再交给调用方收窗」，不然收窗时那一天还没进库
    expect(onBlur.indexOf("committer.flush();")).toBeLessThan(onBlur.indexOf("doneRef.current?.(e);"));

    // 回车落库前先把欠着的那一天接过来：点完日历格 350ms 内就回车，这条事不许不带日期，
    // 那个日期更不许静默跟到下一条事身上（点预设与「清空」都 cancel 了，这是对称的另一半）
    const submit = quickAddSource.slice(
      quickAddSource.indexOf("function submit(parsed: ParseResult) {"),
      quickAddSource.indexOf("function commitOnBlur"),
    );
    expect(submit).toContain("const pendingDue = dueFieldRef.current?.pending() ?? null;");
    expect(submit).toContain("dueFieldRef.current?.flush();");
    expect(submit.indexOf("dueFieldRef.current?.flush();")).toBeLessThan(submit.indexOf("addTask({"));
    expect(submit).toContain("due: parsed.due ?? pendingDue ?? pick.due ?? defaults?.due ?? null,");
  });
});

// ---------------------------------------------------------------------------
// 顺延次数：换算法，不再跟「停手多久」较劲（v1.9.0 出包前最后一轮）。
//
// 去抖只把窗口收窄，没堵上洞：date 是**分段控件**，用户在月段和日段之间抬眼确认一下
// 就轻松超过 DATE_COMMIT_MS。把 2026-09-10 改成 2026-10-15——月段敲完停手落库 2026-10-10
// （比原来晚，+1，而且这个假日子真进了盘），日段敲完停手落库 2026-10-15（又比 10-10 晚，再 +1）。
// 净结果仍然是 postponeCount = 2，正好是「顺延×2」和周报那句「（顺延 2 次）」的门槛，
// 而这个数没有任何入口能清零。
//
// 所以：顺延次数的语义是「这件事被往后推了几次」，**不是「盘写了几次」**。
// 弹层期间的落库一律不计数（该写的照写、去抖照留——那是「已生效」的即时反馈），
// 弹层**关掉时**拿「打开时的日期」和「最终日期」比一次，往后挪了才 +1。
// 这样跟用户停手多久完全无关。
// ---------------------------------------------------------------------------

describe("顺延次数按「弹层开→关」整段算一次，跟中途落了几次库无关", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** 照抄任务卡那套：开弹层记下当时的日子 + 清空「这次写了什么」→ 期间的落库都不计数、
   *  但逐笔记账 → 关弹层**只按这次弹层自己写过的那个日子**结算一次。
   *
   *  记账那一笔（written）是这一轮补的。以前结算读的是 store 里**当下**那个 due，
   *  跟「这次弹层写了什么」无关，于是弹层开着时别处改的日期会被再数一遍 */
  function openPopup(id: string) {
    const at = getTask(id).due ?? "";
    /** undefined = 这次弹层一个字都没写；null = 这次弹层把日期清了 */
    let written: string | null | undefined = undefined;
    const committer = makeDateCommitter((ymd) => {
      if (ymd !== (getTask(id).due ?? "")) {
        updateTask(id, { due: ymd, dueTime: null }, { noPostponeCount: true });
        written = ymd;
      }
    });
    return {
      type(v: string) {
        if (!v) return;
        if (!isPlausibleYMD(v)) return;
        committer.schedule(v);
      },
      /** 弹层里点「清除日期」 */
      clear() {
        committer.cancel();
        updateTask(id, { due: null, dueTime: null }, { noPostponeCount: true });
        written = null;
      },
      close() {
        committer.flush();
        if (written === undefined) return; // 这次弹层一个字都没写：别处改的日期不算在这一笔上
        if (!at) return;
        if (!written) return; // 这次弹层把日期清了，不是顺延
        if (written <= at) return; // YMD 定长可以直接比字符串，跟 cmpYMD 同结果
        const cur = getTask(id);
        updateTask(id, { postponeCount: cur.postponeCount + 1 }, { coalesceKey: `task:${id}:due` });
      },
    };
  }

  it("四拍之间**隔开去抖窗口**（月段敲完抬眼、日段敲完抬眼）：仍然只 +1", () => {
    const id = addTask({ title: "写周报", due: "2026-09-10" });
    const p = openPopup(id);
    // 上一轮漏掉的正是这条路：每拍之后都停手停够，四拍变成四次真落库
    for (const v of ["2026-01-10", "2026-10-10", "2026-10-01", "2026-10-15"]) {
      p.type(v);
      vi.advanceTimersByTime(DATE_COMMIT_MS + 50);
    }
    p.close();

    const t = getTask(id);
    expect(t.due).toBe("2026-10-15");
    expect(t.postponeCount).toBe(1); // 用户就挪了这一次
    expect(t.postponeCount >= 2).toBe(false); // 「顺延×2」那个判据不成立
  });

  it("反证：还按「写一次数一次」算，同一串操作就是净加 2、门槛当场成立", () => {
    const id = addTask({ title: "写周报", due: "2026-09-10" });
    for (const v of ["2026-01-10", "2026-10-10", "2026-10-01", "2026-10-15"]) {
      updateTask(id, { due: v, dueTime: null }); // 不带 noPostponeCount = 老算法
    }
    expect(getTask(id).postponeCount).toBe(2);
  });

  it("连着敲不停手（同一个去抖窗口）照样只 +1：两条路给的是同一个数", () => {
    const id = addTask({ title: "写周报", due: "2026-09-10" });
    const p = openPopup(id);
    for (const v of ["2026-01-10", "2026-10-10", "2026-10-01", "2026-10-15"]) {
      p.type(v);
      vi.advanceTimersByTime(60);
    }
    p.close();
    expect(getTask(id).due).toBe("2026-10-15");
    expect(getTask(id).postponeCount).toBe(1);
  });

  it("开一次弹层挪一次、关掉再开再挪一次 = 两次：该数的还是数得上", () => {
    const id = addTask({ title: "写周报", due: "2026-09-10" });
    const a = openPopup(id);
    a.type("2026-10-15");
    vi.advanceTimersByTime(DATE_COMMIT_MS + 50);
    a.close();
    expect(getTask(id).postponeCount).toBe(1);

    const b = openPopup(id);
    b.type("2026-11-01");
    vi.advanceTimersByTime(DATE_COMMIT_MS + 50);
    b.close();
    expect(getTask(id).due).toBe("2026-11-01");
    expect(getTask(id).postponeCount).toBe(2);
  });

  it("改早了、或者绕一圈又改回原来那天：一次都不加", () => {
    const early = addTask({ title: "提前做", due: "2026-09-10" });
    const p1 = openPopup(early);
    p1.type("2026-08-01");
    vi.advanceTimersByTime(DATE_COMMIT_MS + 50);
    p1.close();
    expect(getTask(early).due).toBe("2026-08-01");
    expect(getTask(early).postponeCount).toBe(0);

    const back = addTask({ title: "改回去", due: "2026-09-10" });
    const p2 = openPopup(back);
    p2.type("2026-12-31"); // 中途挪到很后面
    vi.advanceTimersByTime(DATE_COMMIT_MS + 50);
    p2.type("2026-09-10"); // 又改回原来那天
    vi.advanceTimersByTime(DATE_COMMIT_MS + 50);
    p2.close();
    expect(getTask(back).due).toBe("2026-09-10");
    expect(getTask(back).postponeCount).toBe(0);
  });

  it("本来就没日期（从无到有）不算顺延，跟 store 那边同口径", () => {
    const id = addTask({ title: "还没排期" });
    const p = openPopup(id);
    p.type("2026-10-15");
    vi.advanceTimersByTime(DATE_COMMIT_MS + 50);
    p.close();
    expect(getTask(id).due).toBe("2026-10-15");
    expect(getTask(id).postponeCount).toBe(0);
  });

  it("`Ctrl+→` 推明天这类不走弹层的路照旧自己数：默认仍然是「写晚了就 +1」", () => {
    const id = addTask({ title: "写周报", due: "2026-09-10" });
    updateTask(id, { due: "2026-09-11" });
    expect(getTask(id).postponeCount).toBe(1);
  });

  it("结算那一笔跟刚才的日期写入并成同一格撤销：改一次日期只吃一格", () => {
    const id = addTask({ title: "写周报", due: "2026-09-10" });
    const depth0 = appStore.getState().undoDepth;
    const p = openPopup(id);
    p.type("2026-10-15");
    vi.advanceTimersByTime(DATE_COMMIT_MS + 50);
    p.close();
    expect(getTask(id).postponeCount).toBe(1);
    expect(appStore.getState().undoDepth).toBe(depth0 + 1);
    // 撤一下就回到改之前：日期和计数一起回去
    undo();
    expect(getTask(id).due).toBe("2026-09-10");
    expect(getTask(id).postponeCount).toBe(0);
  });

  it("任务卡里真接上了这套：弹层期间一律 POPUP_WRITE，结算挂在 effect 的清理上", () => {
    expect(taskCardSource).toContain("const POPUP_WRITE = { noPostponeCount: true } as const;");
    // 弹层里那两个写库出口（去抖落库 / 点预设）都带着它
    expect(taskCardSource).toContain(
      "updateTask(task.id, { due: next, dueTime: time || null }, POPUP_WRITE);",
    );
    expect(taskCardSource).toContain(
      "updateTask(task.id, { due: d, dueTime: d ? draftTime || task.dueTime : null }, POPUP_WRITE);",
    );
    // 开弹层记下当时那天、关弹层（含收卡片、换别的弹层）结算一次
    expect(taskCardSource).toContain("function settleDuePopup() {");
    expect(taskCardSource).toContain('if (menu !== "date") return;');
    expect(taskCardSource).toContain("return () => settleDueRef.current();");
    const settle = taskCardSource.slice(
      taskCardSource.indexOf("function settleDuePopup() {"),
      taskCardSource.indexOf("settleDueRef.current = settleDuePopup;"),
    );
    expect(settle).toContain("dueFieldRef.current?.flush();"); // 欠着的那次先做掉再比
    expect(settle).toContain("cmpYMD(written, before) <= 0");
    expect(settle).toContain("postponeCount: cur.postponeCount + 1");
    expect(settle).toContain("coalesceKey: `task:${cur.id}:due`");
  });
});

// ---------------------------------------------------------------------------
// 顺延结算认错账（v1.9.0 出包前，同一个洞的最后一半）。
//
// 上面那套「弹层开 → 弹层关整段算一次」结算时读的是 store 里**当下**那个 due，
// 跟「这次弹层自己写了什么」无关。于是弹层开着、日期却是**别处**改的时候，
// 那一次改动会被再数一遍。三条真路径都很自然：
//   ① 展开一件事 → 点开 📅 看了一眼没选 → 转头在底下「整句改」那栏把日期改晚 → 回车
//      （普通 updateTask，store 自己 +1）→ 弹层还开着 → 点走 / Esc / 收卡片 → 再 +1。
//      用户只顺延了一次，行尾挂出「顺延×2」，而这个数没有任何入口能清零。
//   ② 弹层开着时勾掉一件循环任务：完成会把计数清零、把 due 推到下一个落点，
//      关弹层再 +1 —— 刚做完的循环任务凭空进了周报的顺延名单。
//   ③ 弹层开着时按 Ctrl+→ 推明天，同样多数一笔。
//
// 修法：只认「这次弹层自己写过的那个日子」（TaskCard.dueWrittenRef），
// 一个字都没写就直接 return，一次都不数。
// ---------------------------------------------------------------------------

describe("顺延结算只认「这次弹层自己写过的东西」，别处改的日期算不到它头上", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function openPopup(id: string) {
    const at = getTask(id).due ?? "";
    let written: string | null | undefined = undefined;
    const committer = makeDateCommitter((ymd) => {
      if (ymd !== (getTask(id).due ?? "")) {
        updateTask(id, { due: ymd, dueTime: null }, { noPostponeCount: true });
        written = ymd;
      }
    });
    return {
      type(v: string) {
        if (!isPlausibleYMD(v)) return;
        committer.schedule(v);
      },
      clear() {
        committer.cancel();
        updateTask(id, { due: null, dueTime: null }, { noPostponeCount: true });
        written = null;
      },
      close() {
        committer.flush();
        if (written === undefined) return;
        if (!at) return;
        if (!written) return;
        if (written <= at) return;
        const cur = getTask(id);
        updateTask(id, { postponeCount: cur.postponeCount + 1 }, { coalesceKey: `task:${id}:due` });
      },
    };
  }

  it("① 弹层开着，日期是「整句改」那栏改晚的：只算它那一次，关弹层不再补一刀", () => {
    const id = addTask({ title: "写周报", due: "2026-09-10" });
    const p = openPopup(id); // 点开 📅 看了一眼，一个字没选
    updateTask(id, { due: "2026-10-15" }); // applySentence 走普通 updateTask，store 自己 +1
    expect(getTask(id).postponeCount).toBe(1);
    p.close(); // 点走 / Esc / 收卡片
    expect(getTask(id).postponeCount).toBe(1); // 不是 2
    expect(getTask(id).postponeCount >= 2).toBe(false); // 行尾那个「顺延×2」不成立
  });

  it("反证：还拿 store 的现值当依据，同一串操作就是净加 2、「顺延×2」当场挂出来", () => {
    const id = addTask({ title: "写周报", due: "2026-09-10" });
    const at = getTask(id).due ?? ""; // 老算法：只记「打开时那天」
    updateTask(id, { due: "2026-10-15" });
    const cur = getTask(id);
    if (cur.due && cur.due > at) {
      updateTask(id, { postponeCount: cur.postponeCount + 1 }, { coalesceKey: `task:${id}:due` });
    }
    expect(getTask(id).postponeCount).toBe(2);
  });

  it("② 弹层开着勾掉一件循环任务：完成把 due 推到下一个落点，不许被算成一次顺延", () => {
    const id = addTask({ title: "交周报", due: "2026-09-10", repeat: { kind: "weekly", days: [4] } });
    updateTask(id, { postponeCount: 2 }); // 之前真拖过两次
    const p = openPopup(id);
    completeTask(id); // 完成 → 计数清零、due 推到下一个落点
    expect(getTask(id).postponeCount).toBe(0);
    expect(getTask(id).due).not.toBe("2026-09-10");
    p.close();
    // 刚做完的循环任务不许凭空进周报的顺延名单
    expect(getTask(id).postponeCount).toBe(0);
  });

  it("③ 弹层开着按 Ctrl+→ 推明天：store 自己数的那一次就是全部", () => {
    const id = addTask({ title: "写周报", due: "2026-09-10" });
    const p = openPopup(id);
    updateTask(id, { due: "2026-09-11" }); // Ctrl+→ 不走弹层，照旧「写晚了就 +1」
    expect(getTask(id).postponeCount).toBe(1);
    p.close();
    expect(getTask(id).postponeCount).toBe(1);
  });

  it("弹层里点「清除日期」：写过，但写的是「没有日期」，不算顺延", () => {
    const id = addTask({ title: "写周报", due: "2026-09-10" });
    const p = openPopup(id);
    p.clear();
    p.close();
    expect(getTask(id).due).toBeNull();
    expect(getTask(id).postponeCount).toBe(0);
  });

  it("弹层自己写了、别处也写了：各算各的，一笔都不少也不多", () => {
    const id = addTask({ title: "写周报", due: "2026-09-10" });
    const p = openPopup(id);
    p.type("2026-10-15"); // 弹层自己挪了一次
    vi.advanceTimersByTime(DATE_COMMIT_MS + 50);
    updateTask(id, { due: "2026-10-20" }); // 期间别处又挪了一次（store 自己 +1）
    expect(getTask(id).postponeCount).toBe(1);
    p.close();
    expect(getTask(id).postponeCount).toBe(2); // 两次真顺延，两次都数上
  });
});

describe("「失焦即提交」不许把「窗口失焦」当成「点走」（alt-tab 不是点走）", () => {
  // 全仓「失焦即提交」的入口清单（grep onBlur / onBlurCommit / commitOnBlur 得来）。
  // 一道闸都不许漏：窗口失焦时**不提交、原样悬着**，等用户回来自己了结。
  // 新加任何一个 onBlur 落库口，都要在这儿添一行——这张表就是那份 grep 的落盘版
  const BLUR_COMMITS = [
    ["侧栏 · 新建清单", sidebarSource],
    ["日历格 · 快记一条", calendarSource],
    ["习惯页 · 新增习惯", habitsSource],
    ["随手记 · 一句话记一条", quickAddSource],
    // 下面这些是 v1.9.0 A1 同一批新增、当初漏装的
    ["SyntaxInput · 所有 onBlurCommit 的统一出口（整句改 / ＋子任务 / 随手记）", syntaxInputSource],
    ["任务卡 · 需求方 / 标签 / 日期弹层的时间框", taskCardSource],
    // v1.9.0 出包前：全仓四个日期框合并成这一个件，那道窗口判据也跟着只剩这一份
    ["DateField · 全仓四处日期框共用的失焦口", dateFieldSource],
    ["右键菜单 · 需求方", ctxMenuSource],
    ["清单页 · 清单改名", listViewSource],
    ["设置页 · 全局快捷键", settingsSource],
  ] as const;

  it("每一个入口都装了同一道窗口判据", () => {
    for (const [name, src] of BLUR_COMMITS) {
      expect(src, name).toContain("document.hasFocus()");
    }
  });

  it("源码里不再有裸的 onBlur 落库口：凡是 onBlur 都得跟这道闸同框", () => {
    for (const [name, src] of BLUR_COMMITS) {
      for (const line of src.split("\n")) {
        // 只看「一行写完」的那种（onBlur={xxx}）；多行的 onBlur={(e) => { 由下面几条单钉
        const m = /onBlur=\{(?!\(e?\)? =>\s*\{$)(.+)\}\s*$/.exec(line.trim());
        if (!m) continue;
        expect(line, `${name}: ${line.trim()}`).toContain("document.hasFocus()");
      }
    }
  });

  it("判据在最前面：拦在提交动作之前，而不是提交完再补一句", () => {
    const quick = quickAddSource.slice(quickAddSource.indexOf("function commitOnBlur"));
    expect(quick.slice(0, 200)).toContain("if (!document.hasFocus()) return false;");
    const habitsBlur = habitsSource.slice(habitsSource.indexOf("onBlur={(e) => {"));
    expect(habitsBlur.indexOf("document.hasFocus()")).toBeLessThan(habitsBlur.indexOf("create();"));
    // SyntaxInput 是一处盖住三个调用方的总闸，必须挡在 onBlurCommit 之前。
    // v1.9.1 起这个框有 input / textarea 两条路（整句改开了 multiline），
    // 两条路共用一份属性对象，blur 抽成了具名的 handleBlur——闸门还是同一道，只是搬了个家
    expect(syntaxInputSource).toContain("onBlur: handleBlur,");
    const siBlur = syntaxInputSource.slice(syntaxInputSource.indexOf("function handleBlur"));
    expect(siBlur).toContain("if (!document.hasFocus()) return;");
    expect(siBlur.indexOf("document.hasFocus()")).toBeLessThan(siBlur.indexOf("onBlurCommit(parsed, e)"));
  });

  it("窗口失焦时**什么都不做**：不提交，也不顺手把弹层收掉（原样悬着等人回来）", () => {
    // 四个包了闸的单行 onBlur 一律是「条件成立才 commit」，没有 else 里的收尾动作
    for (const src of [taskCardSource, ctxMenuSource, listViewSource, settingsSource]) {
      for (const line of src.split("\n")) {
        if (!line.includes("document.hasFocus()") || !line.includes("onBlur=")) continue;
        expect(line).not.toContain("setMenu(null)");
        expect(line).not.toContain("expandTask(null)");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 抽出 DateField 之后带出来的三条回归（v1.9.0 出包前最后一轮）。
// 三条都是同一个根：`onDone` 挂在 onBlur 上，跟原有交互撞了车。
// ---------------------------------------------------------------------------

describe("日期框的 onDone：焦点还落在自己那个弹层里，就一下都不许收", () => {
  // `.popmenu.leaving` 是 pointer-events:none。焦点在日期框里时去点弹层上的预设：
  // mousedown 把焦点从 date input 挪走 → onBlur → onDone → 弹层进入 leaving
  // （focusout 是 discrete 事件，React 同步 flush，发生在 mouseup **之前**）→
  // mouseup 落不到按钮上，click 根本不触发。结果是弹层关了、日期没设，
  // 「拖到计划 → 点了下日期框 → 改主意点本周五」这一整个动作静默作废。
  // 四处调用点里当初只有「随手记」装了这道闸，另外两处有 onDone 的都漏了。
  const appCss = readFileSync("src/styles/app.css", "utf8");

  it("凡是有 onDone 的日期框，都先判 relatedTarget 还在不在自己那个弹层里", () => {
    const spots = allTsx.flatMap(([name, src]) =>
      dateFieldsIn(src).filter((el) => el.includes("onDone={")).map((el) => [name, el] as const));
    // 六处调用点里三处有 onDone；任务卡那个日期弹层、手机端两张抽屉的日期段**都不给** onDone
    // （选完立刻生效，那一段留着好接着设时间 / 循环）。
    // 数字对不上就是新加了一个日期框——先照这条把闸装上再改这张表
    expect(spots.map(([n]) => n).sort()).toEqual([
      "src/components/QuickAddBar.tsx",
      "src/components/Sidebar.tsx",
      "src/components/TaskCard.tsx",
    ]);
    for (const [name, el] of spots) {
      const onDone = el.slice(el.indexOf("onDone={"));
      expect(onDone, `${name}: onDone 得认 relatedTarget（焦点挪到哪儿去了）`)
        .toContain("e.relatedTarget as HTMLElement | null");
      // 「焦点还在自己那个弹层里 → 直接 return，什么都不做」
      expect(onDone, `${name}: 漏了这道闸，点弹层上的按钮会一个字都不落`)
        .toMatch(/if \(next && next\.closest\("\.[\w-]+"\)\) return;/);
      // 闸必须拦在收弹层前面，补在后面等于没补
      const close = onDone.search(/set(Menu|SubMenu|PendingPlan)\(null\)/);
      expect(close, `${name}: 这个 onDone 到底收不收弹层？`).toBeGreaterThan(-1);
      expect(onDone.indexOf("return;"), `${name}: 闸得拦在收弹层前面`).toBeLessThan(close);
    }
  });

  it("三处各判各的弹层，别判成别人家的", () => {
    expect(quickAddSource).toContain('if (next && next.closest(".qa-picks")) return;');
    expect(sidebarSource).toContain('if (next && next.closest(".side-plan-pop")) return;');
    expect(taskCardSource).toContain('if (next && next.closest(".popmenu")) return;');
  });

  it("退场中的弹层仍然是 pointer-events:none：修的是「别提前进退场」，不是放开它接点击", () => {
    // 反过来改（把 .leaving 的 pointer-events 放开）是另一个 bug：正在退场、
    // 已经淡掉一半的弹层还能被点中
    const leaving = appCss.slice(appCss.indexOf(".popmenu.leaving"));
    expect(leaving.slice(0, 200)).toContain("pointer-events: none;");
  });
});

describe("侧栏「安排到哪天？」：顺延也按「弹层开→关」整段算一次", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** 照抄 Sidebar 那套：开弹层记下每个 id 当时的日子 + 清空「这次写了什么」→
   *  日期框那条路一律 noPostponeCount 落库、逐笔记账 → 关弹层统一结算一次。
   *  点预设那条路一次到位，照旧走 setTasksDue 自己的计数（并把记账清空） */
  function openPlanPop(ids: string[]) {
    const now = appStore.getState().data.tasks;
    const at = Object.fromEntries(ids.map((id) => [id, now.find((t) => t.id === id)?.due ?? ""]));
    /** undefined = 这次弹层没在日期框里写过 */
    let written: string | undefined = undefined;
    const committer = makeDateCommitter((ymd) => {
      setTasksDue(ids, ymd, { noPostponeCount: true }); // planTo(ymd, false)
      written = ymd;
    });
    return {
      /** 在日期框里选一天 */
      type(v: string) {
        if (!isPlausibleYMD(v)) return;
        committer.schedule(v);
      },
      /** 点上面的预设：点之前日期框先失焦（那一下会把欠着的做掉），然后一次到位、就地计数 */
      preset(v: string) {
        committer.flush();
        setTasksDue(ids, v);
        written = undefined; // planTo(ymd) 那条路自己数完了，别让关弹层再数一遍
      },
      close() {
        committer.flush();
        if (written === undefined) return;
        for (const [id, prev] of Object.entries(at)) {
          if (!prev) continue; // 打开时本来就没日期 = 从无到有，不算顺延
          if (written <= prev) continue; // YMD 定长可以直接比字符串，跟 cmpYMD 同结果
          const cur = getTask(id);
          updateTask(id, { postponeCount: cur.postponeCount + 1 }, { coalesceKey: `task:${id}:due` });
        }
      },
    };
  }

  it("同一个弹层里连改两次日期（月份点错了改一次）：净 +1，不是 +2", () => {
    const id = addTask({ title: "写周报", due: "2026-09-10" });
    const p = openPlanPop([id]);
    p.type("2026-10-15");
    vi.advanceTimersByTime(DATE_COMMIT_MS + 50); // 去抖烧到点，落库一次
    p.type("2026-11-15"); // 发现月份点错了，同一个弹层里改一次
    vi.advanceTimersByTime(DATE_COMMIT_MS + 50); // 又落一次
    p.close();

    const t = getTask(id);
    expect(t.due).toBe("2026-11-15");
    expect(t.postponeCount).toBe(1); // 用户就「安排」了这一次
    expect(t.postponeCount >= 2).toBe(false); // 「顺延×2」那个判据不成立
  });

  it("键盘那条同样只 +1：日段敲「1」抬眼确认超过 350ms 先落一次，敲完「5」再落一次", () => {
    const id = addTask({ title: "写周报", due: "2026-09-10" });
    const p = openPlanPop([id]);
    for (const v of ["2026-10-01", "2026-10-15"]) {
      p.type(v);
      vi.advanceTimersByTime(DATE_COMMIT_MS + 50); // 每拍之间都停手停够，两次真落库
    }
    p.close();
    expect(getTask(id).due).toBe("2026-10-15");
    expect(getTask(id).postponeCount).toBe(1);
  });

  it("反证：setTasksDue 每写一次就无条件 +1，同一串操作净加 2、门槛当场成立", () => {
    const id = addTask({ title: "写周报", due: "2026-09-10" });
    setTasksDue([id], "2026-10-15");
    setTasksDue([id], "2026-11-15");
    expect(getTask(id).postponeCount).toBe(2);
  });

  it("点预设那条路照旧就地数一次：一次到位就是一次顺延，别把它一起改复杂了", () => {
    const id = addTask({ title: "写周报", due: "2026-09-10" });
    const p = openPlanPop([id]);
    p.preset("2026-09-18");
    p.close(); // 关弹层不再补第二刀
    expect(getTask(id).due).toBe("2026-09-18");
    expect(getTask(id).postponeCount).toBe(1);
  });

  it("多选拖过去：各按各打开时那天结算，本来没日期的那件不算顺延", () => {
    const late = addTask({ title: "写周报", due: "2026-09-10" });
    const none = addTask({ title: "还没排期" });
    const p = openPlanPop([late, none]);
    p.type("2026-10-15");
    vi.advanceTimersByTime(DATE_COMMIT_MS + 50);
    p.close();
    expect(getTask(late).postponeCount).toBe(1);
    expect(getTask(none).due).toBe("2026-10-15");
    expect(getTask(none).postponeCount).toBe(0); // 从无到有不算顺延
  });

  it("改早了、或者绕一圈又改回原来那天：一次都不加", () => {
    const id = addTask({ title: "写周报", due: "2026-09-10" });
    const p = openPlanPop([id]);
    p.type("2026-12-31"); // 中途挪到很后面
    vi.advanceTimersByTime(DATE_COMMIT_MS + 50);
    p.type("2026-09-10"); // 又改回原来那天
    vi.advanceTimersByTime(DATE_COMMIT_MS + 50);
    p.close();
    expect(getTask(id).due).toBe("2026-09-10");
    expect(getTask(id).postponeCount).toBe(0);
  });

  it("setTasksDue 的开关跟 updateTask 是同一个口径：带上它一次都不数，不带照旧", () => {
    const id = addTask({ title: "写周报", due: "2026-09-10" });
    setTasksDue([id], "2026-10-15", { noPostponeCount: true });
    expect(getTask(id).due).toBe("2026-10-15");
    expect(getTask(id).postponeCount).toBe(0);
    setTasksDue([id], "2026-11-15"); // 拖拽改期那些老调用点一个字没改，照旧自己数
    expect(getTask(id).postponeCount).toBe(1);
    expect(storeSource)
      .toContain('opts: Pick<UpdateTaskOpts, "noPostponeCount" | "coalesceKey"> = {},');
    // 合并键要透传下去：日期写入和关弹层补的那几次 postponeCount 得并成一格撤销
    expect(storeSource).toContain("{ coalesceKey: opts.coalesceKey }");
  });

  it("侧栏真接上了这套（读源码钉结构）", () => {
    expect(sidebarSource).toContain("else if (close) setTasksDue(pendingPlan.ids, due);");
    // 日期框那条路：不数顺延，并且跟结算共用同一把合并键（每个 id 各用各的是并不上的）
    expect(sidebarSource).toContain("planCoalesceRef.current = key;");
    expect(sidebarSource)
      .toContain("setTasksDue(pendingPlan.ids, due, { noPostponeCount: true, coalesceKey: key });");
    expect(sidebarSource).toContain("planWrittenRef.current = close ? undefined : due;");
    expect(sidebarSource).toContain("function settlePlanPopup() {");
    // 结算挂在弹层那条 effect 的清理上：关弹层的路太多，一处处补迟早漏一条
    expect(sidebarSource).toContain("settlePlanRef.current();");
    const settle = sidebarSource.slice(
      sidebarSource.indexOf("function settlePlanPopup() {"),
      sidebarSource.indexOf("settlePlanRef.current = settlePlanPopup;"),
    );
    expect(settle).toContain("planFieldRef.current?.flush();"); // 欠着的那次先做掉再比
    expect(settle).toContain("if (written === undefined) return;"); // 别处改的不算这一笔
    expect(settle).toContain("cmpYMD(written, at) <= 0");
    expect(settle).toContain("postponeCount: cur.postponeCount + 1");
    // 用的是整个弹层共用那把键（planTo 里存进 planCoalesceRef 的），
    // 不是 `task:<id>:due`——后者跟 setTasksDue 那次写入的键对不上，多选时每个 id 还各不相同，
    // 一格都并不上，「拖 3 件去排期」要按 4 下 Ctrl+Z 日期才回得去（栈只有 10 格）
    expect(settle).toContain("const key = planCoalesceRef.current;");
    expect(settle).toContain("{ coalesceKey: key }");
    expect(settle).not.toContain("`task:${id}:due`");
  });
});

describe("任务卡按 Esc 是丢弃：不许把半截日期钉成最终结果，更不许记一次顺延", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** 照抄任务卡：日期弹层里敲字 → 收卡片时 DateField 自己 flush 一次，
   *  紧接着 settleDuePopup 结算。Esc 那条路必须先 cancel + 清记账再收卡 */
  function openCard(id: string) {
    const at = getTask(id).due ?? "";
    let written: string | null | undefined = undefined;
    const committer = makeDateCommitter((ymd) => {
      if (ymd !== (getTask(id).due ?? "")) {
        updateTask(id, { due: ymd, dueTime: null }, { noPostponeCount: true });
        written = ymd;
      }
    });
    function unmountAndSettle() {
      committer.flush(); // 卡片卸载时 DateField 那句 useEffect 清理
      if (written === undefined) return;
      if (!at || !written) return;
      if (written <= at) return;
      const cur = getTask(id);
      updateTask(id, { postponeCount: cur.postponeCount + 1 }, { coalesceKey: `task:${id}:due` });
    }
    return {
      type(v: string) {
        if (!isPlausibleYMD(v)) return;
        committer.schedule(v);
      },
      /** 修好之后的 Esc：先收尾（那一拍作废 + 记账清空），再收卡片 */
      escape() {
        committer.cancel();
        written = undefined;
        unmountAndSettle();
      },
      /** 修之前的 Esc：只收卡片 */
      escapeOld() {
        unmountAndSettle();
      },
    };
  }

  it("键盘把月段改成 10（控件吐出完整合法的 2026-10-10）之后按 Esc：due 原样、顺延不动", () => {
    const id = addTask({ title: "写周报", due: "2026-09-10" });
    const p = openCard(id);
    p.type("2026-10-10");
    vi.advanceTimersByTime(60); // 还没停够，这一拍还欠着
    p.escape();
    vi.advanceTimersByTime(DATE_COMMIT_MS * 2); // 作废了就再也不会烧到点

    const t = getTask(id);
    expect(t.due).toBe("2026-09-10"); // 用户从没想要 10-10 那一天
    expect(t.postponeCount).toBe(0);
  });

  it("反证：Esc 只收卡片（不 cancel、不清记账）就是把半截日期钉死，还 +1 顺延", () => {
    const id = addTask({ title: "写周报", due: "2026-09-10" });
    const p = openCard(id);
    p.type("2026-10-10");
    vi.advanceTimersByTime(60);
    p.escapeOld();
    expect(getTask(id).due).toBe("2026-10-10");
    expect(getTask(id).postponeCount).toBe(1);
  });

  it("任务卡的 Esc 真按这个顺序接上了，跟侧栏的 Esc 一个口径（读源码钉结构）", () => {
    const onKey = taskCardSource.slice(
      taskCardSource.indexOf("function onKey(e: KeyboardEvent) {"),
      taskCardSource.indexOf('document.addEventListener("mousedown", onDoc);'),
    );
    expect(onKey).toContain("dueFieldRef.current?.cancel();");
    expect(onKey).toContain("dueWrittenRef.current = undefined;");
    expect(onKey.indexOf("dueFieldRef.current?.cancel();")).toBeLessThan(onKey.indexOf("expandTask(null)"));
    expect(onKey.indexOf("dueWrittenRef.current = undefined;")).toBeLessThan(onKey.indexOf("expandTask(null)"));
    // 侧栏那条一直是「先 cancel 再收」，现在两边一样了（记账也一并清空）
    const sideKey = sidebarSource.slice(sidebarSource.indexOf("function onKey(e: KeyboardEvent) {"), sidebarSource.indexOf("function onDoc"));
    expect(sideKey).toContain("planFieldRef.current?.cancel();");
    expect(sideKey).toContain("planWrittenRef.current = undefined;");
    expect(sideKey.indexOf("planFieldRef.current?.cancel();")).toBeLessThan(sideKey.indexOf("setPendingPlan(null);"));
  });
});
