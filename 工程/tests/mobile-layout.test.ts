// v1.10.0 · 手机端（安卓）排版追平桌面。
//
// 这一轮修的东西**在 jsdom 里一个像素都量不出来**（没有布局引擎，媒体查询也不生效），
// 所以这份测试钉的是「改法还在不在源码里」——每一条都对应一个在 390×844 上实测过的病：
//
//   ① 任务卡横着长出屏幕（.card-slot 缺 min-width: 0 + 整句改那排 chips 不换行）
//      实测：卡片宽 839px、屏幕 390px，卡内 71 个元素挂在屏幕外，而 body 不能横滚 = 永远点不到
//   ② 设置页「云账号」被裁（.set-fold-inner 同一个病）：「立即同步」整颗在屏外
//   ③ index.html 少 viewport-fit=cover → 六处 env(safe-area-inset-*) 恒等于 0
//   ④ 子任务链三行长得一模一样（省略号全落在母任务名上）
//   ⑤ 子任务的「放弃 / 删除」靠 hover 显形，手指没有 hover = 永久隐形
//   ⑥ 四象限和日历在手机上一条媒体查询都没有
//
// 样式只能用 node:fs 读：vitest 默认不处理 CSS，`import x from "a.css?raw"` 读回来是空串，
// 那样断言会变成对着空字符串「全过」。类型见 tests/node-fs.d.ts。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { LONG_PRESS_MS, SLOP_PX } from "../src/core/touchSort";
import taskRowSource from "../src/components/TaskRow.tsx?raw";
import calendarSource from "../src/views/Calendar.tsx?raw";
import statsSource from "../src/views/StatsView.tsx?raw";
import doneSource from "../src/views/Done.tsx?raw";
import settingsSource from "../src/views/Settings.tsx?raw";

const read = (p: string) => readFileSync(p, "utf8");
const appCss = read("src/styles/app.css");
const baseCss = read("src/styles/base.css");
const settingsCss = read("src/styles/settings.css");
const calendarCss = read("src/styles/calendar.css");
const quadrantCss = read("src/styles/quadrant.css");
const overlaysCss = read("src/styles/overlays.css");
const statsCss = read("src/styles/statsview.css");
const indexHtml = read("index.html");

const NARROW = "@media (max-width: 760px)";

/** 从某个断点块起往后的那一段（够断言「这一句写在窄屏块里」） */
function narrowPart(css: string): string {
  const i = css.indexOf(NARROW);
  expect(i, "这个文件里没有窄屏断点").toBeGreaterThan(-1);
  return css.slice(i);
}

/** 取一个 @media 块的完整内容（数花括号，别用「找下一个 }」——那会在第一条规则就断） */
function mediaBlock(css: string, header: string): string {
  const i = css.indexOf(header);
  expect(i, `找不到断点：${header}`).toBeGreaterThan(-1);
  let depth = 0;
  for (let j = css.indexOf("{", i); j < css.length; j++) {
    if (css[j] === "{") depth++;
    else if (css[j] === "}" && --depth === 0) return css.slice(i, j + 1);
  }
  throw new Error(`${header} 这个块没有收口`);
}

/** 仓库里 CRLF / LF 混着用，断言不许把行尾当内容的一部分 */
const nl = (s: string) => s.replace(/\r\n/g, "\n");

describe("根因：0fr↔1fr 折叠容器的 min-width 跟 min-height 是一对", () => {
  // v1.9.1 已经在 .row-slot 上修过一次（tests/row-tail.test.ts 钉着），
  // 但同一批容器还有三处漏网，桌面宽度全看不出来
  it(".card-slot > * 两个方向都写了（漏了 min-width 的话任务卡宽 839px）", () => {
    expect(appCss).toContain(".card-slot > * { min-height: 0; min-width: 0; }");
  });

  it(".set-fold > .set-fold-inner 两个方向都写了（漏了的话云账号那节宽 429px）", () => {
    expect(settingsCss).toContain(
      ".set-fold > .set-fold-inner { min-height: 0; min-width: 0; padding-top: 3px; }",
    );
  });

  it(".side-fold > * 也补上了（抽屉只有 300px，长清单名会把整块顶出去）", () => {
    expect(appCss).toContain(".side-fold > * { min-height: 0; min-width: 0; }");
  });

  it("🔴 .row-slot 那条老的一个字都没动", () => {
    // 这一条是上一版最值钱的一行，改这一轮时最容易被顺手「统一」掉
    expect(nl(appCss)).toMatch(
      /\.row-slot > \.task-row \{\n\s*min-height: 0;\n\s*min-width: 0;/,
    );
  });
});

describe("P0-1 任务卡：把卡顶宽的是「整句改」那排不可收缩的 chips", () => {
  const mobile = narrowPart(appCss);

  it("窄屏让输入框和 chips 各占一整行、都能换行", () => {
    expect(mobile).toContain(".tc-sentence .si-wrap { flex-wrap: wrap; }");
    expect(mobile).toContain(".tc-sentence .si-input { min-width: 0; flex: 1 1 100%; }");
    expect(mobile).toContain(".tc-sentence .si-chips { flex: 1 1 100%; flex-wrap: wrap; }");
  });

  it("这三条必须比 syntaxinput.css 里的本体多一层类，否则加载顺序在后面盖不住", () => {
    // syntaxinput.css 是组件按需引入的，排在 app.css 之后；靠 specificity 赢，不靠顺序
    for (const sel of [".tc-sentence .si-wrap", ".tc-sentence .si-input", ".tc-sentence .si-chips"]) {
      expect(mobile).toContain(sel);
    }
  });

  it("换行之后 999px 的圆角收成常规圆角，而且那条写在 .tc-sentence 本体**后面**", () => {
    // 同为一个类名谁在后面谁赢，而上面那个窄屏大块在本体之前——.chain-caret 踩过一次
    const body = appCss.indexOf(".tc-sentence {");
    const narrow = appCss.indexOf(".tc-sentence { flex-wrap: wrap; border-radius: var(--r-md); }");
    expect(body).toBeGreaterThan(-1);
    expect(narrow).toBeGreaterThan(body);
  });

  it("子任务行给标题留了下限，多挂一个「已放弃」标签也不会把标题挤成三四个字", () => {
    expect(mobile).toContain(".task-card .subs .sub-row { flex-wrap: wrap; row-gap: 2px; }");
    expect(mobile).toContain(".task-card .subs .sub-row textarea { min-width: 6em; }");
  });
});

describe("P0-5 手指没有 hover：子任务的「放弃 / 删除」不能靠 hover 才显形", () => {
  it("两条 hover 显形规则都圈进了 @media (hover: hover)", () => {
    const block = mediaBlock(appCss, "@media (hover: hover)");
    expect(block).toContain(".task-card .subs .sub-row:hover .rm");
    expect(block).toContain(".task-card .subs .sub-row:hover .sub-drop");
    // 变红那条也在里面：手机上它是常驻件，没有「扫过才变红」这回事
    expect(block).toContain(".task-card .subs .rm:hover { color: #C0564A; }");
  });

  it("没有 hover 的设备上两颗常驻显示，并撑到手指按得准的尺寸", () => {
    const block = mediaBlock(appCss, "@media (hover: none)");
    expect(block).toContain(".task-card .subs .rm");
    expect(block).toContain(".task-card .subs .sub-drop");
    expect(block).toContain("opacity: .55;");
    expect(block).toContain("min-width: 30px;");
    expect(block).toContain("min-height: 30px;");
    // 13px 的方框手指按不准，勾对号是按 13px 的盒子摆的，得一起放大
    expect(block).toContain(".task-card .subs .sb { width: 18px; height: 18px; }");
    expect(block).toContain(".task-card .subs .sb.done::after");
  });

  it("「已经放弃的那条常驻显示 ↩」留在 hover 块外面——那是老规矩，两种设备都要", () => {
    expect(appCss).toContain(".task-card .subs .sub-row.dropped .sub-drop { opacity: 1; }");
  });
});

describe("P0-3 子任务链：母任务名和子任务名各自省略", () => {
  it("TaskRow 把「›」和子任务名都包进了 span", () => {
    // 裸文本节点是匿名 flex 项，拿不到 text-overflow：省略号会全落在母任务名上，
    // 三行子任务行长得一模一样。「›」也得单独拎出来，否则母任务名被省略时它一起被吃掉
    expect(taskRowSource).toContain('<span className="chain-sep"> › </span>');
    expect(taskRowSource).toContain('<span className="chain-self">{sub.title || "（未命名）"}</span>');
    expect(taskRowSource).not.toContain("{task.title || \"（未命名）\"} ›");
  });

  it("窄屏只给链行开 flex（给普通行开会把 ellipsis 退化成硬裁）", () => {
    const mobile = narrowPart(appCss);
    expect(mobile).toContain(".task-row .title:has(.chain-parent) { display: flex; align-items: baseline; }");
    expect(mobile).toContain(".task-row .title .chain-parent");
    // 左右空格得靠 padding：成了 flex 项之后 `<span> › </span>` 前后的空格会被折掉
    expect(mobile).toContain(".task-row .title .chain-sep { flex: none; padding: 0 .25em; }");
    expect(mobile).toContain(".task-row .title .chain-self");
    // 母任务名最多占 45%，剩下的留给子任务名
    expect(mobile).toContain("max-width: 45%;");
  });
});

describe("P0-4 浮层：min-width 不能写死成比手机屏还宽", () => {
  it("base.css 的默认值改成 min(...)，以后新加的浮层不会再重犯", () => {
    expect(baseCss).toContain("min-width: min(480px, calc(100vw - 24px));");
    expect(baseCss).not.toContain("min-width: 480px;");
  });

  it("命令面板 / 全局搜索 / 找回数据三个漏网的，窄屏块里补齐了", () => {
    const mobile = narrowPart(overlaysCss);
    expect(mobile).toContain(".modal.cp-modal, .modal.so-modal, .modal.rescue");
    expect(mobile).toContain("min-width: 0; width: calc(100vw - 24px);");
  });

  it("overlays.css 里 .cl-* / .nd-* 的桌面规则一个字没动", () => {
    expect(overlaysCss).toContain(
      ".modal.cl-modal { width: min(680px, calc(100vw - 48px)); min-width: 0; max-width: 680px;",
    );
    expect(overlaysCss).toContain(".nd-modal { padding: 22px 24px 16px; min-width: 420px; max-width: 520px; }");
  });
});

describe("P0-6 安卓 15 起强制 edge-to-edge", () => {
  it("index.html 的 viewport 带 viewport-fit=cover", () => {
    // 少这一句，CSS 里六处 env(safe-area-inset-*) 全部按 0 算，
    // max(8px, 0) 退化成 8px：☰ 被状态栏压住、toast 被手势条盖掉
    expect(indexHtml).toContain("viewport-fit=cover");
    expect(indexHtml).toMatch(
      /<meta name="viewport" content="width=device-width, initial-scale=1\.0, viewport-fit=cover"/,
    );
  });

  it("窄屏正文底部也留出手势条的位置（原来只留了顶部）", () => {
    const mobile = narrowPart(appCss);
    expect(mobile).toContain(".main { padding: max(10px, env(safe-area-inset-top)) 12px 0; }");
    expect(mobile).toContain(".view-body { padding-bottom: calc(30px + env(safe-area-inset-bottom)); }");
  });
});

describe("P0-7 / P1-1 四象限与日历：两个视图原来一条手机媒体查询都没有", () => {
  it("四象限窄屏改单列四段，滚动交回给整页", () => {
    expect(quadrantCss).toContain(NARROW);
    const mobile = narrowPart(quadrantCss);
    expect(mobile).toContain(".view-body.quad-body { overflow-y: auto; }");
    expect(mobile).toContain("grid-template-columns: 1fr;");
    expect(mobile).toContain("grid-template-rows: none;");
    // 每格不再各自开一个小滚动区
    expect(mobile).toContain(".quad-cell-body { overflow: visible; }");
  });

  it("日历窄屏：格子里只剩日期 + 圆点，条目标题藏起来", () => {
    expect(calendarCss).toContain(NARROW);
    const mobile = narrowPart(calendarCss);
    expect(mobile).toContain(".cal-task .cal-title { display: none; }");
    expect(mobile).toContain(".cal-cell .cal-task .flag { width: 6px; height: 6px; border-radius: 50%; }");
    // 没设重要性的那档 .flag 是透明的，不给颜色就看不见
    expect(mobile).toContain(".cal-cell .cal-task .flag.p0 { background: var(--ink-3); }");
    // 整格是一个点击区，6px 的圆点自己不接点击
    expect(mobile).toContain("pointer-events: none;");
  });

  it("日历周视图窄屏拍成七行，列头关掉、日期旁边自己写周几", () => {
    const mobile = narrowPart(calendarCss);
    expect(mobile).toContain(".cal-body.cal-week-mode .cal-week { display: none; }");
    expect(mobile).toContain(".cal-grid.week { grid-template-columns: 1fr; grid-auto-rows: min-content; }");
    expect(mobile).toContain(".cal-grid.week .cal-wd { display: inline;");
    // 桌面 / 月视图里这个标签是关着的
    expect(calendarCss).toContain(".cal-wd { display: none; }");
    expect(calendarSource).toContain('mode === "week" ? " cal-week-mode" : ""');
  });

  it("点一格 → 下面列出当天的事，而且这块只在窄屏出现", () => {
    expect(calendarSource).toContain("const [picked, setPicked] = useState<string | null>(null);");
    expect(calendarSource).toContain('className="cal-daylist"');
    expect(calendarSource).toContain("setPicked((cur) => (cur === ymd ? null : ymd))");
    // 桌面格子里写得下标题，不需要这一层
    expect(calendarCss).toContain(".cal-daylist { display: none; }");
    expect(nl(narrowPart(calendarCss))).toMatch(/\.cal-daylist \{\n\s*display: block;/);
  });

  it("展开的任务卡在窄屏不再被压在 45% 屏高的小窗里", () => {
    expect(calendarCss).toContain(".cal-detail { flex: none; max-height: 45%;");
    expect(narrowPart(calendarCss)).toContain(".cal-detail { max-height: none; overflow: visible; }");
  });

  it("P2-2「今天」那个圆圈补了 flex: none（窄格子里被压成竖椭圆）", () => {
    expect(calendarCss).toContain("width: 22px; height: 22px; flex: none;");
  });
});

describe("P1-3 手机上没有右键：长按弹同一份菜单", () => {
  it("长按的两个数跟侧栏拖动排序共用一套常量，不另定一个", () => {
    expect(taskRowSource).toContain('import { LONG_PRESS_MS, SLOP_PX } from "../core/touchSort";');
    expect(taskRowSource).toContain("}, LONG_PRESS_MS);");
    expect(taskRowSource).toContain("> SLOP_PX");
    expect(LONG_PRESS_MS).toBe(450);
    expect(SLOP_PX).toBe(10);
  });

  it("右键和长按共用一个 openMenuAt，菜单内容不会两条路各写一份", () => {
    expect(taskRowSource).toContain("function openMenuAt(x: number, y: number)");
    expect(taskRowSource).toContain("openMenuAt(e.clientX, e.clientY);");
  });

  it("鼠标不抢：pointerType === \"mouse\" 直接退出，桌面照旧走右键", () => {
    expect(taskRowSource).toContain('if (e.pointerType === "mouse") return;');
  });

  it("按下就滑当成滚动，整个手势作废", () => {
    expect(taskRowSource).toContain("if (Math.abs(e.clientX - p.x) > SLOP_PX || Math.abs(e.clientY - p.y) > SLOP_PX) clearPress();");
    expect(taskRowSource).toContain("onPointerCancel={clearPress}");
  });

  it("抬手那一下 touchend 被取消：不然菜单会被自己补发的 mousedown 当场关掉", () => {
    // ContextMenu 判「点了别处就关」用的是 document 上的 mousedown（捕获阶段），
    // 而 stopPropagation 管不到同一个节点上的别的监听——只能从源头把兼容事件掐掉
    expect(taskRowSource).toContain("function eatNextTouchEnd()");
    expect(taskRowSource).toContain('document.addEventListener("touchend", stop, { capture: true, once: true, passive: false });');
    expect(taskRowSource).toContain("eatNextTouchEnd();");
  });

  it("长按的残留标记在下一次按下时作废，不会白吞掉后面那一次轻点", () => {
    expect(taskRowSource).toContain("menuJustOpened.current = false;");
  });
});

describe("P1-4 / P1-5 给手机用户看的东西，别指他做不到的操作", () => {
  it("统计页导出：安卓上 save() 给回的是 content:// URI，fs::write 写不了，改成复制", () => {
    expect(statsSource).toContain("if (!persist.inTauri || !hasDesktopFeatures) {");
    expect(statsSource).toContain('showToast("本周小结已复制到剪贴板", false);');
    expect(statsSource).toContain('{hasDesktopFeatures ? "导出本周小结 (Markdown)" : "复制本周小结 (Markdown)"}');
  });

  it("「已完成」表头那句「或右键」按平台分叉", () => {
    expect(doneSource).toContain('` · 点圆圈${hasDesktopFeatures ? "或右键" : ""}可以取消放弃`');
  });

  it("设置页「在单独的窗口里打开」按平台分叉（安卓开不了独立窗口）", () => {
    expect(settingsSource).toContain(
      '{hasDesktopFeatures ? "在单独的窗口里打开，一组可以照着抄的例子" : "一组可以照着抄的例子"}',
    );
  });
});

describe("P1-6 折叠起来的那一块不能还占着命中区", () => {
  it("侧栏「更多」收起时内容不可见也不可点（内容仍在树上，只是高度收成 0）", () => {
    expect(nl(appCss)).toMatch(/\.side-fold\.shut \{\n\s*visibility: hidden;/);
    // visibility 只许挂在容器上：`> *` 那一路被 tests/motion.test.ts 明令禁止
    expect(appCss).not.toContain(".side-fold.shut > ");
  });

  it("设置页收起的那一节同理", () => {
    expect(nl(settingsCss)).toMatch(/\.set-fold\.shut \{\n\s*visibility: hidden;/);
  });

  it("🔴 两条 transition 写在一起：只留 visibility 会把高度过渡顶掉，收起变硬切", () => {
    const both = "transition: grid-template-rows var(--dur-2) var(--ease), visibility var(--dur-2) var(--ease);";
    expect(appCss).toContain(both);
    expect(settingsCss).toContain(both);
    // 原来那条一行式的收起规则原样还在（motion.test.ts 也钉着它）
    expect(appCss).toContain(".side-fold.shut { grid-template-rows: 0fr; }");
    expect(settingsCss).toContain(".set-fold.shut { grid-template-rows: 0fr; }");
  });
});

describe("P1-2 触点：低于 36px 的那几处", () => {
  it("窄屏统一抬高（侧栏那颗「＋」只有 22×14）", () => {
    const mobile = narrowPart(appCss);
    expect(mobile).toContain(".side .group-title > button { min-width: 34px; min-height: 34px; }");
    expect(mobile).toContain(".btn { padding: 7px 12px; min-height: 36px; }");
    expect(mobile).toContain(".popmenu .item { padding-top: 9px; padding-bottom: 9px; }");
  });

  it("随手记那颗「?」的窄屏版写在本体**后面**才盖得住", () => {
    const body = appCss.indexOf(".quick-add .qa-help {");
    const narrow = appCss.indexOf(".quick-add .qa-help { width: 30px; height: 30px; }");
    expect(body).toBeGreaterThan(-1);
    expect(narrow).toBeGreaterThan(body);
  });

  it("右键菜单项写在 contextmenu.css 自己里（它的加载顺序在 app.css 之后）", () => {
    const ctxCss = read("src/styles/contextmenu.css");
    expect(ctxCss).toContain(NARROW);
    expect(narrowPart(ctxCss)).toContain(".ctx-item { padding-top: 9px; padding-bottom: 9px; }");
  });

  it("「列表 / 四象限」「浅色 / 深色」这些分段键写在各自的文件里，同理", () => {
    expect(narrowPart(read("src/styles/plan.css"))).toContain(
      ".all-sort button { padding-top: 7px; padding-bottom: 7px; }",
    );
    expect(narrowPart(settingsCss)).toContain(".set-seg button { padding-top: 7px; padding-bottom: 7px; }");
    expect(narrowPart(calendarCss)).toContain(".cal-nav button { min-height: 34px; }");
  });
});

describe("P0-2 / P2 打磨：设置页与统计页的窄屏块", () => {
  it("设置页的行允许换行，右对齐在换行后只会开个洞", () => {
    const mobile = narrowPart(settingsCss);
    expect(mobile).toContain(".set-row { flex-wrap: wrap; }");
    expect(mobile).toContain(".set-ctl { margin-left: 0; }");
    expect(mobile).toContain(".acct-line { flex-wrap: wrap; min-width: 0; }");
    // 长邮箱允许在任意位置断行
    expect(mobile).toContain("overflow-wrap: anywhere;");
  });

  it("P2-5 统计页「每周回顾」标题不再折成两行，按钮独占一行", () => {
    expect(statsCss).toContain(NARROW);
    const mobile = narrowPart(statsCss);
    expect(mobile).toContain(".stats-week { flex-wrap: wrap;");
    expect(mobile).toContain(".stats-week-titlerow { flex-wrap: wrap; }");
    expect(mobile).toContain(".stats-week > .btn { margin-left: 0; width: 100%; }");
  });

  it("P2-1 .task-row .meta 的 basis 减掉自己那 30px 左缩进", () => {
    expect(narrowPart(appCss)).toContain(
      ".task-row .meta { flex: 1 0 calc(100% - 30px); margin-left: 30px; justify-content: flex-start; }",
    );
  });

  it("P2-6 随手记那句「选中的会保持生效」窄屏不画（它整条在屏幕外）", () => {
    expect(narrowPart(appCss)).toContain(".qa-tip { display: none; }");
  });
});
