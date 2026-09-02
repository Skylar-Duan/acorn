// v1.11.0 · 手机端的壳子与列表（方向 A）。
//
// 跟 tests/mobile-layout.test.ts 一个路数：这一轮改的东西**在 jsdom 里一个像素都量不出来**
// （没有布局引擎、没有媒体查询、没有触摸），所以这份测试钉的是「改法还在不在源码里」。
// 每一条都对应一件在 390×844 上量过、或者用户点过名的事：
//
//   ① 手机上不渲染侧栏那一套（走底部五格导航），但**窄桌面窗口的抽屉一个字没删**
//   ② RowList 在手机上走 MobileRow，不画内嵌展开卡（卡片改成从底下抽出来的纸）
//   ③ 底部导航固定五项、固定不动；＋ 只在记得下东西的页面出现
//   ④ 清单页顶栏收干净：六颗颜色点和「删除清单」进「···」那张纸
//   ⑤ 动作单的候选日走现有的 duePresets，不在手机上另写一份
//   ⑥ App 把手机端那几张纸和登录页挂上了树
//   ⑦ 颜色全是 token、时长全是变量（六主题 × 深浅自动成立）
//
// 样式只能用 node:fs 读：vitest 默认不处理 CSS，`import x from "a.css?raw"` 读回来是空串，
// 那样断言会变成对着空字符串「全过」。类型见 tests/node-fs.d.ts。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { LONG_PRESS_MS, SLOP_PX } from "../src/core/touchSort";
import appSource from "../src/App.tsx?raw";
import rowListSource from "../src/components/RowList.tsx?raw";
import shellSource from "../src/mobile/MobileShell.tsx?raw";
import rowSource from "../src/mobile/MobileRow.tsx?raw";
import headSource from "../src/mobile/MobileHead.tsx?raw";
import actionSheetSource from "../src/mobile/ActionSheet.tsx?raw";
import listSettingsSource from "../src/mobile/ListSettingsSheet.tsx?raw";
import moreSource from "../src/views/MobileMore.tsx?raw";
import todaySource from "../src/views/Today.tsx?raw";
import listViewSource from "../src/views/ListView.tsx?raw";
import doneSource from "../src/views/Done.tsx?raw";

const read = (p: string) => readFileSync(p, "utf8");
const shellCss = read("src/styles/mobile-shell.css");
const mobileCss = read("src/styles/mobile.css");
const appCss = read("src/styles/app.css");

/** 仓库里 CRLF / LF 混着用，断言不许把行尾当内容的一部分 */
const nl = (s: string) => s.replace(/\r\n/g, "\n");
/** 写给后人的注释里出现什么都不算数，看的是真代码 */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\/.*$/gm, "");

describe("① 手机上不渲染侧栏，但窄桌面窗口那套抽屉一个字没删", () => {
  it("App 把 ☰ / Sidebar / 遮罩三件一起圈进 !isMobile", () => {
    const src = nl(appSource);
    expect(src).toContain('import { isMobile } from "./core/platform";');
    expect(src).toContain("{!isMobile && (");
    // 三件都在那个分支里
    const branch = src.slice(src.indexOf("{!isMobile && ("), src.indexOf("{isMobile ? <MobileShell>"));
    expect(branch).toContain('<button className="drawer-btn"');
    expect(branch).toContain("<Sidebar drawerOpen={drawer}");
    expect(branch).toContain('<div className="drawer-scrim"');
  });

  it("🔴 窄屏那套 CSS 原样留着：桌面把窗口拖窄仍然是桌面，它还得靠 ☰ 拉开侧栏", () => {
    expect(appCss).toContain("@media (max-width: 760px)");
    expect(appCss).toContain(".side.open { transform: none;");
    expect(nl(appCss)).toMatch(/\.drawer-btn \{\n\s*display: block;/);
  });

  it("正文被 MobileShell 包住；桌面照旧直接摆 body", () => {
    expect(appSource).toContain("{isMobile ? <MobileShell>{body}</MobileShell> : body}");
  });

  it("手机上那条 232px 的侧栏栏位要收掉，否则正文全挤在左边一格里", () => {
    expect(shellCss).toContain(".shell.mobile { grid-template-columns: 1fr; }");
  });

  it("🔴 正文要 flex: 1 + min-height: 0，否则列表一长就被裁掉且一点都滚不动", () => {
    // 不给 grow，.main 的高度 = 内容高度，而它自己 overflow: hidden、外面 body 也 hidden：
    // 滚动条本该出在 .view-body 上，它拿到的却是一个无限高的父盒子。实测过
    expect(shellCss).toContain(".mshell .main { flex: 1; min-height: 0; padding: 0; }");
    expect(appCss).toContain(".view-body {");
  });

  it("判的是 isMobile 不是窗口宽度：桌面把窗口拖窄仍然是桌面", () => {
    for (const [name, src] of [
      ["App", appSource],
      ["RowList", rowListSource],
      ["今天", todaySource],
      ["清单页", listViewSource],
      ["已完成", doneSource],
    ] as const) {
      expect(src, name).toContain("isMobile");
      expect(stripComments(src), name).not.toContain("innerWidth");
      expect(stripComments(src), name).not.toContain("matchMedia");
    }
  });
});

describe("② RowList：手机上走 MobileRow，不画内嵌展开卡", () => {
  it("有一条 isMobile 分支，画的是 MobileRow", () => {
    expect(rowListSource).toContain('import { isMobile } from "../core/platform";');
    expect(rowListSource).toContain('import MobileRow from "../mobile/MobileRow";');
    expect(rowListSource).toContain("if (isMobile) {");
    expect(rowListSource).toContain("<MobileRow");
  });

  it("这条分支里没有 CardSlot / TaskRow：卡片在抽屉里，行也换掉了", () => {
    const branch = rowListSource.slice(
      rowListSource.indexOf("if (isMobile) {"),
      rowListSource.indexOf("// 手搭一个**平铺**的数组"),
    );
    expect(branch).not.toContain("CardSlot");
    expect(branch).not.toContain("TaskRow");
    // 一组一张圆角卡
    expect(branch).toContain('<div className="mcard">');
    // 空组不画：否则剩一个 0 高但有边框的白盒子
    expect(branch).toContain("if (shown.length === 0) return null;");
  });

  it("🔴 桌面那条路一个字没动（B1 那套行 + 卡同时挂着还在）", () => {
    expect(rowListSource).toContain("<CardSlot");
    expect(rowListSource).toContain("collapsed={expanded || fold.hidden.has(key)}");
    expect(rowListSource).toContain("key={`card:${r.task.id}`}");
    expect(rowListSource).toContain("key={`row:${key}`}");
    // 分支必须排在那几个 hook 后面，不然下一个人在它上面加 hook 就出事
    expect(rowListSource.indexOf("useEffect(() => {")).toBeLessThan(rowListSource.indexOf("if (isMobile) {"));
    expect(rowListSource.indexOf("if (isMobile) {")).toBeLessThan(rowListSource.indexOf("<CardSlot"));
  });

  it("清单页 / 已完成也换成了 MobileRow（这两个视图不走 RowList）", () => {
    for (const [name, src] of [["清单页", listViewSource], ["已完成", doneSource]] as const) {
      expect(src, name).toContain('import MobileRow from "../mobile/MobileRow";');
      expect(src, name).toContain('<div className="mcard">');
    }
    // 桌面那条路照旧
    expect(doneSource).toContain("{g.rows.flatMap(renderRow)}");
    expect(listViewSource).toContain("card={() => <TaskCard task={t} />}");
  });
});

describe("③ 一行事：点圆圈 / 右滑 / 左滑 / 长按，四条路各归各的", () => {
  it("滑动走共用的 useSwipeRow，不另写一套", () => {
    expect(rowSource).toContain('import { useSwipeRow } from "./swipe";');
    expect(rowSource).toContain("onRight: toggleDone,");
    // 左滑那条动作条的宽度就是三块 72px（.swipe-act 定在 mobile.css）
    expect(rowSource).toContain("const ACT_W = 72;");
    expect(rowSource).toContain("const LEFT_FULL = ACT_W * 3;");
    expect(mobileCss).toContain(".swipe-act {");
    expect(mobileCss).toContain("width: 72px;");
  });

  it("完成走 completeTasks —— 那条带可撤销 toast 的路，勾错了有得退", () => {
    expect(rowSource).toContain("completeTasks([task.id]);");
    // 已了结的行：右滑和圆圈都变成「放回未完成」
    expect(rowSource).toContain("uncompleteTask(task.id);");
    expect(rowSource).toContain("dropTasks([task.id], false);");
  });

  it("左滑三个动作各调对应的 store 函数，做完把动作条收回去", () => {
    expect(rowSource).toContain("postponeTasks([task.id])");
    expect(rowSource).toContain("dropTasks([task.id], true)");
    expect(rowSource).toContain("deleteTasks([task.id])");
    expect(rowSource).toContain("swipe.close();");
    // 子任务行只动自己那一条，不打到母任务上
    expect(rowSource).toContain("postponeRows([{ task, sub }])");
    expect(rowSource).toContain("dropSubtask(task.id, sub.id, true)");
    expect(rowSource).toContain("removeSubtask(task.id, sub.id)");
  });

  it("已了结的行左边只剩一个删除（一件做完的事没有「推到明天」这回事）", () => {
    expect(rowSource).toContain("leftWidth: settled ? ACT_W : LEFT_FULL,");
    expect(rowSource).toContain("{!settled && (");
  });

  it("点一行 = 拉出任务详情那张纸，不再走桌面那个内嵌展开卡", () => {
    expect(rowSource).toContain('openSheet({ kind: "task", taskId: task.id });');
    expect(stripComments(rowSource)).not.toContain("expandTask");
  });

  it("长按 = 底部动作单；时长与滑动阈值跟侧栏排序共用一份常量", () => {
    expect(rowSource).toContain('import { LONG_PRESS_MS, SLOP_PX } from "../core/touchSort";');
    expect(rowSource).toContain("}, LONG_PRESS_MS);");
    expect(rowSource).toContain("> SLOP_PX");
    expect(rowSource).toContain('openSheet({ kind: "actions", taskId: task.id, subId: sub?.id });');
    expect(LONG_PRESS_MS).toBe(450);
    expect(SLOP_PX).toBe(10);
    // 手机上不再弹桌面那个右键菜单
    expect(stripComments(rowSource)).not.toContain("openCtxMenu");
  });

  it("抬手那一下 touchend 被取消：不然长按弹完单子，任务详情也跟着被拉出来", () => {
    expect(rowSource).toContain("function eatNextTouchEnd()");
    expect(rowSource).toContain('document.addEventListener("touchend", stop, { capture: true, once: true, passive: false });');
    expect(rowSource).toContain("eatNextTouchEnd();");
  });

  it("鼠标不做长按：桌面窗口拖窄仍然是桌面，那儿有右键", () => {
    expect(rowSource).toContain('if (e.pointerType === "mouse") return;');
  });

  it("一件事一行绝不折行：标题单行省略号，行高就是 --m-row-h", () => {
    expect(shellCss).toContain("height: var(--m-row-h);");
    const title = shellCss.slice(shellCss.indexOf(".mrow-title {"), shellCss.indexOf(".mrow-parent {"));
    expect(title).toContain("white-space: nowrap;");
    expect(title).toContain("text-overflow: ellipsis;");
    expect(mobileCss).toContain("--m-row-h: 58px;");
  });

  it("子任务行前面那句「母任务名 ›」限 6 个字，不然整行被它吃掉", () => {
    expect(rowSource).toContain("const PARENT_MAX = 6;");
    expect(rowSource).toContain("parent.length > PARENT_MAX");
  });

  it("上下留给列表滚动、左右归滑动：行上写死 touch-action: pan-y", () => {
    const mrow = shellCss.slice(shellCss.indexOf("\n.mrow {"), shellCss.indexOf(".mrow-bar {"));
    expect(mrow).toContain("touch-action: pan-y;");
  });
});

describe("④ 底部导航：固定五项、固定不动", () => {
  it("常驻四格 + 更多，一共五项", () => {
    const tabs = shellSource.slice(shellSource.indexOf("const TABS = ["), shellSource.indexOf("] as const;"));
    for (const id of ["inbox", "today", "plan", "done"]) expect(tabs).toContain(`id: "${id}"`);
    for (const label of ["随手记", "今天", "计划", "已完成"]) expect(tabs).toContain(label);
    // 第五格是「更多」，它不是 ViewId，走壳子自己的一个本地开关
    expect(shellSource).toContain("const [moreOpen, setMoreOpen] = useState(false);");
    expect(shellSource).toContain("更多");
    // 一共五颗 .mnav-tab（四颗 map 出来 + 更多那一颗）
    expect(shellSource.split("mnav-tab").length - 1).toBe(2);
  });

  it("「更多」不许扩 store 的 ViewId：桌面上根本没有这一页", () => {
    const storeSource = read("src/core/store.ts");
    expect(storeSource).not.toContain('"more"');
    expect(shellSource).not.toContain('navigate("more")');
  });

  it("导航固定在底下、不参与滚动，高度是 --m-nav-h + 手势条", () => {
    const nav = shellCss.slice(shellCss.indexOf(".mnav {"), shellCss.indexOf(".mnav-tab {"));
    expect(nav).toContain("position: absolute;");
    expect(nav).toContain("bottom: 0;");
    expect(nav).toContain("height: calc(var(--m-nav-h) + var(--m-safe-bottom));");
    expect(nav).toContain("backdrop-filter: blur(10px);");
    // 半透明纸底：老 WebView 不认 color-mix 就退成不透明，不会坏
    expect(nav).toContain("background: var(--card);");
    expect(nav).toContain("color-mix(in srgb, var(--card) 92%, transparent)");
  });

  it("正文给导航让出位置，toast / 批量条也抬到它上面", () => {
    expect(shellCss).toContain("padding: 0 0 calc(var(--m-nav-h) + var(--m-safe-bottom) + 28px);");
    expect(shellCss).toContain(".shell.mobile .toast,");
    expect(shellCss).toContain(".shell.mobile .bulk-bar {");
  });

  it("每一格都够手指点（--m-touch = 44px）", () => {
    expect(mobileCss).toContain("--m-touch: 44px;");
    expect(shellCss).toContain("min-height: var(--m-touch);");
  });

  it("行上那个 24px 的圈：看着是 24，按得着的是 44（伪元素撑命中区，不动圈本身）", () => {
    const hit = shellCss.slice(shellCss.indexOf(".mrow-cb::before {"), shellCss.indexOf(".mrow-cb.done {"));
    expect(hit).toContain("width: var(--m-touch);");
    expect(hit).toContain("height: var(--m-touch);");
    // 圈是 border 画出来的，加 padding 会把圈本身撑大——只能靠伪元素
    expect(hit).toContain("position: absolute;");
  });

  it("图标是 inline SVG、描边走 currentColor，不用 emoji", () => {
    const icons = read("src/mobile/icons.tsx");
    expect(icons).toContain('stroke="currentColor"');
    expect(icons).toContain('viewBox="0 0 24 24"');
    // emoji 的长相由系统字体决定、也跟不了主题色，导航上一个都不许有
    expect(shellSource).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });
});

describe("⑤ 悬浮「记一条」：只在记得下东西的页面出现", () => {
  it("点了拉出「记一条」那张纸，清单页记的默认就归这张清单", () => {
    expect(shellSource).toContain('openSheet({ kind: "quickAdd", listId: view === "list" ? listId : null })');
  });

  it("已完成 / 更多 / 设置 / 统计 / 回收站 上不画它", () => {
    const noFab = shellSource.slice(shellSource.indexOf("const NO_FAB"), shellSource.indexOf("export default function MobileShell"));
    for (const v of ["done", "settings", "stats", "trash"]) expect(noFab).toContain(`"${v}"`);
    expect(shellSource).toContain("const showFab = !moreOpen && !NO_FAB.includes(view);");
  });

  it("56px 的圆、accent 色，蹲在导航右上方", () => {
    const fab = shellCss.slice(shellCss.indexOf(".mfab {"), shellCss.indexOf(".mfab:active"));
    expect(fab).toContain("width: 56px;");
    expect(fab).toContain("height: 56px;");
    expect(fab).toContain("background: var(--accent);");
    expect(fab).toContain("bottom: calc(var(--m-nav-h) + var(--m-safe-bottom) + 16px);");
  });

  it("清单页那条常驻输入栏手机上不画（记一条只留 ＋ 一个入口）", () => {
    expect(listViewSource).toContain("{showAdd && !isMobile && (");
    // 空态那句话也跟着改：手机上没有「上面那条输入栏」可指
    expect(listViewSource).toContain("点右下角的 ＋ 记一条");
  });
});

describe("⑥ 顶栏：大标题 + 副标题 + 进度环 + 搜索圆钮", () => {
  it("进度环取代桌面沉在底部的「完成 2/6」，今天页把那一整块收了", () => {
    expect(todaySource).toContain("<MobileHead");
    expect(todaySource).toContain('ring={{ done: doneToday.length, total }}');
    // day-foot 整块只在桌面画
    expect(nl(todaySource)).toMatch(/\{!isMobile && \(\n\s*<div className="day-foot">/);
    // 桌面那一块一个字没动
    expect(todaySource).toContain('<span className="kbd-hint">');
  });

  it("环是 SVG，一件都没有时不画（0/0 会算出 NaN 把环画没）", () => {
    expect(headSource).toContain("const C = 2 * Math.PI * R;");
    expect(headSource).toContain("const ratio = total > 0 ? Math.max(0, Math.min(1, done / total)) : 0;");
    expect(headSource).toContain("{ring && ring.total > 0 && <ProgressRing");
  });

  it("搜索钮走现成的全局搜索浮层，不另做一个", () => {
    expect(headSource).toContain('import { setSearchOpen } from "../core/store";');
    expect(headSource).toContain("onClick={() => setSearchOpen(true)}");
  });

  it("大标题用文楷 30px；顶上留安全区，不画假状态栏", () => {
    expect(headSource).toContain('className={`serif mhead-title');
    expect(shellCss).toContain("font-size: 30px;");
    // 这条必须带 .mshell：上面那条 `.mshell .view-head { padding-left: 0 }` 是两个类，
    // 光写 `.mhead` 会被它把左边的 18px 抹掉，标题贴边被切掉半个字（实测过）
    expect(shellCss).toContain(".mshell .mhead {");
    expect(shellCss).toContain("padding: calc(var(--m-safe-top) + 14px) 18px 0;");
    expect(mobileCss).toContain("--m-safe-top: env(safe-area-inset-top, 0px);");
  });

  it("☰ 让出来的那 46px 缩进也收掉了（手机上没有那颗按钮）", () => {
    expect(appCss).toContain(".view-head { padding-left: 46px;");
    expect(shellCss).toContain(".mshell .view-head { padding-left: 0; }");
  });

  it("计划 / 已完成的筛选键同一份 JSX 喂两边，不分成两处写", () => {
    for (const [name, src] of [["计划", read("src/views/Plan.tsx")], ["已完成", doneSource]] as const) {
      expect(src, name).toContain("<MobileHead");
      expect(src, name).toContain("extra={");
      expect(src, name).toContain('<div className="view-head">');
    }
  });
});

describe("⑦ 清单页：顶栏收干净，颜色和删除进「···」那张纸", () => {
  // 注释里交代「色板和删除清单搬去哪儿了」不算数，看的是真代码
  const head = stripComments(
    listViewSource.slice(
      listViewSource.indexOf("{isMobile ? ("),
      listViewSource.indexOf('<div className="view-head">'),
    ),
  );

  it("手机版顶栏里没有色板、没有「删除清单」", () => {
    expect(head).not.toContain("LIST_COLORS");
    expect(head).not.toContain("删除清单");
    expect(head).not.toContain("deleteList");
  });

  it("只剩 返回 · 色点 + 名字 · N 件 · 「···」", () => {
    expect(head).toContain("onBack=");
    expect(head).toContain("dot={kind === \"list\" && list ? `var(--list-${list.color})` : null}");
    expect(head).toContain("{tasks.length} 件");
    expect(head).toContain('openSheet({ kind: "listSettings", listId: list.id })');
    // 返回回今天：手机上没有「上一页」这回事
    expect(head).toContain('navigate("today")');
  });

  it("🔴 桌面那一行原样还在（色板 + 删除清单 + 可改的清单名）", () => {
    const desk = listViewSource.slice(listViewSource.indexOf('<div className="view-head">'));
    expect(desk).toContain("LIST_COLORS.map((c) => (");
    expect(desk).toContain("删除清单");
    expect(desk).toContain("<ListNameInput key={list.id} list={list} />");
  });

  it("清单设置那张纸：改名 / 六色 / 顺序 / 删除，四件都在", () => {
    expect(listSettingsSource).toContain("renameList(list!.id, v)");
    expect(listSettingsSource).toContain("LIST_COLORS.map((c) => (");
    expect(listSettingsSource).toContain("setListColor(list.id, c)");
    expect(listSettingsSource).toContain("调整清单顺序");
    expect(listSettingsSource).toContain("deleteList(list.id);");
  });

  it("改名那个框装了「窗口失焦不是点走」那道闸", () => {
    expect(listSettingsSource).toContain("onBlur={() => { if (document.hasFocus()) commitName(); }}");
  });

  it("删除要按两下，而且说的是它**真做**的那件事（移回随手记，不是进回收站）", () => {
    expect(listSettingsSource).toContain("const [confirming, setConfirming] = useState(false);");
    expect(listSettingsSource).toContain("会移回随手记");
    // store.deleteList 干的就是这件事，别照着设计稿写「进回收站」
    expect(read("src/core/store.ts")).toContain('toast: "清单已删除，任务已移回随手记"');
    // 文件头那段注释里出现「进回收站」是在解释「为什么不照设计稿写」，不算数
    expect(stripComments(listSettingsSource)).not.toContain("进回收站");
  });
});

describe("⑧ 动作单：每个动作都对得上桌面右键菜单里那一条", () => {
  it("候选日走现有的 duePresets，不在手机上另写一份「明天 / 下周一」", () => {
    expect(actionSheetSource).toContain('import { duePresets, todayYMD } from "../core/dates";');
    expect(actionSheetSource).toContain("duePresets(today).map");
    const pane = stripComments(
      actionSheetSource.slice(
        actionSheetSource.indexOf('{pane === "date" && ('),
        actionSheetSource.indexOf('{pane === "priority" && ('),
      ),
    );
    expect(pane).not.toContain("明天");
    expect(pane).not.toContain("下周一");
    expect(pane).not.toContain("addDays(");
  });

  it("「选个日子…」用全仓唯一那个日期框，不手写 <input type=\"date\">", () => {
    expect(actionSheetSource).toContain('import DateField from "../components/DateField";');
    expect(actionSheetSource).not.toContain('type="date"');
    // 落库那句**只落库**：在这儿收单子等于把框拆掉，用户敲到一半的日子全落空
    const applyDue = actionSheetSource.slice(
      actionSheetSource.indexOf("const applyDue = "),
      actionSheetSource.indexOf("const applyPriority = "),
    );
    expect(applyDue).not.toContain("closeSheet()");
  });

  it("完成 / 放弃 / 推到明天 / 复制标题 / 删除，跟右键菜单一一对应", () => {
    const ctx = read("src/components/ContextMenu.tsx");
    for (const fn of ["completeTasks", "dropTasks", "postponeTasks", "deleteTasks", "setTasksList", "setTasksDue"]) {
      expect(actionSheetSource, fn).toContain(fn);
      expect(ctx, fn).toContain(fn);
    }
    expect(actionSheetSource).toContain("navigator.clipboard.writeText");
  });

  it("长按的是子任务时只动那一条，清单 / 需求方两格不出现", () => {
    expect(actionSheetSource).toContain("updateSubtask(task.id, sub.id,");
    expect(actionSheetSource).toContain('{!sub && tile("list", "换清单"');
    expect(actionSheetSource).toContain('{!sub && tile("who", "需求方"');
  });

  it("做完一个动作就把单子收了", () => {
    expect(actionSheetSource).toContain("const run = (fn: () => void) => () => {");
    expect(actionSheetSource).toContain("closeSheet();");
  });
});

describe("⑨ 更多：账号 + 四张格子 + 三张表", () => {
  it("账号卡两态：登录了进设置，没登录就是登录入口", () => {
    expect(moreSource).toContain('navigate("settings")');
    expect(moreSource).toContain('openLogin("manual")');
    expect(moreSource).toContain("登录，让手机和电脑记的是同一本");
    // 同步时刻直接用侧栏那份现成的算法，不另写一句
    expect(moreSource).toContain('import { syncFootState, useSync } from "../core/syncCtl";');
  });

  it("四张格子和三张表都走同一个 navigate，跟侧栏一个口径", () => {
    for (const v of ["calendar", "habits", "stats", "trash"]) {
      expect(moreSource, v).toContain(`navigate("${v}")`);
    }
    expect(moreSource).toContain('navigate("list", { listId: l.id })');
    expect(moreSource).toContain('navigate("who", { who })');
    expect(moreSource).toContain('navigate("tag", { tag })');
  });

  it("新建清单那个框同样装了「窗口失焦不是点走」那道闸", () => {
    expect(moreSource).toContain("if (!document.hasFocus()) return;");
    expect(moreSource).toContain("addList(v, LIST_COLORS[rawLists.length % LIST_COLORS.length]);");
  });

  it("点走任何一项都把「更多」收了", () => {
    expect(moreSource).toContain("const go = (fn: () => void) => () => {");
    expect(moreSource).toContain("onNavigate?.();");
    expect(shellSource).toContain("<MobileMore onNavigate={() => setMoreOpen(false)} />");
  });
});

describe("⑩ App 把手机端那几张纸和登录页挂上了树", () => {
  it("四张纸都挂了，而且只在手机上挂", () => {
    const hosts = appSource.slice(appSource.indexOf("{isMobile && ("), appSource.indexOf("<LoginPageHost />"));
    for (const h of ["<TaskSheetHost />", "<QuickAddSheetHost />", "<ActionSheetHost />", "<ListSettingsSheetHost />"]) {
      expect(hosts, h).toContain(h);
    }
    expect(hosts).not.toContain("LoginPageHost");
  });

  it("登录页两端都挂：桌面上它是居中弹窗", () => {
    expect(appSource).toContain('import { LoginPageHost } from "./components/LoginPage";');
    expect(appSource).toContain("<LoginPageHost />");
  });

  it("首启请人登录：判据走 core/fresh，登录态直接问 cloud.loadSession（不看异步填的那份）", () => {
    expect(appSource).toContain('import { isLoginLater, isPristineLocal, shouldOfferLogin } from "./core/fresh";');
    expect(nl(appSource)).toContain("cloud\n      .loadSession()");
    expect(appSource).toContain("shouldOfferLogin({");
    expect(appSource).toContain('openLogin("first-run")');
    // 只问一次；「找回数据」那一屏正等着拍板时不许压在它上面
    expect(appSource).toContain("const loginOffered = useRef(false);");
    expect(appSource).toContain("if (s.rescue) return;");
  });
});

describe("⑪ 首次进今天页的手势提示：一次性，不做横条", () => {
  it("只演一次，标记记在本机（acorn- 前缀，清空本机时会被一并扫掉）", () => {
    expect(rowSource).toContain('export const SWIPE_HINT_KEY = "acorn-swipe-hinted";');
    expect(rowSource).toContain("localStorage.setItem(SWIPE_HINT_KEY, \"1\");");
    expect(todaySource).toContain("const hint = useSwipeHint();");
    // 整页最上面那一行才演；逾期组有行时今天组就不演
    expect(todaySource).toContain("hintFirstRow={hint && overdueRows.length === 0}");
    expect(rowListSource).toContain("hint={hintFirstRow && i === 0}");
  });

  it("动画时长写成 --dur-2 的倍数，不是一个字面值", () => {
    expect(shellCss).toContain("animation: mrow-hint calc(var(--dur-2) * 9) var(--ease);");
    expect(shellCss).toContain("@keyframes mrow-hint {");
  });
});

describe("⑫ 颜色全是 token、时长全是变量（六主题 × 深浅自动成立）", () => {
  it("mobile-shell.css 里除了那一抹删除红，没有别的写死色值", () => {
    const hexes = [...shellCss.matchAll(/#[0-9A-Fa-f]{3,8}\b/g)].map((m) => m[0]);
    // #C0564A 是「删除」那一档的红，themes.css 里没有对应 token，
    // mobile.css 的 .swipe-act.delete 用的也是它——两处必须是同一个值
    expect([...new Set(hexes)]).toEqual(["#C0564A"]);
    expect(mobileCss).toContain(".swipe-act.delete { background: #C0564A; }");
  });

  it("也没有裸的 rgb()/hsl()（阴影那几处除外，它们是黑色透明度）", () => {
    const bad = shellCss
      .split(/\r?\n/)
      .filter((line: string) => /\b(rgb|hsl)a?\(/.test(line))
      .filter((line: string) => !line.includes("box-shadow"));
    expect(bad).toEqual([]);
  });

  it("transition / animation 一律走 --dur-* 和 --ease", () => {
    const lines = shellCss.split(/\r?\n/).filter((line: string) => /\b(transition|animation):/.test(line));
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines) {
      expect(line, line.trim()).toMatch(/var\(--dur-[12]\)/);
      expect(line, line.trim()).toMatch(/var\(--ease\)/);
    }
  });

  it("尺度都从 mobile.css 那几个 --m-* 变量来，不各写各的", () => {
    for (const v of ["--m-row-h", "--m-radius", "--m-nav-h", "--m-safe-top", "--m-safe-bottom", "--m-touch"]) {
      expect(mobileCss, v).toContain(`${v}:`);
      expect(shellCss, v).toContain(`var(${v})`);
    }
  });
});
