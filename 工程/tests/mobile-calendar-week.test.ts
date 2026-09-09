// v1.14.1 · 手机日历的「周」视图改成竖着排。
//
// PM v1.13.0 真机原话：「手机版，日历里面的周视窗不对，我想要的是竖着的，有点像其他日历的
// 周视窗，能够显示有多少任务，甚至部分文字显示（测评宽度够不够，不够的话就算了）的那种」。
// 原来那版是七列拍成七行的 48px 窄条，一行里只有日期圆 + 周几 + 几颗点——看得出忙不忙，
// 看不出忙什么。现在一行三段：日期（几号 + 周几，今天高亮）· 这天的事（写标题，最多两条，
// 多的挂「+N」）· 右边待办 / 做完各几条。这三处跟网格底下那块「这一天」的清单**同一个口径：
// 数行**（母任务一行、每条当天勾掉的子任务各一行），加起来必须严丝合缝。
//
// 跟 mobile-calendar.test.ts 一个路数：像素在 jsdom 里量不出来（没有布局引擎、没有媒体查询），
// 真的宽度在 Playwright 那一轮量过（360 / 390 / 430 三个宽度，中间标题栏 224 / 254 / 294px，
// 13px 的汉字写得下 17 / 19 / 22 个——所以走「显示文字」这条路，没退回只显示数量）。
// 这里钉两件事：① weekLines 这个纯函数——一行列哪几条、还剩几条，「N 件」的口径不许被改走样；
// ② 改法还在不在源码里，以及**桌面那一套一个字没动**。
// 样式只能用 node:fs 读：vitest 默认不处理 CSS，`import x from "a.css?raw"` 读回来是空串。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { newTask } from "../src/core/model";
import type { Subtask, Task } from "../src/core/model";
import type { DateRow } from "../src/core/store";
import { rowTaskIds } from "../src/core/store";
import { weekLines } from "../src/views/Calendar";
import calendarSource from "../src/views/Calendar.tsx?raw";

const read = (p: string) => readFileSync(p, "utf8");
const calendarCss = read("src/styles/calendar.css");
const MSHELL_MARK = "---------- 手机端（.mshell";
/** calendar.css 末尾那一节手机端规则 */
const mshellPart = calendarCss.slice(calendarCss.indexOf(MSHELL_MARK));
/** .mshell 那一节之前的全部内容 = 桌面 + 窄屏媒体查询。这一路一个字都不许动 */
const beforeMshell = calendarCss.slice(0, calendarCss.indexOf(MSHELL_MARK));
/** 周视图那一小节（新写的），单独挑出来验作用域和 token */
const weekCss = mshellPart.slice(mshellPart.indexOf("---------- 周视图：一天一行竖着排"));

/** 写给后人的注释里出现什么都不算数，看的是真代码 */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\/.*$/gm, "");

const task = (id: string, title: string): Task => newTask({ id, title });
const sub = (id: string, title: string): Subtask => ({ id, title, done: true });
const row = (t: Task, s: Subtask | null = null): DateRow => ({ task: t, sub: s });

describe("① 一行里列哪几条事（weekLines）", () => {
  it("还欠着的排前面、做完的排后面", () => {
    const a = task("a", "写周报");
    const b = task("b", "交房租");
    const { lines, rest } = weekLines([a], [row(b)], false, 4);
    expect(lines.map((l) => l.title)).toEqual(["写周报", "交房租"]);
    expect(lines.map((l) => l.kind)).toEqual(["plan", "ok"]);
    expect(rest).toBe(0);
  });

  it("逾期那天欠着的是 warn 那一档，今天和以后的是 accent 那一档", () => {
    const a = task("a", "写周报");
    expect(weekLines([a], [], true, 4).lines[0].kind).toBe("late");
    expect(weekLines([a], [], false, 4).lines[0].kind).toBe("plan");
  });

  it("一件事的几条子任务同一天勾完就列几行——底下那块清单也是这么列的，两边一条对一条", () => {
    const t = task("t", "装修");
    const { lines, rest } = weekLines([], [row(t, sub("s1", "量尺寸")), row(t, sub("s2", "选瓷砖"))], false, 4);
    expect(lines.map((l) => l.title)).toEqual(["量尺寸", "选瓷砖"]);
    expect(rest).toBe(0);
    // 同一件事的两行，key 不能撞
    expect(new Set(lines.map((l) => l.key)).size).toBe(2);
  });

  it("母任务自己勾掉的那一行写母任务的名字", () => {
    const t = task("t", "报销");
    expect(weekLines([], [row(t)], false, 4).lines[0].title).toBe("报销");
  });

  it("母任务还欠着、某条子任务今天做完了 → 两行：一条待办一条已完成，那本来就是两件事", () => {
    const t = task("t", "装修");
    const { lines } = weekLines([t], [row(t, sub("s1", "量尺寸"))], false, 4);
    expect(lines.map((l) => l.kind)).toEqual(["plan", "ok"]);
    expect(lines.map((l) => l.title)).toEqual(["装修", "量尺寸"]);
    // key 不能撞车：同一件事出两行，React 会当场报重复 key
    expect(new Set(lines.map((l) => l.key)).size).toBe(2);
  });

  it("放不下的算进 rest 挂「+N」；正好放得下时 rest 是 0", () => {
    const many = ["a", "b", "c", "d"].map((id) => task(id, id));
    expect(weekLines(many, [], false, 2).lines).toHaveLength(2);
    expect(weekLines(many, [], false, 2).rest).toBe(2);
    expect(weekLines(many, [], false, 4).rest).toBe(0);
    expect(weekLines(many, [], false, 9).rest).toBe(0);
  });

  it("空的一天：一条不列、rest 也是 0", () => {
    expect(weekLines([], [], false, 2)).toEqual({ lines: [], rest: 0 });
  });

  it("🔴 「+N」不许漏条：四条子任务同一天勾完，行里放得下两条，剩下两条必须挂出来", () => {
    // 这一条钉的是复核抓到的真事故：最初那版把做完的按件去重，四条子任务缩成一行、
    // 被吞掉的三条既不列也不算进 rest，屏幕上写着一条、没有「+N」，点进去清单里躺着四条。
    const t = task("t", "装修新房");
    const done = ["量尺寸", "选瓷砖", "挑灯", "订柜子"].map((n, i) => row(t, sub(`s${i}`, n)));
    const { lines, rest } = weekLines([], done, false, 2);
    expect(lines.map((l) => l.title)).toEqual(["量尺寸", "选瓷砖"]);
    expect(rest).toBe(2); // ← 去重那版这儿是 0
    expect(lines.length + rest).toBe(done.length);
  });

  it("🔴 同一屏三处对得上：行里两个数之和 = 列出来的 + 「+N」= 底下那份清单的行数", () => {
    const t = task("t", "装修");
    const u = task("u", "报销");
    const open = [t, u];
    const done = [row(t, sub("s1", "量尺寸")), row(t, sub("s2", "选瓷砖")), row(u)];
    const { lines, rest } = weekLines(open, done, false, 2);
    // 行里画的是 open.length 和 done.length 这两个数（见 Calendar.tsx 的 doneN）；
    // 底下那块「这一天」列的是 open 每条一行 + done 每条一行，正好也是这个和
    expect(open.length + done.length).toBe(5);
    expect(lines.length + rest).toBe(5);
    // 按件去重的口径在这儿是 2（装修 + 报销），拿它当右边的数就会跟清单差两条——
    // 「N 件」那个口径只留给胶囊上明写着「件」的地方
    expect(rowTaskIds(done).length).toBe(2);
  });
});

describe("② 手机周视图的源码：一天一行，日期 · 这天的事 · 数量", () => {
  const weekBranch = calendarSource.slice(
    calendarSource.indexOf('if (mode === "week") {\n                const { lines, rest }'),
    calendarSource.indexOf("const dots = dayDots("),
  );

  it("这一支确实存在，而且走的是 weekLines", () => {
    expect(weekBranch.length).toBeGreaterThan(200);
    expect(weekBranch).toContain("weekLines(open, done, late, MAX_WEEK_LINES)");
    expect(calendarSource).toContain("const MAX_WEEK_LINES = 2;");
  });

  it("一行三段：左边日期（几号 + 周几，今天高亮）、中间事情的名字、右边数量", () => {
    expect(weekBranch).toContain('<span className="cal-wdate">');
    expect(weekBranch).toContain('className={`cal-num${ymd === today ? " today" : ""}`}');
    expect(weekBranch).toContain('<span className="cal-wd">周{WEEK_HEAD[(dayOfWeek(ymd) + 6) % 7]}</span>');
    expect(weekBranch).toContain('<span className="cal-wpeek">');
    expect(weekBranch).toContain('<span className="cal-wtitle">');
    expect(weekBranch).toContain('<span className="cal-wn">');
  });

  it("放不下的条数挂「+N」，挂在最后一行末尾（另起一行会把钉死的行高撑破）", () => {
    expect(weekBranch).toContain('{i === lines.length - 1 && rest > 0 && <span className="cal-wmore">+{rest}</span>}');
  });

  it("待办 / 已完成分得出来：每行一颗点跟着 kind 走，右边两个数各自一颗点", () => {
    expect(weekBranch).toContain('<i className={`cal-dot ${l.kind}`} />');
    expect(weekBranch).toContain('className={`cal-wline${l.kind === "ok" ? " done" : ""}`}');
    expect(weekBranch).toContain('<i className={`cal-dot ${late ? "late" : "plan"}`} />');
    expect(weekBranch).toContain('<i className="cal-dot ok" />');
    // 数行不按件去重：跟 weekLines 列出来的、跟底下那块清单的行数，三处一个口径
    expect(weekBranch).toContain("const doneN = done.length;");
    expect(weekBranch).not.toContain("rowTaskIds");
    expect(weekBranch).toContain("{open.length}");
  });

  it("点一行 = 切到这一天，跟月视图点一格一样；选中的那行自己有个样子", () => {
    expect(weekBranch).toContain("onClick={() => setPicked(ymd)}");
    expect(weekBranch).toContain('${shownDay === ymd ? " cal-picked" : ""}');
  });

  it("周视图这一支不画点阵、不画条目、不画补记框、不拖放", () => {
    for (const s of ["cal-dots", "cal-task", "cal-quick", "draggable", "onDragOver", "onDoubleClick"]) {
      expect(stripComments(weekBranch), s).not.toContain(s);
    }
  });

  it("界面文案讲人话，没有工程词，也没有那个已经退场的词", () => {
    const src = stripComments(weekBranch);
    expect(src).not.toContain("随手记");
    expect(src).not.toContain("item");
    expect(src).not.toContain("Event");
  });
});

describe("③ 周视图那一行怎么摆（样式，全在 .mshell 里）", () => {
  it("行高钉死 60px：七行一模一样高，一眼比得出哪天最满", () => {
    const cell = weekCss.slice(weekCss.indexOf(".mshell .cal-grid.week .cal-wrow {"));
    const body = cell.slice(0, cell.indexOf("}"));
    expect(body).toContain("flex-flow: row nowrap;");
    expect(body).toContain("align-items: center;");
  });

  it("🔴 「七列拍成七行」写在 .mshell 自己这儿，不蹭那段 760px 的媒体查询", () => {
    // 手机一转横屏视口就是 892px，媒体查询整段失效。只留 grid-auto-rows: 60px 的话，
    // 竖排列表当场散成七根 60px 高的挤压柱子（标题只剩「装·」一个字加省略号）
    expect(weekCss).toContain(
      ".mshell .cal-grid.week { padding: 6px 4px; grid-template-columns: 1fr; grid-auto-rows: 60px; }",
    );
    // 「一二三四五六日」那排列头跟竖排的一天一行对不上，横屏下也得关掉
    expect(weekCss).toContain(".mshell .cal-body.cal-week-mode .cal-week { display: none; }");
    // 同一个道理：能滚这件事也不能只写在媒体查询里，否则横屏下七行里后四行滚都滚不到。
    // 两条缺一不可——外面能滚，网格自己还得按内容定高，不然它被 flex 压回可视高度自己裁掉
    expect(mshellPart).toContain(".mshell .view-body.cal-body { overflow-y: auto; }");
    const grid = mshellPart.slice(mshellPart.indexOf(".mshell .cal-grid {"));
    expect(grid.slice(0, grid.indexOf("}"))).toContain("flex: none;");
  });

  it("🔴 .cal-wrow 不是个摆设：TSX 挂了它，行内那套摆法就真写在它身上", () => {
    expect(stripComments(calendarSource)).toContain("cal-cell cal-wrow");
    expect(weekCss).toContain(".mshell .cal-grid.week .cal-wrow {");
    expect(weekCss).toContain(".mshell .cal-grid.week .cal-wrow + .cal-wrow { border-top: 1px solid var(--m-sep); }");
  });

  it("左边日期那一柱固定 30px，几号在上周几在下——七行的日期对得成一条竖线", () => {
    const date = weekCss.slice(weekCss.indexOf(".mshell .cal-wdate {"));
    const body = date.slice(0, date.indexOf("}"));
    expect(body).toContain("flex: none; width: 30px;");
    expect(body).toContain("flex-direction: column;");
  });

  it("🔴 标题放不下就一行省略号，绝不把行撑宽（横向溢出是这一路最要命的回归）", () => {
    const title = weekCss.slice(weekCss.indexOf(".mshell .cal-wtitle {"));
    const body = title.slice(0, title.indexOf("}"));
    expect(body).toContain("min-width: 0;");
    expect(body).toContain("overflow: hidden;");
    expect(body).toContain("text-overflow: ellipsis;");
    expect(body).toContain("white-space: nowrap;");
    // 中间那栏也得能被压缩，否则挤的是右边的数字
    const peek = weekCss.slice(weekCss.indexOf(".mshell .cal-wpeek {"));
    expect(peek.slice(0, peek.indexOf("}"))).toContain("min-width: 0;");
  });

  it("做完那行压淡 + 划掉，跟「已完成」列表一个口径", () => {
    expect(weekCss).toContain(".mshell .cal-wline.done { color: var(--ink-3); }");
    expect(weekCss).toContain(".mshell .cal-wline.done .cal-wtitle { text-decoration: line-through; }");
  });

  it("点开的那行整行淡底 + 左边一道竖杠；今天那颗实心圆不许被盖掉", () => {
    const picked = weekCss.slice(weekCss.indexOf(".mshell .cal-grid.week .cal-wrow.cal-picked {"));
    const body = picked.slice(0, picked.indexOf("}"));
    expect(body).toContain("background: var(--accent-soft);");
    expect(body).toContain("box-shadow: inset 3px 0 0 var(--accent);");
    // :not(.today) 是关键：不写它，今天又正好被点开时那颗实心圆就没了
    expect(weekCss).toContain(".mshell .cal-grid.week .cal-wrow.cal-picked .cal-num:not(.today) {");
  });

  it("三种点的颜色一个字没改（已完成那颗还是压淡的同色系）", () => {
    expect(mshellPart).toContain(".mshell .cal-dot.plan { background: var(--accent); }");
    expect(mshellPart).toContain(".mshell .cal-dot.late { background: var(--warn); }");
    expect(mshellPart).toContain(".mshell .cal-dot.ok { background: var(--ok); opacity: .45; }");
  });

  it("这一小节里颜色全是 token、时长全是变量、每一条都挂在 .mshell 下面", () => {
    const code = stripComments(weekCss);
    expect(code).not.toMatch(/#[0-9A-Fa-f]{3,8}\b/);
    expect(code).not.toMatch(/\b(rgb|hsl)a?\(/);
    for (const line of code.split(/\r?\n/).filter((l: string) => /\b(transition|animation):/.test(l))) {
      expect(line, line.trim()).toMatch(/var\(--dur-[12]\)/);
    }
    for (const line of code.split(/\r?\n/).filter((l: string) => /^\./.test(l))) {
      expect(line, line.trim()).toMatch(/^\.mshell /);
    }
  });
});

describe("④ 桌面的日历一个像素没动", () => {
  it("桌面周视图那两条原样还在", () => {
    expect(beforeMshell).toContain(".cal-grid.week .cal-cell { padding: 8px 9px; }");
    expect(beforeMshell).toContain(".cal-grid.week .cal-num { font-size: 15px; }");
  });

  it("窄屏那段媒体查询（窄桌面也吃）原样还在", () => {
    expect(beforeMshell).toContain(".cal-grid.week { grid-template-columns: 1fr; grid-auto-rows: min-content; }");
    expect(beforeMshell).toContain(".cal-grid.week .cal-head { flex: none; gap: 7px; justify-content: flex-start; }");
    expect(beforeMshell).toContain(".cal-grid.week .cal-quick { flex: 1 0 100%; }");
    expect(beforeMshell).toContain(".cal-grid.week .cal-wd { display: inline; font-size: var(--fs-xs); color: var(--ink-3); }");
  });

  it("🔴 新写的那几个类名一个都没漏进桌面那一段", () => {
    for (const s of ["cal-wrow", "cal-wdate", "cal-wpeek", "cal-wtitle", "cal-wline", "cal-wmore", "cal-wnum"]) {
      expect(beforeMshell, s).not.toContain(s);
    }
  });

  it("🔴 Calendar.tsx 的桌面分支照旧：条目 / 补记框 / 拖放 / 「+N」全在，周视图那套没漏进去", () => {
    const desk = calendarSource.slice(calendarSource.indexOf("return (\n              <div\n                key={ymd}"));
    for (const s of ['<div className="cal-head">', 'className="cal-task"', 'className="cal-quick"', "draggable", "onDrop={(e) => onDrop(e, ymd)}", 'className="cal-more"']) {
      expect(desk, s).toContain(s);
    }
    for (const s of ["cal-wpeek", "cal-wtitle", "cal-wn", "weekLines("]) {
      expect(desk, s).not.toContain(s);
    }
  });
});

describe("⑤ 底下那块完整清单：周视图也留着，跟行里的预览不是两份一样的东西", () => {
  const list = calendarSource.slice(
    calendarSource.indexOf("{isMobile &&\n          (() => {"),
    calendarSource.indexOf("{!isMobile && picked && ("),
  );

  it("常驻列表没有按月/周分叉，点哪天就列哪天——周视图点一行同样切过去", () => {
    expect(list).toContain("const day = picked ?? today;");
    expect(list).toContain('<div className="cal-daylist">');
    expect(list).toContain("<MobileRow key={t.id} task={t} />");
    // 这块不看 mode：切到周视图不该让它消失，也不该另写一份
    expect(stripComments(list)).not.toContain("mode");
  });

  it("行里只是预览（最多两条 + 「+N」），完整的能点能滑的清单只有底下那一份", () => {
    expect(calendarSource).toContain("const MAX_WEEK_LINES = 2;");
    // 周视图那一支不许自己再渲染一遍 MobileRow
    const weekBranch = calendarSource.slice(
      calendarSource.indexOf('if (mode === "week") {\n                const { lines, rest }'),
      calendarSource.indexOf("const dots = dayDots("),
    );
    expect(weekBranch).not.toContain("MobileRow");
    expect(weekBranch).not.toContain("cal-daylist");
  });
});
