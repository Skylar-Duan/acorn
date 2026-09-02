// v1.11.0 · 手机端两张抽屉：任务详情（画板 ④）与记一条（画板 ③）。
//
// 这一轮的东西**在 jsdom 里一个像素都量不出来**（没有布局引擎，也没有手指），
// 所以照 tests/mobile-layout.test.ts 那个路数：钉「改法还在不在源码里」。
// 每一条都对应一个「写歪了用户当场会疼」的点：
//
//   ① 安排日期的候选日只有一套（core/dates.duePresets）。在这儿另写一份「本周五」，
//      周六点开时桌面写「下周五」、手机还写「本周五」，同一件事两个日子。
//   ② 「记一条」在手机上**不解析语法**（用户 2026-09-02 定）：打进去什么就是什么。
//      漏进一个 parseQuickAdd，用户打的「跟老板确认 /3 的方案」就会被吃掉一截标题、
//      还凭空建出一张叫「3」的清单。
//   ③ 改属性走的 store 函数必须跟桌面那张卡（TaskCard）是同一批——它们自带撤销栈和落盘，
//      在这儿图省事直写 state 就是「手机上改的东西撤不回、也可能不落盘」。
//   ④ 子任务行的「放弃 / 删除」靠左滑（手指没有 hover），走共用的 useSwipeRow。
//   ⑤ 两个 Host 都只认 sheetStore 的栈顶：别自己再存一份「我开着没」，那必然跟栈打架。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import taskSheetSource from "../src/mobile/TaskSheet.tsx?raw";
import quickAddSheetSource from "../src/mobile/QuickAddSheet.tsx?raw";
import taskCardSource from "../src/components/TaskCard.tsx?raw";
import quickAddBarSource from "../src/components/QuickAddBar.tsx?raw";
import swipeSource from "../src/mobile/swipe.ts?raw";
import { duePresets } from "../src/core/dates";

const read = (p: string) => readFileSync(p, "utf8");
const sheetCss = read("src/styles/mobile-sheet.css");
const mobileCss = read("src/styles/mobile.css");

/** 仓库里 CRLF / LF 混着用，断言不许把行尾当内容的一部分 */
const nl = (s: string) => s.replace(/\r\n/g, "\n");

/** 一段函数体：从 `from` 到下一个 `to`（两张纸里那几个出口都够短，切一刀就够看） */
function slice(src: string, from: string, to: string): string {
  const i = src.indexOf(from);
  expect(i, `源码里找不到：${from}`).toBeGreaterThan(-1);
  const j = src.indexOf(to, i + from.length);
  expect(j, `${from} 之后找不到收尾记号：${to}`).toBeGreaterThan(-1);
  return src.slice(i, j);
}

describe("① 安排日期的候选日：两张纸都走 core/dates.duePresets，不许另写一份", () => {
  it("两张纸都 import 并现算 duePresets(today)", () => {
    for (const [name, src] of [["任务详情", taskSheetSource], ["记一条", quickAddSheetSource]] as const) {
      expect(src, name).toContain('from "../core/dates"');
      expect(src, name).toContain("duePresets");
      expect(src, name).toContain("const presets = duePresets(today);");
      // 渲染那一排就是它，不是别的什么数组
      expect(src, name).toMatch(/presets\.map\(\(p\) =>/);
    }
  });

  it("四个名字一个都不许写死在这两个文件里（「本周五」到了周六要变成「下周五」）", () => {
    // 标签跟着算出来的日子走，规则和单测都在 core/dates。写死就等于把那条规则复制了一份
    for (const [name, src] of [["任务详情", taskSheetSource], ["记一条", quickAddSheetSource]] as const) {
      for (const label of ["本周五", "下周五", "本周日", "下周日", "本月末"]) {
        expect(src, `${name} 里不许出现写死的「${label}」`).not.toContain(label);
      }
    }
  });

  it("先钉住前提：duePresets 给的就是这四类，而且跟今天撞上的那个不出现", () => {
    const keys = duePresets("2026-09-02").map((p) => p.key); // 周三
    expect(keys).toEqual(["today", "fri", "sun", "monthEnd"]);
    // 正好是本月末那天点开：「本月末」跟「今天」撞了，只剩三个
    expect(duePresets("2026-09-30").map((p) => p.key)).not.toContain("monthEnd");
  });

  it("日期框仍然是全仓那唯一一个件（DateField），不许手写 <input type=\"date\">", () => {
    for (const [name, src] of [["任务详情", taskSheetSource], ["记一条", quickAddSheetSource]] as const) {
      expect(src, name).toContain('import DateField from "../components/DateField";');
      expect(src, name).not.toContain('type="date"');
      // 收「这一段」是调用方的事，而这两处**故意不给 onDone**：选完日子这一段留着，好接着设时间
      expect(src, name).not.toContain("onDone={");
    }
  });
});

describe("② 记一条：手机上一个字都不解析，打的就是标题", () => {
  it("整个文件里没有解析器、也没有快捷语法输入框", () => {
    for (const forbidden of ["parseQuickAdd", "parseSubtaskInput", "SyntaxInput", "core/parse", "core/syntax", "taskToSentence"]) {
      expect(quickAddSheetSource, `记一条不许碰 ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("标题原样进 addTask，属性全部来自点选", () => {
    const record = slice(quickAddSheetSource, "function record()", "function toggleSeg");
    expect(record).toContain("const t = title.trim();");
    expect(record).toContain("title: t, // 原样：手机上这行字**不过解析**");
    // 五样属性都从 pick 来
    for (const field of ["listId: listOk,", "who: pick.who,", "priority: pick.priority,", "repeat: pick.repeat,"]) {
      expect(record).toContain(field);
    }
  });

  it("落库这条路跟桌面「随手记」一字不差：先把 📅 里欠着的那天接过来再 addTask", () => {
    const record = slice(quickAddSheetSource, "function record()", "function toggleSeg");
    // 不接这一手就是「点完日历格 350ms 内按记下 → 这条事不带日期，那个日期一会儿静默跟到下一条上」
    expect(record).toContain("const pendingDue = dueFieldRef.current?.pending() ?? null;");
    expect(record).toContain("dueFieldRef.current?.flush();");
    expect(record.indexOf("dueFieldRef.current?.flush();")).toBeLessThan(record.indexOf("addTask({"));
    // 桌面那条也是这么写的（口径同源，改一边就会被这条揪出来）
    expect(quickAddBarSource).toContain("const pendingDue = dueFieldRef.current?.pending() ?? null;");
  });

  it("记完只清标题、**不清点选**（跟桌面「选中的会保持生效」同一个口径）", () => {
    const record = slice(quickAddSheetSource, "function record()", "function toggleSeg");
    expect(record).toContain('setTitle("");');
    expect(record, "记完不许把点选一起清掉：连记三条不该重选清单").not.toContain("setPick(");
    // 焦点也留着，接着记下一条
    expect(record).toContain("inputRef.current?.focus();");
  });

  it("点预设 / 点「不要」把还欠着的那次去抖作废，免得它一会儿回来盖掉刚点的", () => {
    const pickDue = slice(quickAddSheetSource, "function pickDue(", "function record()");
    expect(pickDue).toContain("dueFieldRef.current?.cancel();");
    expect(quickAddSheetSource).toContain("onClick={() => pickDue(p.ymd)}");
    expect(quickAddSheetSource).toContain("onClick={() => pickDue(null)}");
  });

  it("一打开就聚焦，而且补敲两拍（安卓 WebView 在进场那一帧会把 focus 丢掉）", () => {
    expect(quickAddSheetSource).toContain("autoFocus");
    const focus = slice(quickAddSheetSource, "const el = inputRef.current;", "/** 点预设");
    expect((focus.match(/\.focus\(\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(focus).toContain("setTimeout");
  });

  it("回车 = 记下（手机键盘那颗写「完成」），不是往标题里塞换行", () => {
    expect(quickAddSheetSource).toContain('enterKeyHint="done"');
    const key = slice(quickAddSheetSource, "onKeyDown={(e) => {", "<CommitMark");
    expect(key).toContain('if (e.key !== "Enter" || e.nativeEvent.isComposing) return;');
    expect(key).toContain("record();");
  });
});

describe("③ 任务详情改属性：每一笔都走 TaskCard 用的那个 store 函数", () => {
  it("完成 / 取消完成", () => {
    const call = "task.done ? uncompleteTask(task.id) : completeTask(task.id)";
    expect(taskSheetSource).toContain(call);
    expect(taskCardSource).toContain(call);
  });

  it("放弃 / 取消放弃、删除", () => {
    for (const call of ["dropTasks([task.id], !task.droppedAt)", "deleteTasks([task.id]);"]) {
      expect(taskSheetSource, call).toContain(call);
      expect(taskCardSource, call).toContain(call);
    }
  });

  it("标题 / 备注 / 清单 / 重要性 / 标签 都从 updateTask 走", () => {
    for (const call of [
      "updateTask(task.id, { title:",
      "updateTask(task.id, { notes:",
      "updateTask(task.id, { listId: null })",
      "updateTask(task.id, { listId: l.id })",
      "updateTask(task.id, { priority: p })",
      "updateTask(task.id, { tags:",
    ]) {
      expect(taskSheetSource, call).toContain(call);
      expect(taskCardSource, call).toContain(call);
    }
    // 标题是一行字段：粘进来的换行照旧当空格吃掉
    expect(taskSheetSource).toContain("oneLine(");
  });

  it("需求方三件事（加 / 摘 / 全清）跟任务卡同一批函数", () => {
    for (const call of ["addTasksWho([task.id],", "removeTaskWho(task.id, w)", "setTasksWho([task.id], [])"]) {
      expect(taskSheetSource, call).toContain(call);
      expect(taskCardSource, call).toContain(call);
    }
  });

  it("循环那一句跟任务卡一字不差（没日期时要带上首个落点，否则循环永不触发）", () => {
    const line = "updateTask(task.id, { repeat: r, due: r ? task.due ?? firstOccurrence(r, today) : task.due });";
    expect(nl(taskSheetSource)).toContain(line);
    expect(nl(taskCardSource)).toContain(line);
  });

  it("子任务四件事：勾 / 改名 / 放弃 / 删，都走 store（变量名不同，形状一样）", () => {
    for (const re of [
      /toggleSubtask\(task\.id, \w+\.id\)/,
      /updateSubtask\(task\.id, \w+\.id, \{ title:/,
      /dropSubtask\(task\.id, \w+\.id, !\w+\.droppedAt\)/,
      /removeSubtask\(task\.id, \w+\.id\)/,
    ]) {
      expect(taskSheetSource, String(re)).toMatch(re);
      expect(taskCardSource, String(re)).toMatch(re);
    }
    // 加子任务：这一处**保留**快捷语法（「不用背语法」说的是「记一条」那张纸）
    expect(taskSheetSource).toContain('import { parseSubtaskInput } from "../core/parse";');
    expect(taskSheetSource).toContain("addSubtask(task.id, title, {");
    expect(taskSheetSource).toContain("priority: r.priority || null");
    expect(taskCardSource).toContain("priority: r.priority || null");
    // 只打了日期没打标题就一条都不加（跟任务卡同一个判据）
    expect(taskSheetSource).toContain("if (!title) return false;");
  });

  it("已完成的子任务沉底 + 攒够 3 条才收：跟任务卡共用 store 里那三个判据，不另定一套", () => {
    for (const fn of ["splitSubtasks", "foldDoneSubs", "SUB_DONE_PEEK"]) {
      expect(taskSheetSource, fn).toContain(fn);
      expect(taskCardSource, fn).toContain(fn);
    }
    expect(taskSheetSource).toContain("const canFoldDone = doneSubs.length >= SUB_DONE_PEEK;");
  });

  it("一个直改 state 的口子都没留（store 那批函数才带撤销栈和落盘）", () => {
    expect(taskSheetSource).not.toContain("appStore.setState");
    expect(quickAddSheetSource).not.toContain("appStore.setState");
  });
});

describe("③b 顺延次数：日期那一段照搬任务卡的「段开→段关整段算一次」", () => {
  // 少了这套，在手机上点两下日期就给这件事记上「顺延×2」——而这个数没有任何入口能清零。
  // 原委见 core/dateinput.ts 与 tests/commit-guards.test.ts
  it("段里的每一次写库都带 POPUP_WRITE（一律不数顺延）", () => {
    expect(taskSheetSource).toContain("const POPUP_WRITE = { noPostponeCount: true } as const;");
    expect(taskCardSource).toContain("const POPUP_WRITE = { noPostponeCount: true } as const;");
    expect(taskSheetSource).toContain("updateTask(task.id, { due: next, dueTime: time || null }, POPUP_WRITE);");
    expect(taskSheetSource).toContain(
      "updateTask(task.id, { due: d, dueTime: d ? draftTime || task.dueTime : null }, POPUP_WRITE);",
    );
  });

  it("结算挂在那一段的 effect 清理上（关这一段的路太多，一处处补迟早漏一条）", () => {
    expect(taskSheetSource).toContain('if (seg !== "date") return;');
    expect(taskSheetSource).toContain("return () => settleDueRef.current();");
    const settle = slice(taskSheetSource, "function settleDuePopup()", "settleDueRef.current = settleDuePopup;");
    expect(settle).toContain("dueFieldRef.current?.flush();"); // 欠着的那次先做掉再比
    expect(settle).toContain("if (written === undefined) return;"); // 别处改的日期不算这一笔
    expect(settle).toContain("cmpYMD(written, before) <= 0");
    expect(settle).toContain("postponeCount: cur.postponeCount + 1");
    expect(settle).toContain("coalesceKey: `task:${cur.id}:due`");
  });

  it("点预设先把还欠着的那次作废，不然它一会儿回来把预设盖掉", () => {
    const setDue = slice(taskSheetSource, "function setDue(", "function setRepeat");
    expect(setDue).toContain("dueFieldRef.current?.cancel();");
  });

  it("不像话的日子一个都不许进库（键盘敲年份那几拍的中间值）", () => {
    expect(taskSheetSource).toContain("isPlausibleYMD(dueRaw)");
  });
});

describe("④ 子任务行左滑：走共用的 useSwipeRow，露出「放弃 / 删除」两块", () => {
  it("一行一份手势状态，所以行必须是模块级组件（写在 render 里每次都会被卸载重建）", () => {
    expect(taskSheetSource).toContain('import { useSwipeRow } from "./swipe";');
    expect(taskSheetSource).toMatch(/^function SubRow\(/m);
    expect(taskSheetSource).toContain("const sw = useSwipeRow({ leftWidth: SUB_ACTIONS_W });");
  });

  it("露出来的宽度就是两颗 72px 的动作键（mobile.css 里 .swipe-act 的宽度）", () => {
    expect(taskSheetSource).toContain("const SUB_ACTIONS_W = 144;");
    expect(mobileCss).toContain(".swipe-act {");
    expect(mobileCss).toMatch(/\.swipe-act \{\s*\n?\s*width: 72px;/);
  });

  it("只做左滑，不做右滑（右滑完成是列表行的事，这儿一行一步没那么多花样）", () => {
    // 不给 onRight，useSwipeRow 自己就会把向右的位移钉死在 0
    expect(taskSheetSource).not.toMatch(/onRight\s*[:=]/);
  });

  it("动作条用的是 mobile.css 那两个类，颜色不在这儿另配一份", () => {
    expect(taskSheetSource).toContain('className="swipe-act drop"');
    expect(taskSheetSource).toContain('className="swipe-act delete"');
    expect(mobileCss).toContain(".swipe-act.drop");
    expect(mobileCss).toContain(".swipe-act.delete");
  });

  it("🔴 按动作键时别抢在它前面把行收回去（收回那一拍行本体会盖住按钮，删除会变成「点开」）", () => {
    expect(swipeSource).toContain('if ((e.target as HTMLElement | null)?.closest?.(".swipe-act")) return;');
    // 放行了这一下就不能再让监听「只响一次」：它得留着等下一次真的点在别处
    const listen = swipeSource.slice(swipeSource.indexOf('document.addEventListener("pointerdown"'));
    expect(listen.slice(0, 120)).not.toContain("once");
  });
});

describe("⑤ 两个 Host 只认 sheetStore 的栈顶", () => {
  it("都从 topSheet(s.stack) 读，关掉都调 closeSheet", () => {
    for (const [name, src] of [["任务详情", taskSheetSource], ["记一条", quickAddSheetSource]] as const) {
      expect(src, name).toContain('import { closeSheet, topSheet, useSheet } from "./sheetStore";');
      expect(src, name).toContain("const top = useSheet((s) => topSheet(s.stack));");
      expect(src, name).toContain("onClose={closeSheet}");
      // 开不开只由栈说了算：两张纸都只读栈顶 + 收自己，一次都不往栈上推
      expect(src, name).not.toContain("openSheet");
      expect(src, name).not.toContain("closeAllSheets");
    }
  });

  it("各认各的那一种；记一条还接住从清单页点 ＋ 带进来的清单", () => {
    expect(taskSheetSource).toContain('top?.kind === "task"');
    expect(taskSheetSource).toContain("expandable"); // 任务详情能往上拉成全屏
    expect(quickAddSheetSource).toContain('top?.kind === "quickAdd"');
    expect(quickAddSheetSource).toContain("top.listId ?? null");
    expect(quickAddSheetSource).toContain("listId, who: [], priority: 0, repeat: null,");
  });

  it("任务详情：这件事没了（删掉 / 撤销 / 同步拉走）就自己收掉", () => {
    expect(taskSheetSource).toContain("const gone = !!taskId && (!task || !!task.deletedAt);");
    expect(taskSheetSource).toContain("if (gone) closeSheet();");
    // 退场那 180ms 里栈已经空了，得留住最后那一份，别让纸在滑下去的路上突然变白
    expect(taskSheetSource).toContain("const lastRef = useRef<Task | null>(null);");
  });

  it("删除要按两下：不用 window.confirm（安卓 WebView 上那个系统弹窗会把页面冻住）", () => {
    expect(taskSheetSource).not.toContain("window.confirm");
    expect(taskSheetSource).toContain("setArmed(true);");
    expect(taskSheetSource).toContain("真的删？");
    // 第二下才真删，删完把纸收掉
    const del = taskSheetSource.slice(taskSheetSource.indexOf("if (!armed) {"));
    expect(del.indexOf("deleteTasks([task.id]);")).toBeLessThan(del.indexOf("closeSheet();") + 1);
    expect(del).toContain("closeSheet();");
  });
});

describe("样式：颜色只用 token，版式该钉的钉住", () => {
  it("mobile-sheet.css 里除了那两个全仓都没有 token 的颜色，没有第三个写死的色值", () => {
    const hex = [...new Set((sheetCss.match(/#[0-9A-Fa-f]{3,8}\b/g) ?? []).map((h) => h.toUpperCase()))].sort();
    // #C0564A 危险红、#FDFCF7 危险红上的前景，都跟 base.css / mobile.css 一字不差（settings.css 里有同样的注脚）
    expect(hex).toEqual(["#C0564A", "#FDFCF7"]);
    // 其余一律 var(--…)
    expect(sheetCss).toContain("var(--accent)");
    expect(sheetCss).toContain("var(--ink-3)");
    expect(sheetCss).toContain("var(--hair)");
  });

  it("底下那条「放弃 / 删除」钉在纸底不跟着滚：滚动权从 .msheet-body 收进 .msh-scroll", () => {
    expect(sheetCss).toContain(".msheet.msh-sheet > .msheet-body { display: flex; flex-direction: column; overflow: hidden; }");
    expect(sheetCss).toContain(".msh-scroll { flex: 1; min-height: 0; overflow-y: auto;");
    // 只对挂了 .msh-sheet 的纸生效，别的抽屉照旧
    expect(taskSheetSource).toContain('className="msh-sheet msh-task"');
    expect(quickAddSheetSource).toContain('className="msh-sheet msh-qa-sheet"');
  });

  it("🔴 记一条那排 chips 要能横着滚：.msheet 的 touch-action 必须留着 pan-x", () => {
    // touch-action 是**沿祖先链取交集**的：.msheet 写死 pan-y 会把纸里所有横向滚动区一起钉死
    expect(mobileCss).toContain("touch-action: pan-x pan-y;");
    expect(sheetCss).toContain("touch-action: pan-x;");
    expect(sheetCss).toContain(".msh-picks {");
  });

  it("原地改标题的框要把「不许选中」要回来（mobile.css 把 .swipe-body 里的一切都关掉了）", () => {
    expect(mobileCss).toContain(".swipe-body, .swipe-body * {");
    expect(sheetCss).toContain(".msh-sub input, .msh-sub textarea { -webkit-user-select: text; user-select: text; }");
  });

  it("任务是圆圈、子任务是圆角方框——一眼分得出这一行是「一件事」还是「一件事里的一步」", () => {
    expect(sheetCss).toMatch(/\.msh-cb \{[\s\S]{0,120}border-radius: 50%;/);
    expect(sheetCss).toMatch(/\.msh-sb \{[\s\S]{0,60}border-radius: 7px;/);
  });
});
