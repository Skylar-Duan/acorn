// v1.9.1 · 任务行的右侧区间：不越界、只留完成日期、全部对齐。
//
// 用户的三条原话：
//   ①「已完成界面右侧太乱，只留下完成日期，不是 ddl 日期，其他的展开自然能看到」
//   ②「如果长度过长，点开后能够多行显示，但是不点开不要超出到右侧区间范围，
//      能够显示 ddl 和重要性，归类、@ 统一都隐藏」
//   ③「完成于 昨天，并且前面的已完成全部对齐……正好划定右侧区间那条线，超出一年的显示年份就好」
//
// 病根只有一个，而且是**一行 CSS**：.row-slot > .task-row 只写了 min-height: 0，没写 min-width: 0。
// .task-row 是 grid item，默认 min-width: auto，整行不能收缩到 min-content 以下，
// 于是 .title 上那条早就写好的 text-overflow: ellipsis 从来没生效过——
// 长标题不是缩短加省略号，而是整行往右溢出，再被 .view-body 的 overflow-x: hidden 一刀切掉。
// 实测 980 视口下长标题那行右缘 1261 vs 视口 950，溢出 311px，整个右侧信息区全看不见。
// 这一行没了，下面所有关于「右侧区间」的东西全是白做的，所以第一组就钉它。
//
// 样式只能用 node:fs 读：vitest 默认不处理 CSS，`import x from "a.css?raw"` 读回来是空串，
// 那样断言会变成对着空字符串「全过」。类型见 tests/node-fs.d.ts。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { formatDoneShort, doneShortIsWide, formatShort } from "../src/core/dates";
import taskRowSource from "../src/components/TaskRow.tsx?raw";
import doneViewSource from "../src/views/Done.tsx?raw";
import todayViewSource from "../src/views/Today.tsx?raw";
import listViewSource from "../src/views/ListView.tsx?raw";

const appCss = readFileSync("src/styles/app.css", "utf8");

/** 取某条选择器那一段声明体（到第一个 } 为止） */
function block(css: string, selector: string): string {
  const i = css.indexOf(selector);
  expect(i, `找不到选择器：${selector}`).toBeGreaterThan(-1);
  const rest = css.slice(i);
  return rest.slice(0, rest.indexOf("}"));
}

describe("根因：行必须能收缩到 min-content 以下，标题才轮得到省略号", () => {
  it(".row-slot > .task-row 两个方向都写了（min-height 只管住了一半）", () => {
    const body = block(appCss, "\n.row-slot > .task-row {");
    expect(body).toContain("min-height: 0;");
    expect(body).toContain("min-width: 0;");
  });

  it("标题那条 ellipsis 规则原样还在——它一直是对的，只是从前没机会生效", () => {
    expect(appCss).toContain(
      ".task-row .title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
    );
  });

  it("手机断点里标题的 flex-basis 仍是 0（写 auto 会把长标题整条挤到下一行）", () => {
    expect(appCss).toContain(".task-row .title { flex: 1 1 0; min-width: 0; }");
  });
});

describe("右侧那条线：定宽只许挂在日期那一格上", () => {
  it("「完成于 X月X日」的固定右列是 88px、**左对齐**（对齐的是起笔，不是右缘）", () => {
    const body = block(appCss, ".task-row .meta .when {");
    expect(body).toContain("width: 88px;");
    expect(body).toContain("text-align: left;");
    expect(body).toContain("flex: none;");
  });

  it("超过一年那一档单独放宽，不把整列按最宽的那种写法划", () => {
    expect(appCss).toContain(".task-row .meta .when.wide { width: auto; }");
  });

  it("🔴 .task-row .meta 自己一个字的宽度都不许写死", () => {
    // ListView 那个手搓的回收站行共用 .meta，里面装的是「还剩 N 天」+ 恢复 + 彻底删除两个按钮。
    // 定宽写到 .meta 上会当场把那一行挤烂——这是这一轮最容易漏的联动处
    const body = block(appCss, ".task-row .meta {");
    expect(body).not.toMatch(/(^|[^-])width:/);
    // 回收站行确实还共用着 .meta 和那两个按钮（哪天它自己搬走了，上面这条才可以松）
    expect(listViewSource).toContain('<div key={t.id} className="task-row">');
    expect(listViewSource).toContain("彻底删除");
  });

  it("手机断点把定宽收回去：那儿 meta 已经换行到第二行、整块左对齐了", () => {
    const mobile = appCss.slice(appCss.indexOf("@media (max-width: 760px)"));
    expect(mobile).toContain(".task-row .meta .when { width: auto; }");
  });
});

describe("formatDoneShort：跟 formatShort 分家，别顺手去改那一个", () => {
  const now = new Date(2026, 8, 1); // 2026-09-01

  it("今天 / 昨天 / 月日 三档", () => {
    expect(formatDoneShort("2026-09-01", now)).toBe("今天");
    expect(formatDoneShort("2026-08-31", now)).toBe("昨天");
    expect(formatDoneShort("2026-08-28", now)).toBe("8月28日");
  });

  it("不认「明天 / 后天」——收场的日子不可能在未来，写「完成于 后天」是句胡话", () => {
    expect(formatDoneShort("2026-09-02", now)).toBe("9月2日");
    expect(formatShort("2026-09-02", now)).toBe("明天"); // formatShort 那边照旧
  });

  it("超过一年才带年份，而且只写两位（四位年塞不进 88px 那一格）", () => {
    expect(formatDoneShort("2025-08-31", now)).toBe("25年8月31日");
    expect(doneShortIsWide("2025-08-31", now)).toBe(true);
  });

  it("整一年那天还算「一年之内」，再早一天才带年份", () => {
    expect(formatDoneShort("2025-09-01", now)).toBe("9月1日");
    expect(doneShortIsWide("2025-09-01", now)).toBe(false);
    expect(doneShortIsWide("2025-08-31", now)).toBe(true);
  });

  it("跨年边界：1月2日回头看去年 12月31日，写月日不写年", () => {
    // 这正是两套口径打架的地方。formatShort 的规矩是「**不是今年**就带年份」，
    // 它会写成「2025年12月31日」——实测 122px，塞不进为「完成于 12月28日」划的那条 88px 线。
    // 用户要的是「**超出一年**才显示年份」，两天前做完的事没道理挂个年份
    const jan2 = new Date(2026, 0, 2);
    expect(formatDoneShort("2025-12-31", jan2)).toBe("12月31日");
    expect(doneShortIsWide("2025-12-31", jan2)).toBe(false);
    expect(formatShort("2025-12-31", jan2)).toBe("2025年12月31日");
  });

  it("formatShort 的老规矩一个字没动（它有 8 处调用共用）", () => {
    // 语法高亮 chip、任务卡的日期按钮 ×2、快捷记、搜索、四象限、任务行 ×2
    expect(formatShort("2026-09-01", now)).toBe("今天");
    expect(formatShort("2026-09-03", now)).toBe("后天");
    expect(formatShort("2026-08-31", now)).toBe("昨天");
    expect(formatShort("2026-08-28", now)).toBe("8月28日");
    expect(formatShort("2025-12-28", now)).toBe("2025年12月28日");
  });
});

describe("行尾画多少：tail 开关（归类 / @ / 标签统一隐藏）", () => {
  it("默认就是 lean —— 全局口径，不是某个视图开的特例", () => {
    expect(taskRowSource).toContain('tail = "lean"');
    expect(taskRowSource).toContain('const leanTail = tail !== "full";');
    expect(taskRowSource).toContain('const dateOnlyTail = tail === "date";');
  });

  it("清单色点 / 需求方徽标 / #标签 三样都挂在 leanTail 上", () => {
    expect(taskRowSource).toContain("{!leanTail && !bundled && task.who.map(");
    expect(taskRowSource).toContain("{!leanTail && !sub && task.tags.map(");
    expect(taskRowSource).toContain("{!leanTail && !hideList && !bundled && list && (");
  });

  it("重要性小旗留着（用户点名要「显示 ddl 和重要性」），它本来也不在 meta 里", () => {
    expect(taskRowSource).toContain('<span className={`flag p${priority}`}');
  });

  it("「已放弃」那个灰标签也留着——它是标题旁边的一句说明，不是右侧信息", () => {
    expect(taskRowSource).toContain('className="drop-tag"');
  });

  it('tail="full" 这条退路留着，不是把代码删了', () => {
    expect(taskRowSource).toContain('"full" | "lean" | "date"');
  });
});

describe("已完成视图：右边只剩一格「完成于 X」", () => {
  it("文案是「完成于 / 放弃于」，放弃的那行绝不写成「完成」", () => {
    expect(taskRowSource).toContain('{isDropped ? "放弃于" : "完成于"} {formatDoneShort(doneDate)}');
  });

  it("日期那个 span 带 .when，超一年的加 .wide", () => {
    expect(taskRowSource).toContain('className={`when${doneShortIsWide(doneDate) ? " wide" : ""}`}');
  });

  it("tail=date 时连截止日期都不画（完成日是猜的那几条宁可空着）", () => {
    expect(taskRowSource).toContain("!dateOnlyTail && due && (");
  });

  it("进度 N/M、循环 ↻、顺延 三样在 tail=date 下都收起来", () => {
    expect(taskRowSource).toContain("{!dateOnlyTail && !sub && counted.length > 0 && (");
    expect(taskRowSource).toContain("{!dateOnlyTail && !sub && task.repeat &&");
    expect(taskRowSource).toContain("{!dateOnlyTail && !sub && task.postponeCount >= 2 && !settled && (");
  });

  it("顺带修的那个 bug：顺延徽标的判据是「未了结」不是「未完成」", () => {
    // 放弃掉的那件事 done 一直是 false，按老写法 `!task.done`，
    // 「顺延×4」会跟着它一起站在「已完成」视图里
    expect(taskRowSource).toContain("const settled = task.done || !!task.droppedAt;");
    expect(taskRowSource).not.toContain("task.postponeCount >= 2 && !task.done");
  });

  it("Done 视图传 tail=date", () => {
    expect(doneViewSource).toContain('tail="date"');
  });

  it("今天视图的「已完成 N」那组跟它同一个口径（以前那儿写的还是截止日期）", () => {
    const donePart = todayViewSource.slice(todayViewSource.indexOf("doneToday.map("));
    expect(donePart).toContain("doneDate={today}");
    expect(donePart).toContain('tail="date"');
  });
});

describe("已完成视图点开：走 CardSlot，不再拿卡片顶掉那一行", () => {
  it("行和卡同时挂着（行收成 0 高），收/放都有动画", () => {
    expect(doneViewSource).toContain("<CardSlot");
    expect(doneViewSource).toContain("collapsed={expanded}");
    // 旧写法是 anchor 命中就直接 return 一张 TaskCard，把那一行整个换掉
    expect(doneViewSource).not.toContain("if (anchor === key) {");
  });

  it("🔴 卡片仍然按**任务 id** 认 key：一件事在这个视图里可能占好几行", () => {
    expect(doneViewSource).toContain("key={`card:${x.row.task.id}`}");
    expect(doneViewSource).toContain("key={`row:${key}`}");
    // 行和卡的 key 必须岔开：母任务行的 rowKey 就等于任务 id，不加前缀会撞
    expect(doneViewSource).toContain("flatMap(renderRow)");
  });

  it("cardAnchor 整页算一次的语义没被破坏（否则一件事会冒出两张卡）", () => {
    expect(doneViewSource).toContain("const anchor = cardAnchor(shown.map((x) => x.row), expandedId);");
  });
});

describe("点开后多行：卡里的三个框都换成了自动撑高的 textarea", () => {
  const taskCardSource = readFileSync("src/components/TaskCard.tsx", "utf8");
  const syntaxInputSource = readFileSync("src/components/SyntaxInput.tsx", "utf8");

  it("标题：textarea + rows=1 + growArea，titleRef 的类型跟着换", () => {
    expect(taskCardSource).toContain("const titleRef = useRef<HTMLTextAreaElement>(null);");
    // 标题那个框的开标签就在 ref={titleRef} 前面几个字符处
    const head = taskCardSource.slice(0, taskCardSource.indexOf("ref={titleRef}"));
    expect(head.slice(-40)).toContain("<textarea");
    expect(taskCardSource).toContain("growArea(titleRef.current);");
  });

  it("⚠️ Enter→跳备注 / Shift+Enter→收卡 这套约定原样保住（textarea 里 Enter 默认是换行）", () => {
    const title = taskCardSource.slice(taskCardSource.indexOf("ref={titleRef}"));
    const body = title.slice(0, title.indexOf("<CommitMark"));
    expect(body).toContain("e.preventDefault();");
    expect(body).toContain("if (e.shiftKey) expandTask(null);");
    expect(body).toContain("else notesRef.current?.focus();");
  });

  it("粘贴进来的换行当空格吃掉（标题是一行字段，input 那边是浏览器替我们吃的）", () => {
    expect(taskCardSource).toContain("oneLine(e.target.value)");
  });

  it("子任务标题一起做了多行", () => {
    expect(taskCardSource).toContain("ref={growArea}");
    expect(taskCardSource).toContain("updateSubtask(task.id, s.id, { title: oneLine(e.target.value) });");
  });

  it("「整句改」也一起做了，而且**只有它**开 multiline", () => {
    expect(taskCardSource).toContain("multiline");
    expect(syntaxInputSource).toContain("multiline = false");
    // 随手记那条横条、快捷记那个固定大小的浮窗都没开：那两处长高了会把宿主的版式顶变形。
    // 认的是「单独一行的 multiline 这个 prop」，注释里提到这个词不算
    expect(readFileSync("src/components/QuickAddBar.tsx", "utf8")).not.toMatch(/^\s*multiline\s*$/m);
    expect(readFileSync("src/windows/quickadd.tsx", "utf8")).not.toMatch(/^\s*multiline\s*$/m);
    expect(taskCardSource).toMatch(/^\s*multiline\s*$/m);
  });

  it("整句改那个框里回车还是「提交」不是「换行」", () => {
    const key = syntaxInputSource.slice(syntaxInputSource.indexOf('if (e.key === "Enter") {'));
    const body = key.slice(0, key.indexOf("submit(parsed);"));
    expect(body).toContain("e.preventDefault();");
  });

  it("⚠️ .row1 的样式选择器连 textarea 一起写了（只写 input 会把字号字重全丢掉）", () => {
    expect(appCss).toContain(".task-card .row1 input,");
    expect(appCss).toContain(".task-card .row1 textarea {");
    expect(appCss).toContain(".task-card .row1 textarea.dropped");
    expect(appCss).toContain(".task-card .subs .sub-row textarea {");
  });

  it("多行之后 .row1 / .sub-row / .tc-sentence 都改成顶部对齐", () => {
    expect(block(appCss, ".task-card .row1 {")).toContain("align-items: flex-start;");
    expect(block(appCss, ".task-card .subs .sub-row {")).toContain("align-items: flex-start;");
    expect(block(appCss, ".tc-sentence {")).toContain("align-items: flex-start;");
  });
});
